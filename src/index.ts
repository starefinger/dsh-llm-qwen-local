/**
 * Register a {@link QwenLocalAdapter} for the `qwen-local` provider route on
 * `ctx.llm`. Connection facts are resolved per request from the current
 * configuration source, so a changed endpoint, model catalog, or credential
 * name reaches the next request without re-registration; the durable
 * attachment and credentials services are resolved lazily at request time
 * because not every composition mounts one (text-only deployments never
 * need attachments; local vLLM often uses no auth at all).
 *
 * Frontend configuration: on DSH >= 0.2.0 the settings service projects the
 * plugin's `Config` schema into the `llm-qwen-local` user-settings section on
 * its own (the volatile fields of the frozen envelope carry the marks that
 * make them editable), and committed writes persist through the profile's
 * Cordis patch and the normal loader path; the volatile fields arrive in
 * `apply()` as live references the runtime updates in place when a settings
 * write commits, and the plugin re-reads them through {@link liveValue} per
 * request. (DSH 0.1.2 built this section through the removed
 * `settings.installSection` seam and switched the configuration source
 * explicitly.) The plugin's client bundle renders the editable form inline on
 * the bundle's detail page on the Web sidebar's Plugins page
 * (`plugins.bundle.config`, keyed by the package name), not in the settings
 * window — 0.2.0 places plugin configuration there and keeps the settings
 * window on the read-only built-in inventory. The provider is registered in
 * the configurable-provider directory (the web Models page offers it as a row,
 * live or dormant) and a model-discovery hook interrogates a draft's
 * `GET /models` endpoint so the page can prefill the catalog from a live
 * deployment.
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
 *             - { id: off, wire: none }
 *             - { id: low, wire: low }
 *             - { id: medium, wire: medium }
 *             - { id: xhigh, wire: xhigh }
 *           defaultEffort: xhigh
 * ```
 *
 * @module dsh-llm-qwen-local
 */

import type { Context } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from './harness/launch-environment.js'
import { assertUsableApiKey } from './harness/api-key.js'
import { LlmError } from './harness/llm-error.js'
import type { LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import { QwenLocalAdapter } from './adapter.js'
import { Config, resolveConfig } from './config.js'
import type { QwenLocalOptions } from './config.js'
import { discoverQwenModels } from './discovery.js'
import { liveValue } from './live-config.js'

export {
  bearerKey,
  httpErrorCode,
  IdleTimeout,
  QwenLocalAdapter,
} from './adapter.js'
export { isVolatileRef, liveValue } from './live-config.js'
export type { QwenLocalAdapterOptions } from './adapter.js'
export {
  Config,
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_PIXELS,
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
export {
  imageRequestBudget,
  imageRequestTarget,
  offloadedImageText,
  resolveRequestImageBytes,
  serializeMessages,
  serializeRequest,
  unlistedModel,
} from './serialize.js'
export type { ImageRequestBudget, RequestImageBytes } from './serialize.js'
export { DONE, parseSse } from './sse.js'
export { mapFinishReason, mapUsage, translate } from './translate.js'
export type * from './wire.js'

export const name = 'llm-qwen-local'
export const inject = ['llm']

/** The single provider route this plugin owns. */
export const PROVIDER = 'qwen-local'

/** The user-settings namespace that configures this provider. */
export const NS = 'llm-qwen-local'

// The `Config` value (the schemastery schema) and the `Config` type are both
// re-exported above from './config.js': Cordis validates the `cordis.yml`
// entry against the schema at plugin load, filling defaults and failing
// loudly on invalid values.

export function apply(ctx: Context, config: Config): void {
  // The configuration source: the composition entry's volatile fields,
  // re-read through the live references per request — resolveConfig is a
  // pure, cheap validation pass, so a settings write reaches the next
  // request without the plugin re-registering, while an in-flight stream
  // keeps the facts it started with. (0.2.0: the 0.1.2 `installSection`
  // setSource seam is gone — the runtime updates the references in place
  // instead, and plain pre-0.2 values pass through liveValue unchanged.)
  const current = (): Config => liveValue(config) as Config
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
  ctx.llm.registerModelDiscovery(NS, (request, signal) => discoverQwenModels(request, {
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
  }, signal))
  // 0.2.0 settings seam: the settings service projects this entry's `Config`
  // schema into its editable form on its own (the volatile fields of the
  // frozen envelope) and commits writes through the config editor's normal
  // loader path, so no section registration is needed — the live source
  // arrives through the volatile references `current()` re-reads. `configure`
  // only records this instance's page policy (auto-generated settings pages
  // stay closed; the editable form is the client bundle's configuration page
  // rendered inline on the bundle's detail page over the `plugins.bundle.config`
  // slot). The
  // settings service is optional, so the wiring attaches only while one is
  // mounted.
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.effect(() => settingsCtx.settings.configure({ auto: false }, ctx.fiber))
  })
  ctx.llm.registerAdapter([PROVIDER], adapter)
}
