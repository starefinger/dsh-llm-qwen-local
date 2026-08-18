# dsh-llm-qwen-local

DeepSeek Harness LLM adapter plugin for a **locally deployed Qwen model** (e.g. Qwen3.8) served by **vLLM** behind its OpenAI-compatible `/v1/chat/completions` endpoint.

Two deployment-specific knobs are first-class:

- **Per-model multimodal switch** (`multimodal: true/false`) — declares whether the deployment serves the model with vision.
- **Fully configurable reasoning efforts** — every selectable level, its display name, its `reasoning_effort` wire spelling, the default level, and how `off` is expressed on the wire all come from configuration, matching whatever vocabulary your vLLM build accepts.

```yaml
- id: llm-qwen-local
  name: dsh-llm-qwen-local
  config:
    baseURL: http://127.0.0.1:8000/v1
    models:
      - id: qwen3.8
        name: Qwen3.8 (local)
        multimodal: true
        reasoning:
          efforts:
            - { id: off, wire: null }
            - { id: low, wire: low }
            - { id: medium, wire: medium }
            - { id: xhigh, wire: xhigh }
          defaultEffort: xhigh
```

## Requirements

- An installed `dsh` (the CLI), and a vLLM instance serving your Qwen model with the OpenAI-compatible API.
- Node.js with global `fetch` (18+).

## Install

```sh
# from the directory containing this checkout (build first):
pnpm install && pnpm build

# install into a profile (creates the profile on first use):
dsh plugin --profile demo add ./path/to/qwen3.8-LLM-plugin

# verify the contributed layer, then start:
dsh --profile demo --dump-config
dsh --profile demo
```

The bundle's `cordis.patch.yml` inserts a baseline `llm-qwen-local` line (model `qwen3.8`, text-only, `off/low/medium/high` efforts, default `high`). Select the model in the Web UI's model selector once installed; the adapter advertises it through `listModels()`.

To change anything, override the line from your profile's `cordis.patch.yml` by `id: llm-qwen-local` — a patch replaces the target line's **entire** `config` (no deep merge), so restate every key you keep.

## Configuration reference

All fields except `models` are optional in `cordis.yml`; schema defaults fill the rest.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8000/v1` | Endpoint base; `/chat/completions` is appended. |
| `apiKeyEnv` | — (no auth header) | Environment-variable name holding an optional bearer token, read per request. Absent/unset/blank = no `Authorization` header. |
| `models` | **required** | At least one model entry. |
| `defaultContextWindow` | `262144` | Context capacity used when a model has no exact value. |
| `maxTokens` | `32768` | Per-request output cap fallback; explicit request values and a model's own cap win. |
| `streamIdleTimeoutMs` | `300000` | Maximum provider idle time while one stream read is outstanding. |

### Model entries

| Field | Default | Meaning |
|---|---|---|
| `id` | **required** | Wire model id vLLM accepts. |
| `name` | `id` | Selector label. |
| `description` | — | Selector detail for similar variants. |
| `contextWindow` | route default | This model's combined request/response capacity. |
| `maxTokens` | route default | This model's per-request output cap. |
| `multimodal` | `false` | The vision switch (below). Qwen3.8-27B is a native vision-language model — set `true` for it. |
| `preserveThinking` | `true` | Whether the deployment keeps historical thinking blocks (Qwen3.8's `preserve_thinking`, template default on). `false` sends `chat_template_kwargs: { preserve_thinking: false }` and the adapter stops replaying assistant reasoning into history. |
| `reasoning` | — | Reasoning capability; absent = the model exposes no selectable efforts. |

### The multimodal switch

`multimodal` is a **claim about your endpoint, not a check of it** — nothing interrogates vLLM for what it accepts:

- `false` (default): the model is advertised text-only (`inputModalities: ['text']`). The harness refuses images **before send** (naming the model), and the adapter refuses again at serialization time (`UNSUPPORTED_CONTENT`) — the second gate covers sessions that attached images before the switch was turned off.
- `true`: the model is advertised with `['text', 'image']`. Image bytes are resolved through the durable attachment service (`ctx.attachments`); a composition without that service refuses any image with `UNSUPPORTED_CONTENT` instead of guessing a source.

The two wrong answers do not cost the same: under-claiming costs a refusal before the request goes out; over-claiming admits an image the provider then rejects **mid-turn**, after the message is durable in the session log — that session will keep re-sending the failing image. Recovery is a new session, a fork before the image, or a different model; rolling an unconsumed image message back out of a failed send is deferred.

Images are inlined as `image_url` parts with `data:<mediaType>;base64,…` values.

### Reasoning efforts

```yaml
reasoning:
  efforts:
    - { id: off, wire: null }      # the one level allowed to send nothing
    - { id: low, wire: low }       # any wire spelling your vLLM accepts
    - { id: high, wire: high }
  defaultEffort: high              # optional; absent = vLLM's own default
  offMode: chat-template-kwargs    # optional; 'chat-template-kwargs' | 'omit'
