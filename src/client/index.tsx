/**
 * Client half of dsh-llm-qwen-local: registers the "Qwen 本地 (vLLM)" page in
 * the DSH settings shell. The page edits the plugin's `llm-qwen-local`
 * settings section and probes a draft endpoint through model discovery — the
 * same configuration surface the curated provider editors use, rendered by
 * this plugin instead of the core (which only ships editors for the deepseek
 * and pi-ai families).
 *
 * 0.1.2 remote-namespace model: the client runtime no longer exposes a shared
 * `api` client or a `connection` handle. The page talks to the Host through
 * the typed Remote namespaces on `ctx.remote` (`remote.settings`,
 * `remote.credentials`, `remote.llm`), declared in this plugin's own `inject`,
 * and listens for pushed invalidation through `ctx.remote.$on`. The callbacks
 * the section receives are built in {@link createQwenLocalOperations}; the
 * component never holds a context or a namespace object.
 *
 * The node half installs the section with the settings seam; this half only
 * needs the runtime's slots/locale/remote services. The bundle is a
 * module-table consumer: react + react/jsx-runtime are platform modules,
 * everything else arrives through the injected services.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { QwenLocalSection } from './section.tsx'
import type { QwenLocalSectionProps, RemoteEvents } from './section.tsx'
import { createQwenLocalOperations } from './operations.ts'
import { LOCALE_NS, en, zh, type LocaleKey } from './locales.ts'
import { SECTION_NS } from './section.tsx'

/** Services required before mounting (provided by the client runtime). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'remote.settings',
]

/** The plugin-namespace translate bound at apply time. */
type BoundT = (key: LocaleKey, vars?: Record<string, string | number>) => string

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, locale, remote, remote.*).
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

  // Bound once here, where the Remote namespaces are declared in this plugin's
  // own `inject`; the panel receives callbacks and never a context.
  const operations = createQwenLocalOperations(ctx, SECTION_NS)
  // The page's invalidation channel, narrowed to the structural shape it uses.
  // The typed `$on` is generic over the forwarded-event allowlist; the adapter
  // erases that to the two events the page listens on.
  const remoteEvents: RemoteEvents = {
    $on: (event, handler) => ctx.remote.$on(event as never, handler as never),
  }
  // Registration-time text (the nav label thunk) and the inject faces share
  // one bound translate; copy freshness rides the locale revision.
  const t = ctx.locale.bind(LOCALE_NS) as unknown as BoundT
  const injected = (): Omit<QwenLocalSectionProps, 'close'> => ({
    operations,
    sectionNs: SECTION_NS,
    remote: remoteEvents,
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
