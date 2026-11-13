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
                                                        
                                                         
import {
  settleRunResult,
  subprocessRunHandle,
                      
                   
                            
                          
} from '@deepseek-ai/dsh-subagent'
             
                   
                    
                      
                                    
import { GrokAcpWire,                           } from './wire.js'

export const DEFAULT_DISPOSE_GRACE_MS = 3_000
export const DEFAULT_CLEANUP_TIMEOUT_MS = 30_000

                                                                                                         
                                                                   

                        
                              
                                    
                                                  
 

function failureDiagnostic(facts              )         {
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
           facts              
  constructor(facts              , cause          ) {
    super(`subagent-grok: ${failureDiagnostic(facts)}`, cause === undefined ? undefined : { cause })
    this.name = 'GrokRunFailure'
    this.facts = facts
  }
}

export function grokStartupFailure(cause         )        {
  return new GrokRunFailure({ stage: 'initialize', category: 'unknown' }, cause)
}

/** Resolve an installed binary only; never install, download or probe a version. */
export function grokExecutable(configured         )         {
  if (configured !== undefined) return configured
  const native = join(homedir(), '.grok', 'bin', process.platform === 'win32' ? 'grok.exe' : 'grok')
  return existsSync(native) ? native : 'grok'
}

/** Argument vector passed directly to the DSH subprocess service, without a shell. */
export function grokAgentArgv(executable        , model         )           {
  return [
    executable,
    'agent',
    '--always-approve',
    '--no-leader',
    ...model === undefined ? [] : ['--model', model],
    'stdio',
  ]
}

                              
                      
                              
                         
                                      
                                 
                                   
                                                                 
                                                                           
 

export function textTask(prompt                         )           {
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

                      
                                  
                            
                                         
                                          
                       
 

function spawnOwnedChild(spec             , executable        )             {
  let child                  
  try {
    child = spec.spawn({
      argv: grokAgentArgv(executable, spec.model),
      cwd: spec.cwd,
      env: spec.env,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: spec.disposeGraceMs,
    })
  } catch (error         ) {
    throw grokStartupFailure(error)
  }

  const wire = new GrokAcpWire(
    child.stdout                                           ,
    child.stdin                                          ,
  )
  const onStderr = (chunk                 )       => {
    try {
      writeFileSync(process.stderr.fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    } catch {
      // Host stderr is auxiliary, never a result or lifecycle authority.
    }
  }
  const onStderrError = ()       => {}
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)

  let outcome                               
  const processFailure = child.done.then       (
    async value => {
      outcome = value
      // Allow a terminal protocol response already in Node's I/O queue to win.
      await new Promise      (resolve => { setImmediate(resolve) })
      throw new GrokRunFailure({ stage: 'process', category: 'process', outcome: value })
    },
    (error         ) => {
      throw new GrokRunFailure({ stage: 'process', category: 'unknown' }, error)
    },
  )
  void processFailure.catch(() => {})

  let stopping                           
  const stop = ()                => {
    stopping ??= (async () => {
      wire.close()
      try { child.stdin?.end() } catch { /* A concurrently closed pipe is harmless. */ }
      try {
        child.terminate()
        const exited = await child.waitForExit()
        if (!exited) throw new Error('managed process range is not quiescent')
        await child.done.catch(() => {})
        await new Promise      (resolve => { setImmediate(resolve) })
      } catch (error         ) {
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
async function cleanupRun(primary            , spec             , executable        )                {
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

  let helper                        
  let deleteFailure                            
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
  } catch (error         ) {
    deleteFailure = new GrokRunFailure({ stage: 'session-delete', category: 'unknown' }, error)
  }
  try {
    await helper?.stop()
  } catch (error         ) {
    if (deleteFailure !== undefined) {
      throw new AggregateError([deleteFailure, error], `${deleteFailure.message}; cleanup process teardown failed`)
    }
    throw error
  }
  if (deleteFailure !== undefined) throw deleteFailure
}

export async function startGrokRun(request                      , spec             )                       {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) throw new Error('subagent-grok: request aborted before startup')
  const executable = grokExecutable(spec.executable)
  const primary = spawnOwnedChild(spec, executable)
  const wire = primary.wire
  const runAbort = new AbortController()
  const requestCancel = ()       => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-grok: run cancelled locally'))
    wire.interrupt()
  }
  const onAbort = ()       => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })
  if (request.signal.aborted) requestCancel()

  let cleanupPromise                           
  const cleanup = ()                => {
    if (cleanupPromise === undefined) {
      cleanupPromise = cleanupRun(primary, spec, executable)
      void cleanupPromise.catch(() => {})
    }
    return cleanupPromise
  }

  let startupStage                                 = 'initialize'
  try {
    wire.start()
    await Promise.race([wire.initialize(runAbort.signal), primary.processFailure])
    startupStage = 'session-start'
    await Promise.race([wire.startSession(spec.cwd, runAbort.signal), primary.processFailure])
    runAbort.signal.throwIfAborted()
  } catch (error         ) {
    request.signal.removeEventListener('abort', onAbort)
    const failure = new GrokRunFailure({
      stage: startupStage,
      category: 'unknown',
      outcome: primary.outcome(),
    }, error)
    try {
      await cleanup()
    } catch (cleanupError         ) {
      throw new AggregateError([failure, cleanupError], `${failure.message}; session cleanup failed`)
    }
    if (runAbort.signal.aborted) throw new Error('subagent-grok: request aborted before run publication')
    throw failure
  }

  let diagnostic                    
  const recordFailure = (facts              )       => {
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
      } catch (error         ) {
        const facts               = error instanceof GrokRunFailure
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
  const result                          = turnResult.then(async terminal => {
    try {
      await cleanup()
      return terminal
    } catch (error         ) {
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
    id: brandString           (randomUUID()),
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: cleanup,
  })
}
