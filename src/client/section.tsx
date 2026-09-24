/**
 * The Qwen (local, vLLM) settings page: one form over the plugin's
 * `llm-qwen-local` settings section. The host owns the section through the
 * settings seam; this surface reads the resolved value, edits a local draft,
 * and saves it back with `settings.replace` (the seam validates against the
 * schema and answers a redacted view). The API key follows the core Models
 * page convention: the value never enters the settings section — it is
 * written to the durable credentials service under the provider's derived
 * ref (`QWEN_LOCAL_API_KEY`), and the section's `apiKeyEnv` field records
 * that ref name for the adapter's resolver. Model discovery probes the
 * draft's endpoint through `llm.discoverModels` and merges the ids into the
 * draft. The form also edits the request-image budgets introduced by the
 * 0.1.1-rc.2 harness upgrade: the per-model pixel/byte projection budgets.
 * There is no route-level total image cap in this plugin — every image is
 * inlined once it fits its per-image budget, and a request too large for the
 * endpoint is the endpoint's to refuse (the backend LLM service's own input
 * limits apply).
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
import type { LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-api-remotes/client'
import type { QwenLocalOperations } from './operations.ts'
import type { LocaleKey } from './locales.ts'

/** The settings namespace this page edits (mirrors the node-side NS). */
export const SECTION_NS = 'llm-qwen-local'

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
  revision: number
  draft: ModelDraft[]
  baseURL: string
  /** The loaded section's `apiKeyEnv` value (a ref or env-var name). */
  apiKeyEnv: string
  /** Pass-through fields the form does not render (idle timeout, defaults). */
  passthrough: Record<string, unknown>
}

type T = (key: LocaleKey, vars?: Record<string, string | number>) => string

const css = {
  page: {
    display: 'flex', flexDirection: 'column' as const, gap: 16,
    maxWidth: 720, padding: '8px 0', fontFamily: 'inherit',
  },
  h1: { margin: 0, fontSize: 16, fontWeight: 600 },
  sub: { margin: 0, fontSize: 12, opacity: 0.7 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: 4 },
  label: { fontSize: 12, opacity: 0.8 },
  input: {
    boxSizing: 'border-box', width: '100%', padding: '6px 8px',
    fontSize: 13, fontFamily: 'inherit',
    background: 'rgba(127,127,127,0.08)', color: 'inherit',
    border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
  },
  row: { display: 'flex', gap: 8, flexWrap: 'wrap' as const, alignItems: 'center' },
  card: {
    border: '1px solid rgba(127,127,127,0.35)', borderRadius: 8,
    padding: 12, display: 'flex', flexDirection: 'column' as const, gap: 8,
  },
  cardHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 13, fontWeight: 600, fontFamily: 'ui-monospace, Menlo, monospace' },
  button: {
    padding: '5px 10px', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer',
    background: 'rgba(127,127,127,0.12)', color: 'inherit',
    border: '1px solid rgba(127,127,127,0.35)', borderRadius: 6,
  },
  primary: {
    padding: '6px 14px', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
    background: 'rgba(90,140,255,0.22)', color: 'inherit',
    border: '1px solid rgba(90,140,255,0.55)', borderRadius: 6,
  },
  danger: { opacity: 0.75 },
  status: { fontSize: 12 },
  error: { fontSize: 12, color: '#f2a1a1' },
  ok: { fontSize: 12, color: '#a1f2b1' },
  warn: { fontSize: 12, color: '#f2d9a1' },
  muted: { fontSize: 12, opacity: 0.6 },
  checks: { display: 'flex', gap: 16, fontSize: 12 },
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

