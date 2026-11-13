/**
 * Minimal Grok ACP v1 adapter over the same shared line transport as Codex.
 * No CLI version probing, shell parsing, session resume or generic RPC surface.
 */
import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

type JsonObject = Record<string, unknown>

export interface GrokWireFailureFacts {
  readonly stage: 'prompt'
  readonly category: 'limit' | 'access-policy' | 'transport' | 'invalid-result' | 'unknown'
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-grok: invalid ${label}`)
  }
  return value as JsonObject
}

function textId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('subagent-grok: invalid session identity')
  }
  return value
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error('subagent-grok: protocol failure')
}

async function raceAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw new Error('subagent-grok: operation cancelled')
  }
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => { cancelled.reject(new Error('subagent-grok: operation cancelled')) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export class GrokAcpWire {
  private readonly input: Readable
  private readonly transport: JsonRpcLineTransport
  private readonly fatal = Promise.withResolvers<never>()
  private readonly ownedIds = new Set<string>()
  private sessionId: string | undefined
  private sessionCreation: Promise<void> | undefined
  private sessionReady = false
  private promptStarted = false
  private terminalObserved = false
  private inputEnded = false
  private closed = false
  private cancelling = false
  private collecting = true
  private currentText: string[] = []
  private lastAnswer: string | undefined
  private diagnostic: string | undefined
  private failure: GrokWireFailureFacts = { stage: 'prompt', category: 'unknown' }

  constructor(input: Readable, output: Writable) {
    this.input = input
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error: unknown) {
        this.failure = { stage: 'prompt', category: 'invalid-result' }
        this.fatal.reject(asError(error))
      }
    })
    input.on('error', this.onStreamError)
    input.on('end', this.onInputEnd)
    // Keep error listeners through disposal: late EPIPE must stay observed.
    output.on('error', this.onStreamError)
  }

  start(): void { this.transport.start() }

  async initialize(signal: AbortSignal): Promise<void> {
    const response = object(await this.guarded(this.transport.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-subagent-grok', version: '0.1.0' },
      // Grok executes its own filesystem/terminal tools in the native process.
      clientCapabilities: {},
    }, signal), signal), 'initialize response')
    if (response.protocolVersion !== 1) {
      throw new Error('subagent-grok: unsupported negotiated ACP protocol')
    }
  }

  async startSession(cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.sessionCreation !== undefined) throw new Error('subagent-grok: session already requested')
    const requestedId = randomUUID()
    this.sessionId = requestedId
    this.ownedIds.add(requestedId)
    // Keep correlation alive after caller cancellation. Cleanup drains this
    // request before deleting, so a late session/new cannot recreate history.
    this.sessionCreation = this.transport.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: { sessionId: requestedId, yoloMode: true },
    }).then(value => {
      const response = object(value, 'session/new response')
      const id = textId(response.sessionId)
      // Both identities originate from this connection's single create.
      // No identity learned from arbitrary notifications is ever deleted.
      this.ownedIds.add(id)
      this.sessionId = id
      this.sessionReady = true
    })
    void this.sessionCreation.catch(() => {})
    await this.guarded(this.sessionCreation, signal)
  }

  /** Settle session creation before deletion, including cancelled startup. */
  async drainSessionCreation(signal: AbortSignal): Promise<void> {
    if (this.sessionCreation !== undefined) await raceAbort(this.sessionCreation, signal)
  }

  ownedSessionIds(): readonly string[] { return [...this.ownedIds] }

  async runTurn(texts: readonly string[], signal: AbortSignal): Promise<SubagentResult> {
    if (!this.sessionReady || this.promptStarted) {
      throw new Error('subagent-grok: invalid single-turn state')
    }
    this.promptStarted = true
    const response = object(await this.guarded(this.transport.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: texts.map(text => ({ type: 'text', text })),
    }, signal), signal), 'session/prompt response')
    // Only this request response ends the prompt; prompt_complete extensions
    // may precede trailing chunks and are deliberately not terminal authority.
    this.terminalObserved = true
    this.collecting = false
    const output = this.collectOutput()
    switch (response.stopReason) {
      case 'end_turn':
        if (output.length === 0) {
          this.failure = { stage: 'prompt', category: 'invalid-result' }
          throw new Error('subagent-grok: completed without an answer')
        }
        return { output, stopReason: 'completed' }
      case 'cancelled':
        return { output, stopReason: 'aborted' }
      case 'max_tokens':
        this.failure = { stage: 'prompt', category: 'limit' }
        return { output, stopReason: 'max-tokens' }
      case 'refusal':
        this.failure = { stage: 'prompt', category: 'access-policy' }
        return { output, stopReason: 'refusal' }
      case 'max_turn_requests':
        this.failure = { stage: 'prompt', category: 'limit' }
        return { output, stopReason: 'error' }
      default:
        this.failure = { stage: 'prompt', category: 'invalid-result' }
        throw new Error('subagent-grok: unknown terminal stop reason')
    }
  }

  interrupt(): void {
    this.cancelling = true
    if (!this.sessionReady || !this.promptStarted || this.terminalObserved || this.closed) return
    try {
      this.transport.notify('session/cancel', { sessionId: this.sessionId })
      void this.transport.flush().catch(() => {})
    } catch {
      // Local cancellation and managed-process teardown remain authoritative.
    }
  }

  freezeOutput(): void { this.collecting = false }

  collectOutput(): ContentBlock[] {
    const current = this.currentText.join('')
    const text = current.trim() ? current : this.lastAnswer
    return text !== undefined && text.trim() ? [{ type: 'text', text }] : []
  }

  collectDiagnostic(): string | undefined { return this.diagnostic }
  collectFailure(): GrokWireFailureFacts { return this.failure }
  endedBeforeTerminal(): boolean { return this.inputEnded && !this.terminalObserved }

  /**
   * Grok's native deletion handles actor draining, persistent history and its
   * index. Extensions have an underscore on the ACP JSON-RPC wire.
   * This path deliberately does not race the failed prompt's fatal promise.
   */
  async deleteSession(id: string, cwd: string, signal: AbortSignal): Promise<void> {
    this.cancelling = true
    const response = object(await this.transport.request('_x.ai/session/delete', {
      sessionId: id,
      cwd,
    }, signal), 'session delete response')
    if (response.success !== true) {
      throw new Error('subagent-grok: session deletion was not acknowledged')
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

  private async guarded<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
    return raceAbort(Promise.race([pending, this.fatal.promise]), signal)
  }

  private readonly onStreamError = (error: Error): void => {
    this.failure = { stage: 'prompt', category: 'transport' }
    this.fatal.reject(error)
  }

  private readonly onInputEnd = (): void => {
    this.inputEnded = true
    this.onStreamError(new Error('subagent-grok: protocol stream closed'))
  }

  private boundary(): void {
    const text = this.currentText.join('')
    if (text.trim()) this.lastAnswer = text
    this.currentText = []
  }

  private async handleRequest(method: string, params: JsonObject): Promise<unknown> {
    try {
      if (method !== 'session/request_permission' || params.sessionId !== this.sessionId) {
        throw new Error('subagent-grok: unsupported or mismatched server request')
      }
      if (!Array.isArray(params.options)) {
        throw new Error('subagent-grok: invalid permission options')
      }
      const options = params.options.map(option => object(option, 'permission option'))
      // Prefer per-call approval, so automation does not persist new grants.
      const allow = options.find(option => option.kind === 'allow_once')
        ?? options.find(option => option.kind === 'allow_always')
      if (!this.cancelling && allow !== undefined && typeof allow.optionId === 'string') {
        return { outcome: { outcome: 'selected', optionId: allow.optionId } }
      }
      this.diagnostic = 'Grok unattended permission request cancelled: run stopping or no allow option.'
      return { outcome: { outcome: 'cancelled' } }
    } catch (error: unknown) {
      this.fatal.reject(asError(error))
      throw error
    }
  }

  private handleNotification(method: string, params: JsonObject): void {
    if (!this.collecting || !this.promptStarted || params.sessionId !== this.sessionId) return
    if (method === 'session/update') {
      const update = object(params.update, 'session update')
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = object(update.content, 'message content')
        if (content.type !== 'text') return
        if (typeof content.text !== 'string') throw new Error('subagent-grok: invalid text chunk')
        this.currentText.push(content.text)
      } else if (update.sessionUpdate === 'tool_call') {
        // ACP backends without response markers still separate pre-tool
        // commentary from the assistant answer after the last tool call.
        this.boundary()
      }
      // Never return thoughts, tool inputs/results, plans or usage.
      return
    }
    if (method === '_x.ai/session_notification') {
      const update = object(params.update, 'Grok session notification')
      if (update.sessionUpdate === 'response_started' || update.sessionUpdate === 'response_completed') {
        // Grok emits these in-order on its chunk rail where supported.
        this.boundary()
      }
    }
  }
}