```

- **Qwen3.8-27B's official levels**: `xhigh` (the model's default), `medium`, `low` — the bundle baseline declares exactly these plus `off`. Thinking is ON by default, so omitting the parameter entirely (no `defaultEffort`, or `offMode: omit` without an effort) keeps the deployment's thinking default.
- `efforts` (required, display order) — the authoritative selectable list. Each `id` is an opaque value the harness carries per request; `name` (default `id`) is what selectors show. A level not declared is not offered. `id` is unique per model. The `off` level is **optional**: it is the adapter's own "no thinking" selector, not a wire value (selecting it sends no `reasoning_effort` at all). Omit it for a deployment with no way to disable thinking — then effort selection can never turn thinking off, and `session-title` calls keep the ordinary default instead of forcing `off`.
- `wire` — the exact spelling sent as `reasoning_effort`. Only `off` may use `null` (send nothing); every other level must name a non-empty wire value. Rename freely (`{ id: max, wire: high }`) — the harness never sees wire spellings.
- `defaultEffort` — materialized into requests when the caller omits an effort. Absent preserves vLLM's own default.
- `offMode` — how `off` is expressed beyond omitting `reasoning_effort`:
  - `chat-template-kwargs` (default): also sends `chat_template_kwargs: { enable_thinking: false }` — the model's documented non-thinking mode (thinking is ON by default, so omitting the parameter alone keeps it on).
  - `omit`: sends nothing extra — use for deployments where absence of `reasoning_effort` already means no thinking.
- Per-request selection takes precedence over `defaultEffort`. A request naming a level the model does not declare fails with `UNSUPPORTED_REASONING_EFFORT` before any network I/O — never clamped.
- `session-title` auxiliary calls are forced to `off`: a short title never needs thinking.

## Wire dialect (vLLM + Qwen3.8)

Request: `model`, `messages` (system first; multimodal user messages as `content` part arrays of `text` / `image_url` data-URL parts; tool results as `role: 'tool'`), `tools`, `stream: true`, `stream_options: { include_usage: true }`, plus `reasoning_effort` and `chat_template_kwargs` when they deviate from template defaults, `temperature`, `max_tokens`, `stop` when set.

Response: SSE `data:` payloads, `data: [DONE]` sentinel. `delta.reasoning_content` (and the `delta.reasoning` spelling some frameworks emit) → harness `reasoning` blocks (Qwen thinking channel); `delta.content` → `text` blocks; `delta.tool_calls` → `tool-call` blocks with raw-JSON `argumentsDelta`. `finish_reason`: `stop`/`content_filter` → `stop`, `length` → `max-tokens`, `tool_calls` → `tool-calls`, anything else → an `error` finish. Usage arrives attached to the finish chunk and/or as a trailing usage-only chunk; both are buffered and flushed after all `block-end`s and before `finish` (nothing is emitted after `finish`).

History replay: with `preserve_thinking` at its template default (ON), assistant reasoning is replayed as `reasoning_content` on tool-call-free turns — the exact reconstruction the official Qwen3.8 example performs; tool-call turns and `preserveThinking: false` models send no reasoning. Tool calls replay as `tool_calls` with `content: ""` (never `null`).

## Model parameters (Qwen3.8-27B, verified against the model card)

| Fact | Value | Where it lands in this plugin |
|---|---|---|
| Architecture | `Qwen3_5ForConditionalGeneration` — **native vision-language model** (image + video) | baseline `multimodal: true` |
| Context length | **262,144 native**, extensible to ~1M via YaRN / `--max-model-len` | `DEFAULT_CONTEXT_WINDOW = 262144`; raise `contextWindow` per model when your vLLM runs 1M |
| Thinking default | **ON**; disable per request with `chat_template_kwargs: { enable_thinking: false }` | `off` level + `offMode: chat-template-kwargs` (default) |
| `reasoning_effort` levels | **`xhigh` (default), `medium`, `low`** | baseline `efforts` + `defaultEffort: xhigh` |
| `preserve_thinking` | **ON by default**; retains historical thinking blocks | reasoning replay as `reasoning_content`; `preserveThinking: false` sends the kwarg |
| Recommended sampling | thinking: `temperature=1.0, top_p=0.95, top_k=20`; non-thinking: `temperature=0.7, top_p=0.8, top_k=20, presence_penalty=1.5` | only `temperature` is harness-exposable; the rest rides your deployment defaults (vLLM's generation defaults match the thinking set) |
| Recommended output budget | reasoning 262,144 / final 131,072 when split limits are available on a 1M context | `maxTokens` per model / per request |
| Images | `image_url` parts (URL or data URL) | `multimodal: true` path (data URL inlined) |
| Video | `video_url` parts | not supported — the harness has no video content block |

**Required vLLM serve flags** (per the official vLLM recipe): `--reasoning-parser qwen3` is effectively mandatory — without it the whole reasoning block lands in `message.content` — plus `--enable-auto-tool-choice --tool-call-parser qwen3_coder` for tool calling and `--max-model-len 262144` (or higher).

## Framework compatibility

Every wire field the adapter sends or reads, and where it comes from:

| Field | Origin | vLLM | SGLang | llama.cpp / Ollama |
|---|---|---|---|---|
| `model`/`messages`/`stream`/`stream_options` | OpenAI standard | yes | yes | yes |
| `temperature`/`max_tokens`/`stop` | OpenAI standard | yes | yes | yes |
| `tools`/`tool_calls` | OpenAI standard | yes | yes | yes |
| `image_url` (data URL) | OpenAI standard | yes | yes | VL builds |
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

The plugin wires the four hooks DSH's configuration surfaces consume (the same
ones `llm-deepseek` and `llm-pi-ai` use):

- **Settings section** — the plugin's `Config` schema is installed as the
  `llm-qwen-local` user-settings section (`installSettingsSection`), so the
  web settings surface renders an editable form for the whole provider:
  `baseURL`, the model list (id / name / capacities / multimodal /
  `preserveThinking` / reasoning efforts), and the credential reference.
  Commits switch the configuration source **live** — the adapter re-resolves
  per request, so a saved change reaches the next model call without a
  restart. Unserviceable sections are refused where they are written.
- **Configurable-provider directory** — the `qwen-local` route is registered
  via `registerConfigurableProviders`, so the web Models page offers it as a
  row (live or dormant) that links into the settings section.
- **Model discovery** — `registerModelDiscovery` lets the Models page
  prefill the catalog from a live deployment: a draft naming a `baseURL`
  triggers a `GET {baseURL}/models` probe (the draft's one-off key, else the
  route's stored credential, else unauthenticated); a draft naming the route
  but no endpoint is answered from the configured catalog with no network
  call.
- **Credentials** — a named `apiKeyEnv` resolves through the durable
  credentials service first (what the web Models page writes keys into),
  then the launch environment. A miss fails loud with `MISSING_CREDENTIAL`
  rather than letting the deployment pick up an unrelated ambient key.

Scope note: the Models page's *curated* per-family editor cards (the
baseURL/key/model-catalog forms) are hand-written in the `ui-settings-models`
client package for the `llm-deepseek` and `llm-pi-ai` namespaces; this plugin
gets the generic schema-driven settings form plus the directory row and the
discovery hook. A dedicated Qwen card would be a `ui-settings-models`
contribution, not a plugin-side change.

## Error paths

- **Thrown from `stream()`** (transport/protocol failures): fetch failure or `TRANSPORT`; non-2xx mapped to `AUTH`/`RATE_LIMIT`/`INVALID_REQUEST`/`SERVER`/`HTTP_<n>` (with `status`, `retry-after`, request id when present); malformed SSE payload `MALFORMED_RESPONSE`; truncation without `[DONE]` `STREAM_CLOSED`; idle timeout `TIMEOUT`; caller abort `ABORTED`; image/content gates `UNSUPPORTED_CONTENT`; unknown effort `UNSUPPORTED_REASONING_EFFORT`; a named `apiKeyEnv` that resolves nowhere `MISSING_CREDENTIAL` (before any network I/O).
- **In-band provider failure**: an SSE payload carrying an `error` object closes open blocks and ends the stream with `finish {kind: 'error', failure: {code: 'PROVIDER_ERROR'}}`.
- A completed response with no content maps to an `EMPTY_RESPONSE` error finish.

Every provider request carries the harness `attributionHeaders()`; `options.signal` is honored through fetch and body reads.

## Development

```sh
pnpm install
pnpm build     # tsc → lib/
pnpm test      # vitest: serialization, translation, e2e against a mock vLLM
```

Tests run against a scripted in-process vLLM (SSE) mock — no real model or endpoint is required.

## Known Limitations and Deferred Work

- **A modality declaration is not verified** — `multimodal: true` on a text-only endpoint fails mid-turn after the image message is durable (recovery: new session / fork / other model).
- **No image inside tool results** — vLLM `role: 'tool'` content is text-only; an image there is refused with `UNSUPPORTED_CONTENT`.
- **No `replayState`** — the endpoint is stateless and history replays cleanly from recorded blocks (reasoning included, via `preserve_thinking`), so the adapter emits no adapter-private replay metadata.
- **No per-route retry policy** — v1 has no `retryPolicy` config; the harness normal defaults apply.
- **Thinking replay is tool-call-turn-free only** — reasoning is replayed as `reasoning_content` only on assistant turns with no tool calls (the official Qwen3.8 example's shape); a deployment that wants thinking retained across tool-call turns needs a template-level change.
- **Video input is unsupported** — Qwen3.8-27B accepts `video_url` parts, but the harness has no video content block, so only `image` is wired; a deployment that needs video would need a new harness content block plus a `video_url` serializer path.
- **Assistant-side images are rejected** — the harness image block is user-content-only in practice; assistant/tool/system image content is refused rather than silently erased.
