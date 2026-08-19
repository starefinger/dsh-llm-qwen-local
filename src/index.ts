/**
 * Register a {@link QwenLocalAdapter} for the `qwen-local` provider route on
 * `ctx.llm`. Connection facts are resolved per request from the current
 * configuration source, so a changed endpoint, model catalog, or credential
 * name reaches the next request without re-registration; the durable
 * attachment and credentials services are resolved lazily at request time
 * because not every composition mounts one (text-only deployments never
 * need attachments; local vLLM often uses no auth at all).
 *
 * Frontend configuration: the plugin's `Config` schema is installed as the
 * `llm-qwen-local` user-settings section (via
 * {@link installSettingsSection}), so the web settings surface renders an
 * editable form for it; commits switch the configuration source live. The
 * provider is registered in the configurable-provider directory (the web
 * Models page offers it as a row, live or dormant) and a model-discovery
 * hook interrogates a draft's `GET /models` endpoint so the Models page can
 * prefill the catalog from a live deployment.
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
 *             - { id: xhigh, wire: xhigh }
 *           defaultEffort: xhigh
 * ```
 *
 * @module dsh-llm-qwen-local
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { QwenLocalAdapter } from './adapter.js'
import { Config, resolveConfig } from './config.js'
import type { QwenLocalOptions } from './config.js'
import { discoverQwenModels } from './discovery.js'

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
export { discoverQwenModels } from './discovery.js'
export type { QwenLocalDiscoveryFacts } from './discovery.js'
export { serializeMessages, serializeRequest, unlistedModel } from './serialize.js'
export { DONE, parseSse } from './sse.js'
export { mapFinishReason, mapUsage, translate } from './translate.js'
export type * from './wire.js'

export const name = 'llm-qwen-local'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'qwen-local'

/** The user-settings namespace that configures this provider. */
export const NS = settingsNamespace('llm-qwen-local')

// The `Config` value (the schemastery schema) and the `Config` type are both
// re-exported above from './config.js': Cordis validates the `cordis.yml`
// entry against the schema at plugin load, filling defaults and failing
// loudly on invalid values.

export function apply(ctx: Context, config: Config): void {
  // The configuration source: the composition entry while no settings scope
  // is attached, the resolved settings section otherwise. Re-resolved per
  // request — resolveConfig is a pure, cheap validation pass, so a change
  // reaches the next request without the plugin re-registering, while an
  // in-flight stream keeps the facts it started with.
  let current: () => Config = () => config
  const options = (): QwenLocalOptions => resolveConfig(current())
  // Validate once at load so an invalid config fails the plugin loudly here,
  // not on the first model call.
  options()

  // Named credentials resolve through the durable credentials service first
  // (what the web Models page writes), then the launch environment. A miss
  // fails loud: handing the deployment a missing key silently would let it
  // authenticate as whatever ambient key it happens to find.
  const resolveApiKey = async (ref: string): Promise<string> => {
    // The credentials service is optional in the context; ref name
    // validation is the service seam's own concern.
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined ? await credentials.resolve(ref) : undefined
    if (hit !== undefined && hit.value.length > 0) {
      return assertUsableApiKey(hit.value, 'dsh-llm-qwen-local', ref)
    }
    const ambient = launchEnvironmentOf(ctx).get(ref)
    if (ambient !== undefined && ambient.value.length > 0) {
      return assertUsableApiKey(ambient.value, 'dsh-llm-qwen-local', ref)
    }
    throw new LlmError(
      `dsh-llm-qwen-local: no API key for "${ref}"; store it through the credentials service`
      + ` (the web Models page writes it) or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new QwenLocalAdapter({
    options,
    resolveAttachments: () => ctx.get('attachments'),
    resolveApiKey,
  })
  // The route is configurable from the moment the plugin mounts — dormant or
  // not — so configuration surfaces offer it before any settings commit.
  ctx.llm.registerConfigurableProviders([
    { provider: PROVIDER, displayName: 'Qwen (local, vLLM)', settingsNs: NS, settingsPath: [] },
  ])
  // Interrogating an endpoint is a configuration-time action over a draft, so
  // it is offered for the whole namespace: a draft names no route it has not
  // configured yet. A draft naming the configured route but no endpoint is
  // answered from the adapter's own catalog; a named route supplies its
  // stored credential when the draft carries none (a miss probes
  // unauthenticated — most local vLLM instances use no auth).
  ctx.llm.registerModelDiscovery(NS, request => discoverQwenModels(request, {
    ownModels: (): readonly LlmDiscoveredModel[] => options().models.map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? options().defaultContextWindow,
      maxTokens: model.maxTokens ?? options().maxTokens,
    })),
    storedApiKey: async (provider): Promise<string | undefined> => {
      if (provider !== PROVIDER) return undefined
      const ref = options().apiKeyEnv
      if (ref === undefined) return undefined
      try {
        return await resolveApiKey(ref)
      } catch (_missingStoredCredential) {
        return undefined
      }
    },
  }))
  // Install the canonical optional-settings consumer wiring: the section
  // schema resolves the whole profile, a write that could not be served is
  // refused where it is written (validate), and a committed change switches
  // the source before the adapter's next per-request resolution.
  installSettingsSection(ctx, NS, Config, config, {
    validate: (value) => {
      resolveConfig(value)
    },
    setSource: (source) => {
      current = source
    },
    // The adapter re-resolves options() per stream, and the catalog plus the
    // discovery hook read the same source, so no re-registration is needed —
    // the fixed route set never changes, only the facts behind it.
    onChange: () => {
      // Re-validate through the new source now: an unserviceable section
      // cannot hide behind a lazy per-request resolution.
      options()
    },
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
