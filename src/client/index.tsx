/**
 * Client half of dsh-llm-qwen-local: registers the plugin's configuration
 * page on the DSH 0.2.0 **Plugins** page (the sidebar page that manages the
 * profile's bundles and their configuration). The page edits the plugin's
 * `llm-qwen-local` settings section — the settings service's projection of
 * the plugin's volatile `Config` — and probes a draft endpoint through model
 * discovery: the same configuration surface the curated provider editors use,
 * rendered by this plugin instead of the core (which only ships editors for
 * the deepseek and pi-ai families).
 *
 * 0.2.0 placement: "A plugin that registers a configuration page is edited
 * here, on its own page; Settings keeps the read-only inventory" — the page
 * is registered into the plugin-manager page's `plugins.bundle.config` slot
 * (keyed by the bundle's package name, `dsh-llm-qwen-local`) and rendered
 * inline on the bundle's detail page, the same surface the official
 * single-config bundles use, so no extra navigation hop is needed. The
 * registration is scoped with `whileServed` to the `llm-qwen-local`
 * namespace, so it exists only while this bundle's row is on. The 0.1.2
 * `settings.section` page in the settings window is gone with the 0.1.2 seam.
 *
 * 0.2.0 remote-namespace model: the client runtime exposes no shared `api`
 * client or `connection` handle. The page talks to the Host through the typed
 * Remote namespaces on `ctx.remote` (`remote.credentials`, `remote.llm`),
 * declared in this plugin's own `inject`, and through the settings domain's
 * shared `ConfigForm` scope for the `llm-qwen-local` namespace
 * (`ctx.configForms.get`), which owns the staged read, the ordered revision-
 * fenced writes, and the recovery reload. Pushed invalidation rides the
 * scope's snapshot subscription; the credential reference still pushes
 * `credentials/reference-updated` through `ctx.remote.$on`. The callbacks the
 * page receives are built in {@link createQwenLocalOperations}; the component
 * never holds a context or a namespace object.
 *
 * The node half mounts the adapter and records the page policy
 * (`settings.configure({ auto: false })` — the auto-generated settings page
 * stays closed; this page is the one); this half only needs the runtime's
 * slots/locale/remote/configForms services. The bundle is a module-table
 * consumer: react + react/jsx-runtime are platform modules, everything else
 * arrives through the injected services.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { QwenLocalConfigPage } from './section.tsx'
import type { QwenLocalConfigPageProps, RemoteEvents } from './section.tsx'
import { BUNDLE_CONFIG_KEY, SECTION_NS } from './section.tsx'
import { createQwenLocalOperations } from './operations.ts'
import { LOCALE_NS, en, zh, type LocaleKey } from './locales.ts'

/** Services required before mounting (provided by the client runtime). */
export const inject = [
  'slots', 'locale', 'remote', 'remote.credentials', 'remote.llm', 'configForms',
]

/** The plugin-namespace translate bound at apply time. */
type BoundT = (key: LocaleKey, vars?: Record<string, string | number>) => string

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots, locale, remote, configForms).
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
  // own `inject`; the page receives callbacks and never a context.
  const operations = createQwenLocalOperations(ctx)
  // The shared settings scope for the plugin's namespace (the row id and the
  // settings namespace are both `llm-qwen-local`), so every editor of this
  // entry — this page and any future one — shares one read mirror and one
  // ordered write queue.
  const scope = ctx.configForms.get(SECTION_NS)
  // The page's credential-invalidation channel, narrowed to the structural
  // shape it uses. The typed `$on` is generic over the forwarded-event
  // allowlist; the adapter erases that to the one event the page listens on.
  const remoteEvents: RemoteEvents = {
    $on: (event, handler) => ctx.remote.$on(event as never, handler as never),
  }
  // The page's inject face: the registration-time `t` and the render-time
  // `view` come from the slot (the entry's `locale` and the page's render),
  // so the face carries everything else.
  const injected = (): Omit<QwenLocalConfigPageProps, 't' | 'view'> => ({
    scope,
    operations,
    remote: remoteEvents,
  })
  // The page exists while the Host serves the `llm-qwen-local` namespace —
  // i.e. while this bundle's row is composed — so an off row shows no inline
  // configuration section and a deployment without the row shows no trace of
  // the page. `whileServed` hands the registration back to us when the
  // namespace is withdrawn; the disposer runs on fiber disposal, so
  // re-activation (HMR) re-registers cleanly. The keyed face is rendered
  // inline on the bundle's detail page (the `plugins.bundle.config` slot),
  // so no row Configure control is involved.
  ctx.effect(() => ctx.configForms.whileServed([SECTION_NS], () =>
    ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_CONFIG_KEY,
      locale: LOCALE_NS,
      inject: injected,
    }, QwenLocalConfigPage)),
  ), 'dsh-llm-qwen-local: plugin configuration page')
}
