/**
 * Register a {@link QwenLocalAdapter} for the `qwen-local` provider route on
 * `ctx.llm`. Connection facts are resolved per request from the plugin's
 * validated `cordis.yml` config, so a changed endpoint, model catalog, or
 * credential name reaches the next request without re-registration; the
 * durable attachment service is resolved lazily at request time because not
 * every composition mounts one (text-only deployments never need it).
 *
 * ```yaml
 * - id: llm-qwen-local
 *   name: dsh-llm-qwen-local
 *   config:
 *     baseURL: http://127.0.0.1:8000/v1
 *     models:
 *       - id: qwen3.8
 *         name: Qwen3.8 (local)
 *         multimodal: true
 *         reasoning:
 *           efforts:
 *             - { id: off, wire: null }
 *             - { id: low, wire: low }
 *             - { id: high, wire: high }
 *           defaultEffort: high
 * ```
 *
 * @module dsh-llm-qwen-local
 */

import type { Context } from '@deepseek-ai/cordis'
import { QwenLocalAdapter } from './adapter.js'
import { Config, resolveConfig } from './config.js'
import type { QwenLocalOptions } from './config.js'

export {
  bearerKey,
  httpErrorCode,
  IdleTimeout,
  QwenLocalAdapter,
} from './adapter.js'
export type { QwenLocalAdapterOptions } from './adapter.js'
export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  resolveConfig,
} from './config.js'
export type {
  Config as ConfigType,
  QwenLocalModel,
  QwenLocalOptions,
  QwenLocalReasoning,
  QwenLocalReasoningEffort,
} from './config.js'
export { serializeMessages, serializeRequest, unlistedModel } from './serialize.js'
export { DONE, parseSse } from './sse.js'
export { mapFinishReason, mapUsage, translate } from './translate.js'
export type * from './wire.js'

export const name = 'llm-qwen-local'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'qwen-local'

// The `Config` value (the schemastery schema) and the `Config` type are both
// re-exported above from './config.js': Cordis validates the `cordis.yml`
// entry against the schema at plugin load, filling defaults and failing
// loudly on invalid values.

export function apply(ctx: Context, config: Config): void {
  // Re-resolve per request: resolveConfig is a pure, cheap validation pass,
  // so a configuration change reaches the next request without the plugin
  // re-registering, while an in-flight stream keeps the facts it started with.
  const options = (): QwenLocalOptions => resolveConfig(config)
  // Validate once at load so an invalid config fails the plugin loudly here,
  // not on the first model call.
  options()
  const adapter = new QwenLocalAdapter({
    options,
    resolveAttachments: () => ctx.get('attachments'),
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
