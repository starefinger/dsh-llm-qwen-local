/**
 * The Qwen (local, vLLM) configuration page: one form over the plugin's
 * `llm-qwen-local` settings namespace. On DSH 0.2.0 the settings service
 * projects the plugin's volatile `Config` into that namespace and commits
 * writes through the profile's Cordis patch, so this page — mounted on the
 * Web sidebar's **Plugins** page through the `plugins.bundle.config` slot
 * (keyed by the bundle's package name, `dsh-llm-qwen-local`) and rendered
 * inline on the bundle's detail page — edits the same document the host
 * resolves per request. The shared
 * `ConfigForm` scope (from the settings domain's `configForms` service) owns
 * the staged read (schema-resolved value + revision fence), the ordered write
 * queue, and the recovery reload after a refused write; the page renders the
 * snapshot, edits a local draft, and commits it as one atomic section-root
 * `set` operation.
 *
 * The page renders only the form body — the bundle detail page's built-in
 * chrome (the bundle's `locale/*.json` metadata, falling back to the
 * manifest) owns the title and description, so there is no second header (the
 * official companions follow the same pattern). The API key follows the core
 * Models page convention: the value never enters the settings section — it is
 * written to the durable credentials service under the provider's derived ref
 * (`QWEN_LOCAL_API_KEY`), and the section's `apiKeyEnv` field records that ref
 * name for the adapter's resolver. Model discovery probes the draft's endpoint
 * through `llm.discoverModels` and merges the ids into the draft. The form
 * also edits the request-image budgets introduced by the 0.1.1-rc.2 harness
 * upgrade: the per-model pixel/byte projection budgets. There is no route-level
 * total image cap in this plugin — every image is inlined once it fits its
 * per-image budget, and a request too large for the endpoint is the endpoint's
 * to refuse (the backend LLM service's own input limits apply).
 *
 * Row identity: model and effort rows carry a stable `key` assigned when the
 * row is created or discovered, so the React row — and its inputs — keep
 * their focus across edits. A key derived from the id text would remount the
 * row on every keystroke (each changed letter is a new key).
 *
 * Styling is inline by design: the client bundle keeps away from the CSS
 * pipeline (no stylesheet route for plugin bundles in the module table), so
 * the page carries its own minimal rules.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, SegmentedControl } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { QwenLocalOperations } from './operations.ts'
import type { LocaleKey } from './locales.ts'

/** The settings namespace this page edits (mirrors the node-side NS). */
export const SECTION_NS = 'llm-qwen-local'

/**
 * The `plugins.bundle.config` key: the bundle's package name. The
 * plugin-manager page renders the keyed face inline on the bundle's detail
 * page (the same surface the official single-config bundles use), so the key
 * is the package name — not a per-row id.
 */
export const BUNDLE_CONFIG_KEY = 'dsh-llm-qwen-local'

/** The provider route this section configures (for discovery). */
export const PROVIDER_ROUTE = 'qwen-local'

/**
 * The fallback credential ref: the core Models page derives the same name
 * from the provider id (`deriveKeyRef`), so a key stored here and one
 * stored from the Models page are interchangeable. A ref the section already
 * names wins over it (the core's `refFor` convention), so an existing
 * credential under another name is respected instead of orphaned.
 */
export const KEY_REF = 'QWEN_LOCAL_API_KEY'

/** The core `refFor` convention: a named ref in the section wins, else the derived default. */
function refFor(loadedRef: string): string {
  return loadedRef.length > 0 ? loadedRef : KEY_REF
}

/** One effort row in flight. `wire` is the raw input text: '' means null. */
interface EffortDraft {
  /** Stable row identity (see {@link ModelDraft.key}). */
  key: number
  id: string
  name: string
  wire: string
}

/** The row-identity counter is module-local: page state is the only consumer. */
let nextRowKey = 1

/** Assign a fresh, process-unique row identity. */
function newKey(): number {
  return nextRowKey++
}

