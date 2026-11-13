/**
 * One-shot native Grok Build provider, following the Codex provider's Cordis
 * registration, subprocess ownership and external-run contracts.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  assertUsableCwd,
  NO_START_CAPABILITIES,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_CLEANUP_TIMEOUT_MS,
  DEFAULT_DISPOSE_GRACE_MS,
  grokStartupFailure,
  startGrokRun,
} from './run.ts'

export const name = 'subagent-grok'
export const inject = ['subagents', 'subprocess']

/** Always-approve and delete-after-run are fixed behavior, not toggles. */
export interface Config {
  /** Registration name; defaults to grok. */
  providerName?: string
  /** Existing executable; omitted uses the standard installation, then PATH. */
  executable?: string
  /** Native model ID; omission preserves Grok's own selection. */
  model?: string
  /** Explicit environment overlay after the shared credential scrub. */
  env?: Record<string, string>
  /** Managed-process termination grace in milliseconds. */
  disposeGraceMs?: number
  /** Timeout for each cleanup attempt, not for the delegated task. */
  cleanupTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default('grok'),
  executable: z.string().min(1),
  model: z.string().min(1),
  env: z.dict(z.string()).default({}),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
  cleanupTimeoutMs: z.number().default(DEFAULT_CLEANUP_TIMEOUT_MS),
})

type ResolvedConfig = Required<Omit<Config, 'executable' | 'model'>>
  & Pick<Config, 'executable' | 'model'>

class GrokProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string
  private readonly ctx: Context
  private readonly config: ResolvedConfig

  constructor(
    name: string,
    ctx: Context,
    config: ResolvedConfig,
  ) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  start(request: ResolvedSubagentStartRequest) {
    let cwd: string
    try {
      cwd = assertUsableCwd('subagent-grok', 'child cwd', request.cwd)
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error('subagent-grok: request aborted before startup')
      }
      throw grokStartupFailure(error)
    }
    return startGrokRun(request, {
      cwd,
      ...this.config.executable === undefined ? {} : { executable: this.config.executable },
      ...this.config.model === undefined ? {} : { model: this.config.model },
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      cleanupTimeoutMs: this.config.cleanupTimeoutMs,
      spawn: spec => this.ctx.subprocess.spawn(spec),
      onError: (error, reason) => {
        this.ctx.logger.warn(
          `subagent-grok "${this.name}": child failed (${reason}): ${error.message}`,
        )
      },
    })
  }
}

export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? 'grok',
    ...config.executable === undefined ? {} : { executable: config.executable },
    ...config.model === undefined ? {} : { model: config.model },
    env: config.env ?? {},
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
    cleanupTimeoutMs: config.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS,
  }
  for (const field of ['disposeGraceMs', 'cleanupTimeoutMs'] as const) {
    assertPositiveFinite('subagent-grok', field, resolved[field])
    if (resolved[field] > MAX_TIMER_DELAY_MS) {
      throw new Error(`subagent-grok: ${field} exceeds ${MAX_TIMER_DELAY_MS}`)
    }
  }
  for (const field of ['providerName', 'executable', 'model'] as const) {
    const value = resolved[field]
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.includes('\0'))) {
      throw new Error(`subagent-grok: ${field} must be a non-empty string without NUL`)
    }
  }
  ctx.subagents.registerProvider(new GrokProvider(resolved.providerName, ctx, resolved))
}