/** Parse the resolved section value into page state, segregating passthrough. */
function parsePage(value: unknown, revision: number): PageState {
  const record = field(value)
  const { baseURL: _baseURL, apiKeyEnv: _apiKeyEnv, models: _models, ...rest } = record
  return {
    revision,
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
 * Serialize the draft into the section value for `settings.replace`. The
 * `apiKeyEnv` the section carries: the managed ref after a key store, absent
 * after a clear, the loaded value untouched otherwise.
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

export interface QwenLocalSectionProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
  /** The bound Host operations (settings/credentials/llm remote namespaces). */
  operations: QwenLocalOperations
  /** The settings namespace this page edits. */
  sectionNs: string
  /** The pushed-invalidation channel (settings/credentials document commits). */
  remote: RemoteEvents
  /** Registrant-localized translate. */
  t: T
}

/** The pushed-invalidation channel the page listens on (structural subset). */
export interface RemoteEvents {
  $on(event: string, handler: (...args: unknown[]) => void): () => void
}

/** The Qwen (local) settings page body. */
export function QwenLocalSection({ operations, sectionNs, remote, t }: QwenLocalSectionProps): JSX.Element {
  const [page, setPage] = useState<PageState | undefined>()
  const [loadError, setLoadError] = useState<string | undefined>()
  const [missing, setMissing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  const [discovering, setDiscovering] = useState(false)
  const [discoverNote, setDiscoverNote] = useState<string | undefined>()
  const [discoverError, setDiscoverError] = useState<string | undefined>()
  // API key: the value only crosses the wire in one direction (set/unset);
  // the page never reads it back — only whether one is stored under KEY_REF.
  const [keyDraft, setKeyDraft] = useState('')
  const [keyStored, setKeyStored] = useState(false)
  const [keyClear, setKeyClear] = useState(false)

  const load = useCallback(async () => {
    setLoadError(undefined)
    setMissing(false)
    try {
      const described = await operations.describeSection(sectionNs)
      if (described.kind === 'refused') {
        setLoadError(described.message)
        setPage(undefined)
        return
      }
      if (described.kind === 'missing') {
        setMissing(true)
        setPage(undefined)
        return
      }
      const view = described.view
      const parsed = parsePage(view.value, view.revision)
      setPage(parsed)
      const ref = refFor(parsed.apiKeyEnv)
      const info = await operations.describeCredential(ref)
      setKeyStored(info !== undefined && info.configured)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
      setPage(undefined)
    }
  }, [operations, sectionNs])

  useEffect(() => {
    void load()
  }, [load])

  // Pushed invalidation: any committed settings change refetches the section
  // so two open surfaces converge without polling.
  useEffect(() => {
    const disposers = [
      remote.$on('settings/document-updated', () => { void load() }),
      remote.$on('credentials/reference-updated', () => { void load() }),
    ]
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, [remote, load])

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
      const result = await operations.discoverModels(sectionNs, request)
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
  }, [operations, sectionNs, page, t, keyDraft, keyClear])

  const keyMode: KeyMode = keyClear ? 'clear' : keyDraft.length > 0 ? 'new' : 'keep'

  const onSave = useCallback(async () => {
    if (page === undefined) return
    setSaving(true)
    setSaveError(undefined)
    setSaved(false)
    try {
      // The effective ref is the section's named one (or the derived default);
      // the credential write goes first: if it succeeds and the settings
      // replace then conflicts, the section still points at the old ref —
      // never the reverse (a section pointing at a missing credential).
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
      const written = await operations.replaceSection(sectionNs, wireSection(page, keyMode), page.revision)
      if (written.kind === 'conflict') {
        setSaveError(t('saveError', { detail: written.message }))
        return
      }
      if (written.kind === 'refused') throw new Error(written.message)
      setPage(parsePage(written.view.value, written.view.revision))
      setKeyDraft('')
      setKeyClear(false)
      setSaved(true)
    } catch (error) {
      setSaveError(t('saveError', { detail: error instanceof Error ? error.message : String(error) }))
    } finally {
      setSaving(false)
    }
  }, [operations, sectionNs, page, t, keyDraft, keyMode])

  // The ref the key operations target: the section's named one, else the
  // derived default (the core `refFor` convention).
  const effectiveRef = page?.apiKeyEnv !== undefined && page.apiKeyEnv.length > 0
    ? page.apiKeyEnv
    : KEY_REF
  // A named ref with no stored credential resolves only through a
  // launch-environment variable of the same name — say so instead of letting
  // the endpoint answer 401 without explanation.
  const unresolvedRef = keyMode === 'keep' && !keyStored && keyDraft.length === 0

  const hasAnyReasoning = useMemo(
    () => page?.draft.some(model => model.hasReasoning) ?? false,
    [page],
  )

  if (loadError !== undefined) {
    return <p style={css.error}>{t('loadError', { detail: loadError })}</p>
  }
  if (missing) {
    return <p style={css.error}>{t('notMounted')}</p>
  }
  if (page === undefined) {
    return <p style={css.muted}>{t('loading')}</p>
  }

  return (
    <div style={css.page}>
      <div>
        <h1 style={css.h1}>{t('title')}</h1>
        <p style={css.sub}>{t('subtitle')}</p>
      </div>

      <div style={css.field}>
        <span style={css.label}>{t('endpoint')}</span>
        <input
          style={css.input}
          type="text"
          value={page.baseURL}
          placeholder={t('endpointPlaceholder')}
          aria-label={t('endpoint')}
          onChange={event => { setPage({ ...page, baseURL: event.target.value }); setSaved(false) }}
        />
      </div>

      <div style={css.field}>
        <div style={css.row}>
          <span style={css.label}>{t('keyInput')}</span>
          {keyStored || page.apiKeyEnv.length > 0
            ? (
              <button
                style={{ ...css.button, ...css.danger }}
                type="button"
                onClick={() => { setKeyClear(true); setKeyDraft('') }}
              >
                {t('keyClear')}
              </button>
            )
            : null}
        </div>
        <input
          style={css.input}
          type="password"
          autoComplete="off"
          value={keyClear ? '' : keyDraft}
          placeholder={keyClear
            ? t('keyClearPending')
            : keyStored
              ? t('keyStoredPlaceholder')
              : t('keyNonePlaceholder')}
          aria-label={t('keyInput')}
          disabled={keyClear}
          onChange={event => { setKeyDraft(event.target.value); setKeyClear(false) }}
        />
        {keyClear
          ? <span style={css.warn}>{t('keyClearNote')}</span>
          : unresolvedRef
            ? <span style={css.warn}>{t('keyUnresolved', { value: effectiveRef })}</span>
            : <span style={css.muted}>{t('keyStoredWhere', { value: effectiveRef })}</span>}
      </div>

      <div style={css.field}>
        <span style={css.label}>{t('models')}</span>
        {page.draft.map((model, index) => (
          <div key={model.key} style={css.card}>
            <div style={css.cardHead}>
              <span style={css.cardTitle}>{model.id.length > 0 ? model.id : `#${index + 1}`}</span>
              <button
                style={{ ...css.button, ...css.danger }}
                type="button"
                onClick={() => {
                  setPage({ ...page, draft: page.draft.filter((_, i) => i !== index) })
                  setSaved(false)
                }}
              >
                {t('removeModel')}
              </button>
            </div>
            <div style={css.row}>
              <div style={{ ...css.field, flex: 2, minWidth: 160 }}>
                <span style={css.label}>{t('modelId')}</span>
                <input
                  style={css.input}
                  type="text"
                  value={model.id}
                  placeholder={t('modelIdPlaceholder')}
                  aria-label={t('modelId')}
                  onChange={event => setModel(index, { id: event.target.value })}
                />
              </div>
              <div style={{ ...css.field, flex: 2, minWidth: 120 }}>
                <span style={css.label}>{t('modelName')}</span>
                <input
                  style={css.input}
                  type="text"
                  value={model.name}
                  placeholder={t('modelNamePlaceholder')}
                  aria-label={t('modelName')}
                  onChange={event => setModel(index, { name: event.target.value })}
                />
              </div>
              <div style={{ ...css.field, width: 120 }}>
                <span style={css.label}>{t('contextWindow')}</span>
                <input
                  style={css.input}
                  type="number"
                  value={model.contextWindow}
                  aria-label={t('contextWindow')}
                  onChange={event => setModel(index, { contextWindow: event.target.value })}
                />
              </div>
              <div style={{ ...css.field, width: 120 }}>
                <span style={css.label}>{t('maxTokens')}</span>
                <input
                  style={css.input}
                  type="number"
                  value={model.maxTokens}
                  aria-label={t('maxTokens')}
                  onChange={event => setModel(index, { maxTokens: event.target.value })}
                />
              </div>
              <div style={{ ...css.field, width: 120 }}>
                <span style={css.label}>{t('imageMaxPixels')}</span>
                <input
                  style={css.input}
                  type="number"
                  value={model.imageMaxPixels}
                  aria-label={t('imageMaxPixels')}
                  onChange={event => setModel(index, { imageMaxPixels: event.target.value })}
                />
              </div>
              <div style={{ ...css.field, width: 120 }}>
                <span style={css.label}>{t('imageMaxBytes')}</span>
                <input
                  style={css.input}
                  type="number"
                  value={model.imageMaxBytes}
                  aria-label={t('imageMaxBytes')}
                  onChange={event => setModel(index, { imageMaxBytes: event.target.value })}
                />
              </div>
            </div>
            <div style={css.checks}>
              <label>
                <input
                  type="checkbox"
                  checked={model.multimodal}
                  onChange={event => setModel(index, { multimodal: event.target.checked })}
                />{' '}
                {t('multimodal')}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={model.preserveThinking}
                  onChange={event => setModel(index, { preserveThinking: event.target.checked })}
                />{' '}
                {t('preserveThinking')}
              </label>
            </div>

            {model.hasReasoning
              ? (
                <div style={{ ...css.field, borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: 8 }}>
                  <div style={css.row}>
                    <span style={{ ...css.label, fontWeight: 600 }}>{t('reasoning')}</span>
                    <button
                      style={{ ...css.button, ...css.danger }}
                      type="button"
                      onClick={() => setModel(index, { hasReasoning: false })}
                    >
                      {t('removeReasoning')}
                    </button>
                  </div>
                  {model.efforts.map((effort, effortIndex) => (
                    <div key={effort.key} style={{ ...css.row, marginTop: 6 }}>
                      <div style={{ ...css.field, width: 120 }}>
                        <span style={css.label}>{t('effortId')}</span>
                        <input
                          style={css.input}
                          type="text"
                          value={effort.id}
                          aria-label={t('effortId')}
                          onChange={event => setEffort(index, effortIndex, { id: event.target.value })}
                        />
                      </div>
                      <div style={{ ...css.field, flex: 1, minWidth: 100 }}>
                        <span style={css.label}>{t('effortName')}</span>
                        <input
                          style={css.input}
                          type="text"
                          value={effort.name}
                          placeholder={t('effortNamePlaceholder')}
                          aria-label={t('effortName')}
                          onChange={event => setEffort(index, effortIndex, { name: event.target.value })}
                        />
                      </div>
                      <div style={{ ...css.field, flex: 1, minWidth: 120 }}>
                        <span style={css.label}>{t('effortWire')}</span>
                        <input
                          style={css.input}
                          type="text"
                          value={effort.wire}
                          placeholder={t('effortWirePlaceholder')}
                          aria-label={t('effortWire')}
                          onChange={event => setEffort(index, effortIndex, { wire: event.target.value })}
                        />
                      </div>
                      <button
                        style={{ ...css.button, ...css.danger }}
                        type="button"
                        onClick={() => setModel(index, { efforts: model.efforts.filter((_, i) => i !== effortIndex) })}
                      >
                        {t('removeEffort')}
                      </button>
                    </div>
                  ))}
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <button
                      style={css.button}
                      type="button"
                      onClick={() => setModel(index, { efforts: [...model.efforts, { key: newKey(), id: '', name: '', wire: '' }] })}
                    >
                      {t('addEffort')}
                    </button>
                  </div>
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <div style={{ ...css.field, width: 240 }}>
                      <span style={css.label}>{t('offMode')}</span>
                      <select
                        style={css.input}
                        value={model.offMode}
                        aria-label={t('offMode')}
                        onChange={event => setModel(index, { offMode: event.target.value })}
                      >
                        <option value="chat-template-kwargs">{t('offModeKwargs')}</option>
                        <option value="omit">{t('offModeOmit')}</option>
                      </select>
                    </div>
                  </div>
                  <div style={{ ...css.row, marginTop: 6 }}>
                    <div style={{ ...css.field, width: 150 }}>
                      <span style={css.label}>{t('defaultEffort')}</span>
                      <select
                        style={css.input}
                        value={model.defaultEffort}
                        aria-label={t('defaultEffort')}
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
                <div style={{ ...css.row, borderTop: '1px solid rgba(127,127,127,0.25)', paddingTop: 8 }}>
                  <span style={css.muted}>{t('noReasoning')}</span>
                  <button
                    style={css.button}
                    type="button"
                    onClick={() => setModel(index, {
                      hasReasoning: true,
                      efforts: [{ key: newKey(), id: 'off', name: '', wire: 'none' }],
                    })}
                  >
                    {t('addReasoning')}
                  </button>
                </div>
              )}
          </div>
        ))}
        <button
          style={css.button}
          type="button"
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
        </button>
      </div>

      <div style={css.row}>
        <button
          style={css.button}
          type="button"
          disabled={discovering || page.baseURL.length === 0}
          onClick={() => { void onDiscover() }}
        >
          {discovering ? t('discovering') : t('discover')}
        </button>
        <button
          style={css.primary}
          type="button"
          disabled={saving}
          onClick={() => { void onSave() }}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {saved && saveError === undefined
          ? <span style={css.ok}>{t('saved')}</span>
          : null}
      </div>
      {saveError !== undefined
        ? <p style={css.error}>{saveError}</p>
        : null}
      {discoverNote !== undefined
        ? <p style={css.status}>{discoverNote}</p>
        : null}
      {discoverError !== undefined
        ? <p style={css.error}>{discoverError}</p>
        : null}
      {!hasAnyReasoning
        ? <p style={css.muted}>{t('noReasoning')}</p>
        : null}
    </div>
  )
}
