/**
 * Minimal Grok ACP v1 adapter over the same shared line transport as Codex.
 * No CLI version probing, shell parsing, session resume or generic RPC surface.
 */
import { randomUUID } from 'node:crypto'
                                                     
                                                        
                                                               
import { JsonRpcLineTransport } from '@deepseek-ai/dsh-sdk-protocol'

                                         

                                       
                          
                                                                                           
 

function object(value         , label        )             {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`subagent-grok: invalid ${label}`)
  }
  return value              
}

function textId(value         )         {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('subagent-grok: invalid session identity')
  }
  return value
}

function asError(value         )        {
  return value instanceof Error ? value : new Error('subagent-grok: protocol failure')
}

async function raceAbort   (pending            , signal             )             {
  if (signal.aborted) {
    void pending.catch(() => {})
    throw new Error('subagent-grok: operation cancelled')
  }
  const cancelled = Promise.withResolvers       ()
  const onAbort = ()       => { cancelled.reject(new Error('subagent-grok: operation cancelled')) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export class GrokAcpWire {
                   input          
                   transport                      
                   fatal = Promise.withResolvers       ()
                   ownedIds = new Set        ()
          sessionId                    
          sessionCreation                           
          sessionReady = false
          promptStarted = false
          terminalObserved = false
          inputEnded = false
          closed = false
          cancelling = false
          collecting = true
          currentText           = []
          lastAnswer                    
          diagnostic                    
          failure                       = { stage: 'prompt', category: 'unknown' }

  constructor(input          , output          ) {
    this.input = input
    this.transport = new JsonRpcLineTransport(input, output)
    void this.fatal.promise.catch(() => {})
    this.transport.onRequest((method, params) => this.handleRequest(method, params))
    this.transport.onNotification((method, params) => {
      try {
        this.handleNotification(method, params)
      } catch (error         ) {
        this.failure = { stage: 'prompt', category: 'invalid-result' }
        this.fatal.reject(asError(error))
      }
    })
    input.on('error', this.onStreamError)
    input.on('end', this.onInputEnd)
    // Keep error listeners through disposal: late EPIPE must stay observed.
    output.on('error', this.onStreamError)
  }

  start()       { this.transport.start() }

  async initialize(signal             )                {
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

  async startSession(cwd        , signal             )                {
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
  async drainSessionCreation(signal             )                {
    if (this.sessionCreation !== undefined) await raceAbort(this.sessionCreation, signal)
  }

  ownedSessionIds()                    { return [...this.ownedIds] }

  async runTurn(texts                   , signal             )                          {
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

  interrupt()       {
    this.cancelling = true
    if (!this.sessionReady || !this.promptStarted || this.terminalObserved || this.closed) return
    try {
      this.transport.notify('session/cancel', { sessionId: this.sessionId })
      void this.transport.flush().catch(() => {})
    } catch {
      // Local cancellation and managed-process teardown remain authoritative.
    }
  }

  freezeOutput()       { this.collecting = false }

  collectOutput()                 {
    const current = this.currentText.join('')
    const text = current.trim() ? current : this.lastAnswer
    return text !== undefined && text.trim() ? [{ type: 'text', text }] : []
  }

  collectDiagnostic()                     { return this.diagnostic }
  collectFailure()                       { return this.failure }
  endedBeforeTerminal()          { return this.inputEnded && !this.terminalObserved }

  /**
   * Grok's native deletion handles actor draining, persistent history and its
   * index. Extensions have an underscore on the ACP JSON-RPC wire.
   * This path deliberately does not race the failed prompt's fatal promise.
   */
  async deleteSession(id        , cwd        , signal             )                {
    this.cancelling = true
    const response = object(await this.transport.request('_x.ai/session/delete', {
      sessionId: id,
      cwd,
    }, signal), 'session delete response')
    if (response.success !== true) {
      throw new Error('subagent-grok: session deletion was not acknowledged')
    }
  }

  close()       {
    if (this.closed) return
    this.closed = true
    this.input.off('end', this.onInputEnd)
    this.transport.close()
  }

          async guarded   (pending            , signal             )             {
    return raceAbort(Promise.race([pending, this.fatal.promise]), signal)
  }

                   onStreamError = (error       )       => {
    this.failure = { stage: 'prompt', category: 'transport' }
    this.fatal.reject(error)
  }

                   onInputEnd = ()       => {
    this.inputEnded = true
    this.onStreamError(new Error('subagent-grok: protocol stream closed'))
  }

          boundary()       {
    const text = this.currentText.join('')
    if (text.trim()) this.lastAnswer = text
    this.currentText = []
  }

          async handleRequest(method        , params            )                   {
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
    } catch (error         ) {
      this.fatal.reject(asError(error))
      throw error
    }
  }

          handleNotification(method        , params            )       {
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
