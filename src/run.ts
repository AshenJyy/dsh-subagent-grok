/**
 * Native child lifecycle following dsh-subagent-codex: initialize before
 * publication, settle execution failures, own the whole subprocess range.
 * Grok adds native session deletion before the public result is delivered.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type SubagentResult,
  type SubagentRun,
  type SubagentStartRequest,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { GrokAcpWire, type GrokWireFailureFacts } from './wire.ts'

export const DEFAULT_DISPOSE_GRACE_MS = 3_000
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000

type FailureStage = 'initialize' | 'session-start' | 'prompt' | 'process' | 'session-delete' | 'teardown'
type FailureCategory = GrokWireFailureFacts['category'] | 'process'

interface FailureFacts {
  readonly stage: FailureStage
  readonly category: FailureCategory
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: FailureFacts): string {
  const fields = ['product: Grok', `stage: ${facts.stage}`, `category: ${facts.category}`]
  if (facts.outcome?.exitCode !== undefined && facts.outcome.exitCode !== null) {
    fields.push(`exit code: ${facts.outcome.exitCode}`)
  }
  if (facts.outcome?.signal !== undefined && facts.outcome.signal !== null) {
    fields.push(`signal: ${facts.outcome.signal}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class GrokRunFailure extends Error {
  readonly facts: FailureFacts
  constructor(facts: FailureFacts, cause?: unknown) {
    super(`subagent-grok: ${failureDiagnostic(facts)}`, cause === undefined ? undefined : { cause })
    this.name = 'GrokRunFailure'
    this.facts = facts
  }
}

export function grokStartupFailure(cause: unknown): Error {
  return new GrokRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}

/** Resolve an installed binary only; never install, download or probe a version. */
export function grokExecutable(configured?: string): string {
  if (configured !== undefined) return configured
  const native = join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
  return existsSync(native) ? native : 'grok'
}

/** Argument vector passed directly to the DSH subprocess service, without a shell. */
export function grokAgentArgv(executable: string, model?: string): string[] {
  return [
    executable,
    'agent',
    '--always-approve',
    '--no-leader',
    ...model === undefined ? [] : ['--model', model],
    'stdio',
  ]
}

export interface GrokRunSpec {
  readonly cwd: string
  readonly executable?: string
  readonly model?: string
  readonly env: Record<string, string>
  readonly disposeGraceMs: number
  readonly cleanupTimeoutMs: number
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0 || prompt.some(block => block.type !== 'text')) {
    throw new Error('subagent-grok: task must contain only text blocks')
  }
  const texts = prompt.map(block => {
    if (block.type !== 'text') throw new Error('subagent-grok: task must contain only text blocks')
    return block.text
  })
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-grok: task must not be empty')
  }
  return texts
}

interface OwnedChild {
  readonly child: SubprocessHandle
  readonly wire: GrokAcpWire
  readonly processFailure: Promise<never>
  outcome(): SubprocessOutcome | undefined
  stop(): Promise<void>
}

function spawnOwnedChild(spec: GrokRunSpec, executable: string): OwnedChild {
  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: grokAgentArgv(executable, spec.model),
      cwd: spec.cwd,
      env: spec.env,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
    })
  } catch (error: unknown) {
    throw grokStartupFailure(error)
  }

  const wire = new GrokAcpWire(
    child.stdout as NonNullable<SubprocessHandle['stdout']>,
    child.stdin as NonNullable<SubprocessHandle['stdin']>,
  )
  const onStderr = (chunk: Buffer | string): void => {
    try {
      writeFileSync(process.stderr.fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    } catch {
      // Host stderr is auxiliary, never a result or lifecycle authority.
    }
  }
  const onStderrError = (): void => {}
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)

  let outcome: SubprocessOutcome | undefined
  const processFailure = child.done.then<never>(
    async value => {
      outcome = value
      // Allow a terminal protocol response already in Node's I/O queue to win.
      await new Promise<void>(resolve => { setImmediate(resolve) })
      throw new GrokRunFailure({ stage: 'process', category: 'process', outcome: value })
    },
    (error: unknown) => {
      throw new GrokRunFailure({ stage: 'process', category: 'unknown' }, error)
    },
  )
  void processFailure.catch(() => {})

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      wire.close()
      try { child.stdin?.end() } catch { /* A concurrently closed pipe is harmless. */ }
      try {
        child.terminate()
        const exited = await child.waitForExit()
        if (!exited) throw new Error('managed process range is not quiescent')
        await child.done.catch(() => {})
        await new Promise<void>(resolve => { setImmediate(resolve) })
      } catch (error: unknown) {
        throw new GrokRunFailure({ stage: 'teardown', category: 'unknown', outcome }, error)
      } finally {
        child.stderr?.off('data', onStderr)
        // Retain the error listener for any late stream error during teardown.
      }
    })()
    return stopping
  }
  return { child, wire, processFailure, outcome: () => outcome, stop }
}

/**
 * Cleanup never scans or recursively removes filesystem paths. The native
 * delete operation is scoped to IDs minted by this run's session/new.
 * A broken original connection is reaped before one fresh cleanup-only
 * process is used; that process initializes but never creates a session.
 */