/** One model row in flight. Numeric fields keep the raw input text. */
interface ModelDraft {
  /** Stable row identity: assigned when the row is created or discovered, so the React row keeps its input focus across edits (a key that includes the id text would remount the row on every keystroke). */
  key: number
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  imageMaxPixels: string
  imageMaxBytes: string
  multimodal: boolean
  preserveThinking: boolean
  hasReasoning: boolean
  efforts: EffortDraft[]
  defaultEffort: string
  offMode: string
}

interface PageState {
  /** Revision the draft was read at; fences the next write. */
  revision: number | undefined
  /** Whether the Host document accepts writes (memory mode never does). */
  writable: boolean
  draft: ModelDraft[]
  baseURL: string
  /** The loaded section's `apiKeyEnv` value (a ref or env-var name). */
  apiKeyEnv: string
  /** Pass-through fields the form does not render (idle timeout, defaults). */
  passthrough: Record<string, unknown>
}

type T = (key: LocaleKey, vars?: Record<string, string | number>) => string

/**
 * Layout-only styles. Every color, border, and radius comes from the host
 * theme (`--dsw-alias-*` / `--dsw-radius-*` tokens), and every interactive
 * control is a shared `@deepseek-ai/dsh-client-ui-primitives` component —
 * so the page renders with the same inputs, buttons, checkboxes, and
 * segmented controls the rest of the app uses. The vertical rhythm
 * (12px field padding, hairline separators, 13px/500 primary labels, 16px
 * footer) mirrors the host's own `SettingsForm` (fields.module.css), so the
 * card reads as one more settings section instead of a foreign form.
 */
const css = {
  page: {
    display: 'flex', flexDirection: 'column' as const,
    maxWidth: 720, fontFamily: 'inherit',
  },
  /** Top-level form field, metric-matched to the host SettingsForm. */
  field: {
    display: 'flex', flexDirection: 'column' as const, gap: 6,
    padding: '12px 0', flex: '0 1 auto',
  },
  hairline: { borderTop: '0.5px solid var(--dsw-alias-border-l2)' },
  /** Compact label+control column used inside the model cards and effort rows. */
  subField: { display: 'flex', flexDirection: 'column' as const, gap: 4, flex: '0 1 auto' },
  label: {
    fontSize: 13, fontWeight: 500, lineHeight: 1.5,
    color: 'var(--dsw-alias-label-primary)',
  },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' },
  /** Effort-table columns. Header and data rows share the same tracks (and the
   * same 68px trailing action slot), so the columns line up exactly; the column
   * is a flex column, so the input stretches to fill it like the model fields. */
  effortColId: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, flex: '1 1 110px' },
  effortColName: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, flex: '1.5 1 140px' },
  effortColWire: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, flex: '1 1 110px' },
  /** Empty header slot, the width of a row remove button. */
  effortActionSlot: { flex: '0 0 68px' },
  card: {
    border: '1px solid var(--dsw-alias-border-l1)',
    borderRadius: 'var(--dsw-radius-md)',
    background: 'var(--dsw-alias-bg-layer-1)',
    padding: 12, display: 'flex', flexDirection: 'column' as const, gap: 12,
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: {
    fontSize: 13, fontWeight: 600,
    fontFamily: 'ui-monospace, Menlo, monospace',
    color: 'var(--dsw-alias-label-primary)',
  },
  /** Action row, metric-matched to the host SettingsForm footer. */
  footer: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center', paddingTop: 16 },
  /** Inline notes that sit inside a field (key status, "no reasoning" row). */
  noteWarn: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-primary)' },
  noteMuted: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  /** Standalone status paragraphs below the footer. */
  msgError: { margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary)' },
  msgStatus: { margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  msgMuted: { margin: '8px 0 0', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-label-secondary)' },
  ok: { margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-success-primary)' },
  banner: { margin: '0 0 12px', fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-warn-primary)' },
  checks: { display: 'flex', gap: 16 },
  /** Theme-tinted native select; the host primitives expose no Select yet. */
  select: {
    boxSizing: 'border-box', height: 32, padding: '0 8px',
    fontSize: 14, fontFamily: 'inherit', lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    borderRadius: 'var(--dsw-radius-md)',
  },
  divider: { borderTop: '0.5px solid var(--dsw-alias-border-l2)', paddingTop: 8 },
} as const

