/**
 * Client half of dsh-llm-qwen-local: registers the "Qwen 本地 (vLLM)" page in
 * the DSH settings shell. The page edits the plugin's `llm-qwen-local`
 * settings section through the settings RPC (`settings.describe` /
 * `settings.replace`) and probes a draft endpoint through
 * `llm.discoverModels` — the same configuration surface the curated
 * provider editors use, rendered by this plugin instead of the core
 * (which only ships editors for the deepseek and pi-ai families).
 *
 * The node half installs the section with the settings seam; this half only
 * needs the runtime's slots/locale/connection/remote services. The bundle is
 * a module-table consumer: react + react/jsx-runtime are platform modules,
 * everything else arrives through the injected services.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { QwenLocalSection } from './section.tsx'
import type { QwenLocalSectionProps } from './section.tsx'
import { LOCALE_NS, en, zh, type LocaleKey } from './locales.ts'

/** Services required before mounting (provided by the client runtime). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/** The plugin-namespace translate bound at apply time. */
type BoundT = (key: LocaleKey, vars?: Record<string, string | number>) => string

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, locale, connection, remote).
 */
export function apply(ctx: ClientContext): void {
  // Follow the DSH i18n system: register the dictionaries into the shared
  // locale registry (the untyped single-locale form — this namespace is not
  // in the framework's LocaleNamespaceMap). The disposers run on fiber
  // disposal, so re-activation (HMR) re-registers cleanly.
  ctx.effect(() => {
    const offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
    const offEn = ctx.locale.register(LOCALE_NS, 'en', en)
    return () => {
      offZh()
      offEn()
    }
  }, 'dsh-llm-qwen-local: copy dictionaries')
  const connection = ctx.get('connection') as ConnectionHandle
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(LOCALE_NS) as unknown as BoundT
  const injected = (): Omit<QwenLocalSectionProps, 'close'> => ({
    api: connection.api,
    remote: ctx.remote,
    t,
  })
  // One settings page, ordered after Models and agent presets: choosing a
  // model is routine, wiring a local deployment is the setup act behind it.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'qwen-local',
    order: 30,
    label: () => t('nav'),
    inject: injected,
  }, QwenLocalSection))
}
