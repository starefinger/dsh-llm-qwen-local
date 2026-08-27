# Design & Implementation Notes

[← Back to README](../README.md) · [Configuration reference](configuration.md)

Design rationale and implementation details for `dsh-llm-qwen-local`. User-facing installation and configuration guidance lives in the [README](../README.md); every configuration field is documented in the [configuration reference](configuration.md).

## Design highlights

### Per-model multimodal switch

`multimodal` is a **claim about your endpoint, not a check of it** — nothing interrogates vLLM for what it accepts. The semantics, including the asymmetric cost of over- vs under-claiming, are documented in the [configuration reference](configuration.md#the-multimodal-switch).

### Fully configurable reasoning efforts

Every selectable level, its display name, its `reasoning_effort` wire spelling, the default level, and how `off` is expressed on the wire all come from configuration, matching whatever vocabulary your vLLM build accepts. Details: [configuration reference](configuration.md#reasoning-efforts).

### One-generation call binding

Since the 0.1.1-rc.2 harness upgrade, the adapter overrides `LlmAdapter.prepareCall` to snapshot connection facts (endpoint, catalog, budgets) once and bind both model metadata and the eventual dispatch to that snapshot, so a settings commit between preparation and dispatch can never combine two configuration generations.

### Request-image pipeline

Image bytes go through the durable attachment service's `readImageRequest` projection (deterministic pixel/byte budgets, cached variants) when the mounted provider implements it, falling back to the normalized master bytes (`readImage`) for providers that refuse projection with `ATTACHMENT_PROJECTION_UNSUPPORTED`.

### Tool-result images are split, not refused (0.3.1)

The strict OpenAI placement the wire enforces is that `image_url` parts may ride a `user` message only — `role: 'tool'` content is text-only. So for a multimodal model, a tool result containing image parts serializes as a text-only `role: 'tool'` message (the tool's text survives the split; an image-only result gets a short caption) followed by a `role: 'user'` multimodal message carrying a caption and the image parts, in tool-result order — the QwenLM `qwen-code` `splitToolMedia` shape. This also **un-poisons history**: sessions whose log an older plugin build refused forever now serialize cleanly. A text-only model still refuses a tool-result image with `UNSUPPORTED_CONTENT` (direct-adapter defense; the runtime projects such images to placeholders first).

## Wire dialect (vLLM + Qwen3.8)

Request: `model`, `messages` (system first; multimodal user messages as `content` part arrays of `text` / `image_url` data-URL parts; tool results as `role: 'tool'`), `tools`, `stream: true`, `stream_options: { include_usage: true }`, plus `reasoning_effort` and `chat_template_kwargs` when they deviate from template defaults, `temperature`, `max_tokens`, `stop` when set.

Response: SSE `data:` payloads, `data: [DONE]` sentinel. `delta.reasoning_content` (and the `delta.reasoning` spelling some frameworks emit) → harness `reasoning` blocks (Qwen thinking channel); `delta.content` → `text` blocks; `delta.tool_calls` → `tool-call` blocks with raw-JSON `argumentsDelta`. `finish_reason`: `stop`/`content_filter` → `stop`, `length` → `max-tokens`, `tool_calls` → `tool-calls`, anything else → an `error` finish. Usage arrives attached to the finish chunk and/or as a trailing usage-only chunk; both are buffered and flushed after all `block-end`s and before `finish` (nothing is emitted after `finish`).

History replay: with `preserve_thinking` at its template default (ON), assistant reasoning is replayed as `reasoning_content` on tool-call-free turns — the exact reconstruction the official Qwen3.8 example performs; tool-call turns and `preserveThinking: false` models send no reasoning. Tool calls replay as `tool_calls` with `content: ""` (never `null`). Tool results serialize as text-only `role: 'tool'` messages; for a multimodal model, image parts inside a tool result are split into a follow-up `role: 'user'` multimodal message (caption + `image_url` parts).

## Model parameters (Qwen3.8-27B, verified against the model card)

| Fact | Value | Where it lands in this plugin |
|---|---|---|
| Architecture | `Qwen3_5ForConditionalGeneration` — **native vision-language model** (image + video) | baseline `multimodal: true` |
| Context length | **262,144 native**, extensible to ~1M via YaRN / `--max-model-len` | `DEFAULT_CONTEXT_WINDOW = 262144`; raise `contextWindow` per model when your vLLM runs 1M |
| Thinking default | **ON**; disable per request with `chat_template_kwargs: { enable_thinking: false }` | `off` level (wire `none`) + `offMode: chat-template-kwargs` (default) |
| `reasoning_effort` levels | **`xhigh` (default), `medium`, `low`** (vLLM accepts `none` / `minimal` / `low` / `medium` / `high` / `xhigh`; `off` is a 400) | baseline `efforts` (`off` → `wire: none`) + `defaultEffort: xhigh` |
| `preserve_thinking` | **ON by default**; retains historical thinking blocks | reasoning replay as `reasoning_content`; `preserveThinking: false` sends the kwarg |
| Recommended sampling | thinking: `temperature=1.0, top_p=0.95, top_k=20`; non-thinking: `temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5` | only `temperature` is harness-exposable; the rest rides your deployment defaults (vLLM's generation defaults match the thinking set) |
| Recommended output budget | reasoning 262,144 / final 131,072 when split limits are available on a 1M context | `maxTokens` per model / per request |
| Images | `image_url` parts (URL or data URL) | `multimodal: true` path (data URL inlined) |
| Video | `video_url` parts | not supported — the harness has no video content block |

## Framework compatibility

Every wire field the adapter sends or reads, and where it comes from:

| Field | Origin | vLLM | SGLang | llama.cpp / Ollama |
|---|---|---|---|---|
| `model`/`messages`/`stream`/`stream_options` | OpenAI standard | yes | yes | yes |
| `temperature`/`max_tokens`/`stop` | OpenAI standard | yes | yes | yes |
| `tools`/`tool_calls` | OpenAI standard | yes | yes | yes |
| `image_url` (data URL, request-projected) | OpenAI standard | yes | yes | VL builds |
| `reasoning_effort` | OpenAI-family, documented by Qwen | yes | yes | no (ignored or 400) |
| `chat_template_kwargs` | **vLLM extension** | yes | yes | no |
| `delta.reasoning_content` (+ `reasoning` fallback) | Qwen template dialect, not framework-bound | `--reasoning-parser qwen3` | Qwen3 parser | `--reasoning-format deepseek` |
| `usage` (detail fields optional) | OpenAI standard | yes | yes | tolerated when absent |

The only vLLM-specific extension is `chat_template_kwargs`, and it appears in exactly two configurable places: `offMode: chat-template-kwargs` and `preserveThinking: false`. Everything else is OpenAI-standard or **Qwen template-level** (`enable_thinking`, `preserve_thinking`, the `reasoning_content` channel are the model's chat-template vocabulary, so any framework that implements the Qwen3.8 template correctly understands them).

- **vLLM** — full compatibility; the default config is written for it.
- **SGLang** — the default config should work as-is (it supports `chat_template_kwargs.enable_thinking` and reasoning effort); launch with the equivalent reasoning-parser flags.
- **llama.cpp / Ollama** — partial: the standard path (text/tools/images) works. `chat_template_kwargs` is not understood → set `offMode: omit` (`off` then only omits the parameter; thinking cannot be disabled per request). `reasoning_effort` is not understood → declare no `reasoning` block. Thinking streams are separable only when the server emits `reasoning_content` (llama.cpp: `--reasoning-format deepseek`).
- **DashScope / Qwen Cloud** — not supported: its OpenAI-compatible endpoint takes `enable_thinking` as a **top-level** parameter, not inside `chat_template_kwargs`, and this adapter has no knob for top-level template variables. A per-effort extra-params design would be needed; out of scope for v1 (the adapter targets local OpenAI-compatible servers).

## Frontend configuration (web Models page / settings)

Frontend configuration is split across two faces: a **node half** that wires the four hooks DSH's configuration surfaces consume (the same ones `llm-deepseek` and `llm-pi-ai` use) and a **client half** that renders the editable page.

Node half (the configuration surface the host exposes):

- **Settings section** — the plugin's `Config` schema is installed as the `llm-qwen-local` user-settings section (`installSettingsSection`). This makes the section the host's single fact source: it is readable and writable through the settings RPC (`settings.describe` / `settings.replace`) and `settings.yaml`. Commits switch the configuration source **live** — the adapter re-resolves per request, so a saved change reaches the next model call without a restart. Unserviceable sections are refused where they are written. This half alone does *not* paint a page — the web settings modal renders only pages a client plugin registers into the `settings.section` slot.
- **Configurable-provider directory** — the `qwen-local` route is registered via `registerConfigurableProviders`, so the web Models page lists it as a row (live or dormant). Its namespace is also what makes the settings RPC expose `llm-qwen-local` to configuration clients.
- **Model discovery** — `registerModelDiscovery` answers `llm.discoverModels`: a draft naming a `baseURL` triggers a `GET {baseURL}/models` probe (the draft's one-off key, else the route's stored credential, else unauthenticated); a draft naming the route but no endpoint is answered from the configured catalog with no network call.
- **Credentials** — the section's `apiKeyEnv` field is a *name* (a credential ref or an environment-variable name), never a key value. The adapter resolves it through the durable credentials service first (what the web Models page writes keys into), then the launch environment. A miss fails loud with `MISSING_CREDENTIAL` rather than letting the deployment pick up an unrelated ambient key — and an unresolvable name means the discovery probe falls back to unauthenticated, which an auth-protected vLLM answers with `401`.

Client half (the page you actually edit):

- `src/client` is a **client plugin** (declared under `dsh.client`, exported as `./client`, built to a module-table bundle `lib/client.js`). It registers a `Qwen 本地 (vLLM)` page into the settings modal's `settings.section` slot and renders one form over the `llm-qwen-local` section: `baseURL`, the route-level `maxRequestImageBytes`, an **API Key** field, the model list (id / name / capacities / image budgets / multimodal / `preserveThinking` / reasoning efforts), a **Discover models** button (probes the draft endpoint via `llm.discoverModels` and merges the ids), and **Save** (writes the whole section via `settings.replace`). The host validates the draft against the schema and answers the redacted value back; a schema violation is surfaced inline. Copy is bilingual (zh/en) through the DSH locale registry, and the page refetches on `settings/document-updated` so two open surfaces converge.
  - The **API Key** field follows the core Models-page convention: the value is written to the durable credentials service under the provider's derived ref `QWEN_LOCAL_API_KEY` (via `credentials.set`), and the section's `apiKeyEnv` records that ref name — the raw key never lands in `settings.yaml`. Leaving the field empty keeps the current key (or sends no `Authorization` header when none is stored); a **Clear** button removes the stored credential and the reference. If the section already names a ref this page does not manage (e.g. a pasted raw key), the form flags it, since the adapter cannot resolve it and the endpoint would keep answering `401`.
- The bundle requires only the platform `react` / `react/jsx-runtime` modules — every DSH type import is type-only and erased, and all services arrive through the injected `slots` / `locale` / `connection` / `remote` faces. `pnpm build` typechecks both halves and emits `lib/client.js` alongside `lib/`.

Scope note: the Models page's *curated* per-family editor cards (the baseURL/key/model-catalog forms) are hand-written in the `ui-settings-models` client package for the `llm-deepseek` and `llm-pi-ai` namespaces only. A route outside those families is listed on the Models page but renders the generic "edit the rest in settings.yaml" hint — the Models page has no slot for a third-party editor card. The editable surface this plugin ships is therefore the dedicated **settings page**, not a Models-page card. A dedicated Models card would be a `ui-settings-models` core contribution, not a plugin-side change.

## Error paths

- **Thrown from `stream()`** (transport/protocol failures): fetch failure or `TRANSPORT`; non-2xx mapped to `AUTH`/`RATE_LIMIT`/`INVALID_REQUEST`/`SERVER`/`HTTP_<n>` (with `status`, `retry-after`, request id when present); malformed SSE payload `MALFORMED_RESPONSE`; truncation without `[DONE]` `STREAM_CLOSED`; idle timeout `TIMEOUT`; caller abort `ABORTED`; image/content gates `UNSUPPORTED_CONTENT` (direct-adapter use only — the runtime projects images for text-only models first); unknown effort `UNSUPPORTED_REASONING_EFFORT`; a named `apiKeyEnv` that resolves nowhere `MISSING_CREDENTIAL` (before any network I/O). A request-image projection failure other than the unsupported-capability refusal propagates as the attachment error.
- **In-band provider failure**: an SSE payload carrying an `error` object closes open blocks and ends the stream with `finish {kind: 'error', failure: {code: 'PROVIDER_ERROR'}}`.
- A completed response with no content maps to an `EMPTY_RESPONSE` error finish.

Every provider request carries the harness `attributionHeaders()`; `options.signal` is honored through fetch and body reads.

## Known Limitations and Deferred Work

- **A modality declaration is not verified** — `multimodal: true` on a text-only endpoint fails mid-turn after the image message is durable (recovery: new session / fork / other model). The reverse direction is now **silent**: `multimodal: false` on a vision endpoint makes the runtime project images into text placeholders, so the model answers without seeing them (flip the switch and re-ask).
- **Request-image projection is provider-dependent** — when the mounted attachment provider cannot derive request images (`ATTACHMENT_PROJECTION_UNSUPPORTED`), the adapter falls back to the normalized master bytes, so `imageMaxPixels`/`imageMaxBytes` become advisory for that deployment.
- **Tool-result images ride a follow-up user message** — the vLLM wire's `role: 'tool'` content is text-only, so for a multimodal model an image inside a tool result is split: the tool message keeps its text and the image part(s) re-emerge in a `role: 'user'` multimodal message directly after it (caption: "Images returned by the tool call above are attached."). A text-only model still refuses a tool-result image with `UNSUPPORTED_CONTENT` (direct-adapter defense; the runtime projects such images to placeholders first).
- **No `replayState`** — the endpoint is stateless and history replays cleanly from recorded blocks (reasoning included, via `preserve_thinking`), so the adapter emits no adapter-private replay metadata.
- **No per-route retry policy** — v1 has no `retryPolicy` config; the harness normal defaults apply.
- **Thinking replay is tool-call-turn-free only** — reasoning is replayed as `reasoning_content` only on assistant turns with no tool calls (the official Qwen3.8 example's shape); a deployment that wants thinking retained across tool-call turns needs a template-level change.
- **Video input is unsupported** — Qwen3.8-27B accepts `video_url` parts, but the harness has no video content block, so only `image` is wired; a deployment that needs video would need a new harness content block plus a `video_url` serializer path.
- **Assistant-side images are rejected** — the harness image block is user-content-only in practice; assistant/system image content is refused rather than silently erased (tool-result images on a multimodal model take the split path above instead).

## What this plugin does not claim

- It is not an official DeepSeek or Qwen/Alibaba product and does not imply endorsement.
- It does not interrogate the vLLM endpoint — `multimodal`, context capacity, and reasoning levels are **claims about your deployment**, and a wrong claim costs a mid-turn refusal (or, for under-claimed vision, a silent text-only projection) rather than a negotiated capability.
- It does not support DashScope / Qwen Cloud or any non-OpenAI-compatible Qwen endpoint; the target is a local vLLM (or compatible) server.
- It does not extend image understanding to video, audio, PDF, or image generation.
- It does not replace DSH's session log, attachment pipeline, or model selector; it contributes one LLM route, one settings section, and one settings page.