/** Read one field of a raw JSON record, tolerating absence and wrong types. */
function field(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberField(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
}

function toEfforts(raw: unknown): EffortDraft[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map(entry => {
    const record = field(entry)
    return {
      key: newKey(),
      id: stringField(record.id),
      name: stringField(record.name),
      wire: record.wire === null ? '' : stringField(record.wire),
    }
  })
}

function toModels(raw: unknown): ModelDraft[] {
  const list = Array.isArray(raw) ? raw : []
  return list.map(entry => {
    const record = field(entry)
    const reasoning = field(record.reasoning)
    return {
      key: newKey(),
      id: stringField(record.id),
      name: stringField(record.name),
      contextWindow: numberField(record.contextWindow),
      maxTokens: numberField(record.maxTokens),
      imageMaxPixels: numberField(record.imageMaxPixels),
      imageMaxBytes: numberField(record.imageMaxBytes),
      multimodal: record.multimodal === true,
      preserveThinking: record.preserveThinking !== false,
      hasReasoning: record.reasoning !== undefined,
      efforts: toEfforts(reasoning.efforts),
      defaultEffort: stringField(reasoning.defaultEffort),
      offMode: stringField(reasoning.offMode) || 'chat-template-kwargs',
    }
  })
}

/** Parse the scope's schema-resolved section into page state, segregating passthrough. */
function parsePage(value: unknown, revision: number | undefined, writable: boolean): PageState {
  const record = field(value)
  const { baseURL: _baseURL, apiKeyEnv: _apiKeyEnv, models: _models, ...rest } = record
  return {
    revision,
    writable,
    baseURL: stringField(record.baseURL),
    apiKeyEnv: stringField(record.apiKeyEnv),
    draft: toModels(record.models),
    // `rest` is pass-through only: legacy sections that still carry a
    // `maxRequestImageBytes` value (removed from the schema) keep it — the
    // validator ignores unknown fields, so the value is inert.
    passthrough: rest,
  }
}

/** Serialize one effort row: blank wire is null, blank name is absent. */
function wireEffort(effort: EffortDraft): Record<string, unknown> {
  return {
    id: effort.id,
    ...effort.name.length > 0 ? { name: effort.name } : {},
    wire: effort.wire.length > 0 ? effort.wire : null,
  }
}

/** Serialize one model row, omitting empty optionals. */
function wireModel(model: ModelDraft): Record<string, unknown> {
  const reasoning: Record<string, unknown> | undefined = model.hasReasoning
    ? {
      efforts: model.efforts.map(wireEffort),
      ...model.defaultEffort.length > 0 ? { defaultEffort: model.defaultEffort } : {},
      offMode: model.offMode,
    }
    : undefined
  return {
    id: model.id,
    ...model.name.length > 0 ? { name: model.name } : {},
    ...model.contextWindow.length > 0 ? { contextWindow: Number(model.contextWindow) } : {},
    ...model.maxTokens.length > 0 ? { maxTokens: Number(model.maxTokens) } : {},
    ...model.imageMaxPixels.length > 0 ? { imageMaxPixels: Number(model.imageMaxPixels) } : {},
    ...model.imageMaxBytes.length > 0 ? { imageMaxBytes: Number(model.imageMaxBytes) } : {},
    multimodal: model.multimodal,
    preserveThinking: model.preserveThinking,
    ...reasoning === undefined ? {} : { reasoning },
  }
}

type KeyMode = 'new' | 'clear' | 'keep'

/**
 * Serialize the draft into the section value for the section-root `set` op.
 * The `apiKeyEnv` the section carries: the managed ref after a key store,
 * absent after a clear, the loaded value untouched otherwise.
 */
function wireSection(state: PageState, keyMode: KeyMode): Record<string, unknown> {
  const section: Record<string, unknown> = { ...state.passthrough }
  if (state.baseURL.length > 0) section.baseURL = state.baseURL
  // A key store pins the effective ref (loaded or derived); a clear drops the
  // reference; keep leaves whatever the section already names untouched.
  const ref = keyMode === 'clear' ? undefined : refFor(state.apiKeyEnv)
  if (ref !== undefined && ref.length > 0) section.apiKeyEnv = ref
  section.models = state.draft.map(wireModel)
  return section
}

/** The pushed-invalidation channel the page listens on (structural subset). */
export interface RemoteEvents {
  $on(event: string, handler: (...args: unknown[]) => void): () => void
}

export interface QwenLocalConfigPageProps {
  /** The view the Plugins page renders (the detail page renders `page`). */
  view: string
  /** The shared settings scope for the `llm-qwen-local` namespace. */
  scope: ConfigForm<unknown>
  /** The bound Host operations (credentials + llm discovery remotes). */
  operations: QwenLocalOperations
  /** The pushed-invalidation channel (credentials document commits). */
  remote: RemoteEvents
  /** Registrant-localized translate. */
  t: T
}

/**
 * The Qwen (local) configuration page. The Plugins page renders it inline on
 * the bundle's detail page (`plugins.bundle.config`, `view: "page"`), so the
 * page is the full form — the detail page's built-in chrome owns the header.
 */
export function QwenLocalConfigPage(page: QwenLocalConfigPageProps): JSX.Element {
  return <QwenLocalPageBody scope={page.scope} operations={page.operations} remote={page.remote} t={page.t} />
}

/** The full configuration form, staged over the shared settings scope. */
function QwenLocalPageBody({ scope, operations, remote, t }: Omit<QwenLocalConfigPageProps, 'view'>): JSX.Element {
  const [snap, setSnap] = useState(() => scope.getSnapshot())
  const [page, setPage] = useState<PageState | undefined>()
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState<string | undefined>()
  const [discoverError, setDiscoverError] = useState<string | undefined>()
  // API key: the value only crosses the wire in one direction (set/unset);
  // the page never reads it back — only whether one is stored under the ref.
  const [keyDraft, setKeyDraft] = useState('')
  const [keyStored, setKeyStored] = useState(false)
  const [keyClear, setKeyClear] = useState(false)

  // Pushed invalidation through the shared mirror: any committed settings
  // change replaces the snapshot, so two open surfaces converge without
  // polling.
  useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope])

  // Derive the draft from the ready snapshot (and re-read the credential
  // state for the ref the section names).
  useEffect(() => {
    if (snap.status !== 'ready') {
      setPage(undefined)
      return
    }
    const parsed = parsePage(snap.value, snap.revision, snap.writable)
    setPage(parsed)
    let stale = false
    void operations.describeCredential(refFor(parsed.apiKeyEnv))
      .then(info => { if (!stale) setKeyStored(info?.configured ?? false) })
      .catch(() => { /* the describe is best-effort; the form renders either way */ })
    return () => { stale = true }
  }, [snap, operations])

  const setModel = useCallback((index: number, patch: Partial<ModelDraft>) => {
    setPage(current => {
      if (current === undefined) return current
      const next = current.draft.slice()
      const entry = next[index]
      if (entry === undefined) return current
      next[index] = { ...entry, ...patch }
      return { ...current, draft: next }
    })
    setSaved(false)
  }, [])

  const setEffort = useCallback((modelIndex: number, effortIndex: number, patch: Partial<EffortDraft>) => {
    setPage(current => {
      if (current === undefined) return current
      const model = current.draft[modelIndex]
      if (model === undefined) return current
      const efforts = model.efforts.slice()
      const entry = efforts[effortIndex]
      if (entry === undefined) return current
      efforts[effortIndex] = { ...entry, ...patch }
      const draft = current.draft.slice()
      draft[modelIndex] = { ...model, efforts }
      return { ...current, draft }
    })
    setSaved(false)
  }, [])

  const onDiscover = useCallback(async () => {
    if (page === undefined) return
    setDiscovering(true)
    setDiscoverError(undefined)
    setDiscoverNote(undefined)
    try {
      const request: LlmModelDiscoveryRequest = {
        provider: PROVIDER_ROUTE,
      }
      if (page.baseURL.length > 0) request.baseURL = page.baseURL
      // Probe with what the form shows RIGHT NOW, not what is stored: the
      // `apiKey` field is interrogation-only (the harness never stores it),
      // so a key just typed into the form reaches the /models probe without a
      // save. The clear flag means "no auth on the next probe".
      if (keyClear === false && keyDraft.length > 0) request.apiKey = keyDraft
      const result = await operations.discoverModels(SECTION_NS, request)
      if (result.kind === 'refused') {
        setDiscoverError(t('discoverError', { detail: result.message }))
        return
      }
      const found = result.models
      if (found.length === 0) {
        setDiscoverNote(t('discoverEmpty'))
        return
      }
      let added = 0
      let kept = 0
      const draft = page.draft.map(model => ({ ...model }))
      for (const hit of found) {
        const existing = draft.find(model => model.id === hit.id)
        if (existing !== undefined) {
          kept += 1
          continue
        }
        added += 1
        draft.push({
          key: newKey(),
          id: hit.id,
          name: hit.name ?? '',
          contextWindow: hit.contextWindow === undefined ? '' : String(hit.contextWindow),
          maxTokens: hit.maxTokens === undefined ? '' : String(hit.maxTokens),
          imageMaxPixels: '',
          imageMaxBytes: '',
          multimodal: false,
          preserveThinking: true,
          hasReasoning: false,
          efforts: [],
          defaultEffort: '',
          offMode: 'chat-template-kwargs',
        })
      }
      setPage({ ...page, draft })
      setSaved(false)
      setDiscoverNote(t('discoverOk', { count: found.length, added, kept }))
    } catch (error) {
      setDiscoverError(t('discoverError', { detail: error instanceof Error ? error.message : String(error) }))
    } finally {
      setDiscovering(false)
    }
  }, [operations, page, t, keyDraft, keyClear])

  const keyMode: KeyMode = keyClear ? 'clear' : keyDraft.length > 0 ? 'new' : 'keep'

  const onSave = useCallback(async () => {
    if (page === undefined) return
    setSaving(true)
    setSaveError(undefined)
    setSaved(false)
    try {
      // The credential write goes first: if it succeeds and the section write
      // then conflicts, the section still points at the old ref — never the
      // reverse (a section pointing at a missing credential).
      const ref = refFor(page.apiKeyEnv)
      if (keyClear) {
        const removed = await operations.removeCredential(ref)
        if (removed.kind === 'refused') throw new Error(removed.message)
        setKeyStored(false)
      } else if (keyDraft.length > 0) {
        const stored = await operations.storeCredential(ref, keyDraft)
        if (stored.kind === 'refused') throw new Error(stored.message)
        setKeyStored(true)
      }
      // One atomic section-root `set`, fenced at the revision the draft was
      // read at. The scope queues the write, folds the accepted answer into
      // the shared mirror (the subscription effect re-parses it), and reloads
      // the latest Host state after a refused write — so a stale fence shows
      // the fresh values instead of a dead draft.
      const section = wireSection(page, keyMode) as Record<string, JsonValue>
      const ok = await scope.mutate([{ op: 'set', path: [], value: section }], page.revision)
      if (!ok) {
        setSaveError(t('saveRefused'))
        return
      }
      setKeyDraft('')
      setKeyClear(false)
      setSaved(true)
    } catch (error) {
      setSaveError(t('saveError', { detail: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }, [scope, operations, page, t, keyDraft, keyMode])

  // A named ref with no stored credential resolves only through a
  // launch-environment variable of the same name — say so instead of letting
  // the endpoint answer 401 without explanation.
  const unresolvedRef = page !== undefined && keyMode === 'keep' && !keyStored && keyDraft.length === 0
  const effectiveRef = page !== undefined && page.apiKeyEnv.length > 0 ? page.apiKeyEnv : KEY_REF

  const hasAnyReasoning = useMemo(
    () => page?.draft.some(model => model.hasReasoning) ?? false,
    [page],
  )

  if (snap.status === 'loading') {
    return <p style={css.msgMuted}>{t('loading')}</p>
  }
  if (snap.status === 'unavailable') {
    return <p style={css.msgError}>{t('unavailable')}</p>
  }
  if (page === undefined) {
    return <p style={css.msgMuted}>{t('loading')}</p>
  }

  const readOnly = !page.writable

  // The Plugins page's built-in row chrome (RowDetail) already renders this
  // row's title, ids, and description above the form — so the page starts
  // straight with the body (the official companions render the form only).
  return (
    <div style={css.page}>
      {readOnly
        ? <p style={css.banner}>{t('readOnly')}</p>
        : null}

      <div style={css.field}>
        <span style={css.label}>{t('endpoint')}</span>
        <Input
          type="text"
          value={page.baseURL}
          placeholder={t('endpointPlaceholder')}
          aria-label={t('endpoint')}
          disabled={readOnly}
          onChange={event => { setPage({ ...page, baseURL: event.target.value }); setSaved(false) }}
        />
      </div>

      <div style={{ ...css.field, ...css.hairline }}>
        <div style={css.row}>
          <span style={css.label}>{t('keyInput')}</span>
          {keyStored || page.apiKeyEnv.length > 0
            ? (
              <Button
                size="sm"
                disabled={readOnly}
                onClick={() => { setKeyClear(true); setKeyDraft('') }}
              >
                {t('keyClear')}
              </Button>
            )
            : null}
        </div>
        <Input
          type="password"
          autoComplete="off"
          value={keyClear ? '' : keyDraft}
          placeholder={keyClear
            ? t('keyClearPending')
            : keyStored
              ? t('keyStoredPlaceholder')
              : t('keyNonePlaceholder')}
          aria-label={t('keyInput')}
          disabled={keyClear || readOnly}
          onChange={event => { setKeyDraft(event.target.value); setKeyClear(false) }}
        />
        {keyClear
          ? <span style={css.noteWarn}>{t('keyClearNote')}</span>
          : unresolvedRef
            ? <span style={css.noteWarn}>{t('keyUnresolved', { value: effectiveRef })}</span>
            : <span style={css.noteMuted}>{t('keyStoredWhere', { value: effectiveRef })}</span>}
      </div>

      <div style={{ ...css.field, ...css.hairline }}>
        <span style={css.label}>{t('models')}</span>
        {page.draft.map((model, index) => (
          <div key={model.key} style={css.card}>
            <div style={css.cardHead}>
              <span style={css.cardTitle}>{model.id.length > 0 ? model.id : `#${index + 1}`}</span>
              <Button
                size="sm"
                disabled={readOnly}
                onClick={() => {
                  setPage({ ...page, draft: page.draft.filter((_, i) => i !== index) })
                  setSaved(false)
                }}
              >
                {t('removeModel')}
              </Button>
            </div>
            <div style={css.row}>
              <div style={{ ...css.subField, flex: 1.2, minWidth: 140, flexBasis: 140 }}>
                <span style={css.label}>{t('modelId')}</span>
                <Input
                  type="text"
                  value={model.id}
                  placeholder={t('modelIdPlaceholder')}
                  aria-label={t('modelId')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { id: event.target.value })}
                />
              </div>
              <div style={{ ...css.subField, flex: 1.2, minWidth: 140, flexBasis: 140 }}>
                <span style={css.label}>{t('modelName')}</span>
                <Input
                  type="text"
                  value={model.name}
                  placeholder={t('modelNamePlaceholder')}
                  aria-label={t('modelName')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { name: event.target.value })}
                />
              </div>
            </div>
            <div style={css.row}>
              <div style={{ ...css.subField, flex: 1, minWidth: 110, flexBasis: 110 }}>
                <span style={css.label}>{t('contextWindow')}</span>
                <Input
                  type="number"
                  value={model.contextWindow}
                  aria-label={t('contextWindow')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { contextWindow: event.target.value })}
                />
              </div>
              <div style={{ ...css.subField, flex: 1, minWidth: 110, flexBasis: 110 }}>
                <span style={css.label}>{t('maxTokens')}</span>
                <Input
                  type="number"
                  value={model.maxTokens}
                  aria-label={t('maxTokens')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { maxTokens: event.target.value })}
                />
              </div>
            </div>
            <div style={css.row}>
              <div style={{ ...css.subField, flex: 1, minWidth: 96, flexBasis: 96 }}>
                <span style={css.label}>{t('imageMaxPixels')}</span>
                <Input
                  type="number"
                  value={model.imageMaxPixels}
                  aria-label={t('imageMaxPixels')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { imageMaxPixels: event.target.value })}
                />
              </div>
              <div style={{ ...css.subField, flex: 1, minWidth: 96, flexBasis: 96 }}>
                <span style={css.label}>{t('imageMaxBytes')}</span>
                <Input
                  type="number"
                  value={model.imageMaxBytes}
                  aria-label={t('imageMaxBytes')}
                  disabled={readOnly}
                  onChange={event => setModel(index, { imageMaxBytes: event.target.value })}
                />
              </div>
            </div>
            <div style={css.checks}>
              <Checkbox
                checked={model.multimodal}
                disabled={readOnly}
                label={t('multimodal')}
                onChange={checked => setModel(index, { multimodal: checked })}
              />
              <Checkbox
                checked={model.preserveThinking}
                disabled={readOnly}
                label={t('preserveThinking')}
                onChange={checked => setModel(index, { preserveThinking: checked })}
              />
            </div>

            {model.hasReasoning
              ? (
                <div style={{ ...css.subField, ...css.divider }}>
                  <div style={css.row}>
                    <span style={{ ...css.label, fontWeight: 600 }}>{t('reasoning')}</span>
                    <Button
                      size="sm"
                      disabled={readOnly}
                      onClick={() => setModel(index, { hasReasoning: false })}
                    >
                      {t('removeReasoning')}
                    </Button>
                  </div>
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <span style={{ ...css.label, ...css.effortColId }}>{t('effortId')}</span>
                    <span style={{ ...css.label, ...css.effortColName }}>{t('effortName')}</span>
                    <span style={{ ...css.label, ...css.effortColWire }}>{t('effortWire')}</span>
                    <span style={css.effortActionSlot} />
                  </div>
                  {model.efforts.map((effort, effortIndex) => (
                    <div key={effort.key} style={{ ...css.row, marginTop: 6 }}>
                      <div style={css.effortColId}>
                        <Input
                          type="text"
                          value={effort.id}
                          aria-label={t('effortId')}
                          disabled={readOnly}
                          onChange={event => setEffort(index, effortIndex, { id: event.target.value })}
                        />
                      </div>
                      <div style={css.effortColName}>
                        <Input
                          type="text"
                          value={effort.name}
                          placeholder={t('effortNamePlaceholder')}
                          aria-label={t('effortName')}
                          disabled={readOnly}
                          onChange={event => setEffort(index, effortIndex, { name: event.target.value })}
                        />
                      </div>
                      <div style={css.effortColWire}>
                        <Input
                          type="text"
                          value={effort.wire}
                          placeholder={t('effortWirePlaceholder')}
                          aria-label={t('effortWire')}
                          disabled={readOnly}
                          onChange={event => setEffort(index, effortIndex, { wire: event.target.value })}
                        />
                      </div>
                      <span style={css.effortActionSlot}>
                        <Button
                          size="sm"
                          disabled={readOnly}
                          onClick={() => setModel(index, { efforts: model.efforts.filter((_, i) => i !== effortIndex) })}
                        >
                          {t('removeEffort')}
                        </Button>
                      </span>
                    </div>
                  ))}
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <Button
                      size="sm"
                      disabled={readOnly}
                      onClick={() => setModel(index, { efforts: [...model.efforts, { key: newKey(), id: '', name: '', wire: '' }] })}
                    >
                      {t('addEffort')}
                    </Button>
                  </div>
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <div style={{ ...css.subField, width: 'fit-content' }}>
                      <span style={css.label}>{t('offMode')}</span>
                      <SegmentedControl
                        id={`off-mode-${model.key}`}
                        value={model.offMode}
                        label={t('offMode')}
                        disabled={readOnly}
                        options={[
                          { value: 'chat-template-kwargs', label: t('offModeKwargs') },
                          { value: 'omit', label: t('offModeOmit') },
                        ]}
                        onChange={value => setModel(index, { offMode: value })}
                      />
                    </div>
                  </div>
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <div style={{ ...css.subField, width: 150 }}>
                      <span style={css.label}>{t('defaultEffort')}</span>
                      <select
                        style={css.select}
                        value={model.defaultEffort}
                        aria-label={t('defaultEffort')}
                        disabled={readOnly}
                        onChange={event => setModel(index, { defaultEffort: event.target.value })}
                      >
                        <option value="">{t('defaultEffortUnset')}</option>
                        {model.efforts.map(effort => (
                          <option key={effort.id} value={effort.id}>{effort.id}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              )
              : (
                <div style={{ ...css.row, ...css.divider }}>
                  <span style={css.noteMuted}>{t('noReasoning')}</span>
                  <Button
                    size="sm"
                    disabled={readOnly}
                    onClick={() => setModel(index, {
                      hasReasoning: true,
                      efforts: [{ key: newKey(), id: 'off', name: '', wire: 'none' }],
                    })}
                  >
                    {t('addReasoning')}
                  </Button>
                </div>
              )}
          </div>
        ))}
        <Button
          disabled={readOnly}
          onClick={() => {
            setPage({
              ...page,
              draft: [...page.draft, {
                key: newKey(),
                id: '', name: '', contextWindow: '', maxTokens: '',
                imageMaxPixels: '', imageMaxBytes: '',
                multimodal: true, preserveThinking: true,
                hasReasoning: false, efforts: [], defaultEffort: '', offMode: 'chat-template-kwargs',
              }],
            })
            setSaved(false)
          }}
        >
          {t('addModel')}
        </Button>
      </div>

      <div style={{ ...css.footer, ...css.hairline }}>
        <Button
          disabled={discovering || page.baseURL.length === 0 || readOnly}
          onClick={() => { void onDiscover() }}
        >
          {discovering ? t('discovering') : t('discover')}
        </Button>
        <Button
          variant="primary"
          disabled={saving || readOnly}
          onClick={() => { void onSave() }}
        >
          {saving ? t('saving') : t('save')}
        </Button>
        {saved && saveError === undefined
          ? <span style={css.ok}>{t('saved')}</span>
          : null}
      </div>
      {saveError !== undefined
        ? <p style={css.msgError}>{saveError}</p>
        : null}
      {discoverNote !== undefined
        ? <p style={css.msgStatus}>{discoverNote}</p>
        : null}
      {discoverError !== undefined
        ? <p style={css.msgError}>{discoverError}</p>
        : null}
      {!hasAnyReasoning
        ? <p style={css.msgMuted}>{t('noReasoning')}</p>
        : null}
    </div>
  )
}