async function cleanupRun(primary: OwnedChild, spec: GrokRunSpec, executable: string): Promise<void> {
  primary.wire.freezeOutput()
  let deleted = false
  try {
    const signal = AbortSignal.timeout(Math.ceil(spec.cleanupTimeoutMs))
    await primary.wire.drainSessionCreation(signal)
    const ids = primary.wire.ownedSessionIds()
    for (const id of ids) await primary.wire.deleteSession(id, spec.cwd, signal)
    deleted = true
  } catch {
    // Retry native deletion only after the original process has stopped.
  }

  // If quiescence fails, do not race a second process against live writers.
  await primary.stop()
  const ids = primary.wire.ownedSessionIds()
  if (deleted || ids.length === 0) return

  let helper: OwnedChild | undefined
  let deleteFailure: GrokRunFailure | undefined
  try {
    helper = spawnOwnedChild(spec, executable)
    helper.wire.start()
    const signal = AbortSignal.timeout(Math.ceil(spec.cleanupTimeoutMs))
    await Promise.race([helper.wire.initialize(signal), helper.processFailure])
    for (const id of ids) {
      await Promise.race([
        helper.wire.deleteSession(id, spec.cwd, signal),
        helper.processFailure,
      ])
    }
  } catch (error: unknown) {
    deleteFailure = new GrokRunFailure({ stage: 'session-delete', category: 'unknown' }, error)
  }
  try {
    await helper?.stop()
  } catch (error: unknown) {
    if (deleteFailure !== undefined) {
      throw new AggregateError([deleteFailure, error], `${deleteFailure.message}; cleanup process teardown failed`)
    }
    throw error
  }
  if (deleteFailure !== undefined) throw deleteFailure
}

export async function startGrokRun(request: SubagentStartRequest, spec: GrokRunSpec): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) throw new Error('subagent-grok: request aborted before startup')
  const executable = grokExecutable(spec.executable)
  const primary = spawnOwnedChild(spec, executable)
  const wire = primary.wire
  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-grok: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) requestCancel()

  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    if (cleanupPromise === undefined) {
      cleanupPromise = cleanupRun(primary, spec, executable)
      void cleanupPromise.catch(() => {})
    }
    return cleanupPromise
  }

  let startupStage: 'initialize' | 'session-start' = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(runAbort.signal), primary.processFailure])
    startupStage = 'session-start'
    await Promise.race([wire.startSession(spec.cwd, runAbort.signal), primary.processFailure])
    runAbort.signal.throwIfAborted()
  } catch (error: unknown) {
    request.signal.removeEventListener('abort', onAbort)
    const failure = new GrokRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: primary.outcome(),
    }, error)
    try {
      await cleanup()
    } catch (cleanupError: unknown) {
      throw new AggregateError([failure, cleanupError], `${failure.message}; session cleanup failed`)
    }
    if (runAbort.signal.aborted) throw new Error('subagent-grok: request aborted before run publication')
    throw failure
  }

  let diagnostic: string | undefined
  const recordFailure = (facts: FailureFacts): void => {
    const permission = wire.collectDiagnostic()
    diagnostic = failureDiagnostic(facts)
    if (permission !== undefined) diagnostic += `\n${permission}`
  }
  const turnResult = settleRunResult({
    attempt: async () => {
      try {
        const terminal = await Promise.race([
          wire.runTurn(texts, runAbort.signal),
          primary.processFailure,
        ])
        if (terminal.stopReason === 'completed' || terminal.stopReason === 'aborted') return terminal
        recordFailure({ ...wire.collectFailure(), outcome: primary.outcome() })
        return { ...terminal, diagnostic }
      } catch (error: unknown) {
        const facts: FailureFacts = error instanceof GrokRunFailure
          ? error.facts
          : wire.endedBeforeTerminal() && primary.outcome() !== undefined
            ? { stage: 'process', category: 'process', outcome: primary.outcome() }
            : { ...wire.collectFailure(), outcome: primary.outcome() }
        recordFailure(facts)
        throw error instanceof GrokRunFailure ? error : new GrokRunFailure(facts, error)
      }
    },
    collectOutput: () => wire.collectOutput(),
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  // Result delivery waits for deletion and process release, on success,
  // cancellation and failure alike. Disposal shares the same cleanup promise.
  const result: Promise<SubagentResult> = turnResult.then(async terminal => {
    try {
      await cleanup()
      return terminal
    } catch (error: unknown) {
      const failure = new GrokRunFailure({ stage: 'session-delete', category: 'unknown' }, error)
      try { spec.onError?.(failure, 'error') } catch { /* Diagnostic sink only. */ }
      const cleanupDiagnostic = `${failureDiagnostic(failure.facts)}; session cleanup was not confirmed`
      return {
        output: terminal.output,
        stopReason: terminal.stopReason === 'aborted' ? 'aborted' : 'error',
        diagnostic: terminal.diagnostic === undefined
          ? cleanupDiagnostic
          : `${terminal.diagnostic}\n${cleanupDiagnostic}`,
      }
    }
  })

  return subprocessRunHandle({
    id: brandString<SessionId>(randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: cleanup,
  })
}
