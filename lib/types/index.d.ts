import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export declare const name = "subagent-grok"
export declare const inject: string[]
export interface Config {
  /** Provider registration name; defaults to grok. */
  providerName?: string
  /** Installed Grok executable. Omitted: ~/.grok/bin/grok(.exe), then PATH. */
  executable?: string
  /** Omitted: Grok's native model. */
  model?: string
  /** Explicit child environment after DSH credential scrubbing. */
  env?: Record<string, string>
  /** Managed-process termination grace, milliseconds. Default 3000. */
  disposeGraceMs?: number
  /** Per native-delete attempt timeout, milliseconds. Default 30000. */
  cleanupTimeoutMs?: number
}
export declare const Config: z<Config>
export declare function apply(ctx: Context, config: Config): void

