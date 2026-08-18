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
            - { id: high, wire: high }
          defaultEffort: high
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
| `multimodal` | `false` | The vision switch (below). |
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

- `efforts` (required, display order) — the authoritative selectable list. Each `id` is an opaque value the harness carries per request; `name` (default `id`) is what selectors show. A level not declared is not offered. `id` is unique per model and **exactly one `off` must be declared**.
- `wire` — the exact spelling sent as `reasoning_effort`. Only `off` may use `null` (send nothing); every other level must name a non-empty wire value. Rename freely (`{ id: max, wire: high }`) — the harness never sees wire spellings.
- `defaultEffort` — materialized into requests when the caller omits an effort. Absent preserves vLLM's own default.
- `offMode` — how `off` is expressed beyond omitting `reasoning_effort`:
  - `chat-template-kwargs` (default): also sends `chat_template_kwargs: { enable_thinking: false }` — what the vLLM Qwen chat template needs to actually stop thinking (omitting the parameter alone keeps the template's thinking default).
  - `omit`: sends nothing extra — use for deployments where absence of `reasoning_effort` already means no thinking.
- Per-request selection takes precedence over `defaultEffort`. A request naming a level the model does not declare fails with `UNSUPPORTED_REASONING_EFFORT` before any network I/O — never clamped.
- `session-title` auxiliary calls are forced to `off`: a short title never needs thinking.

## Wire dialect (vLLM + Qwen3)

Request: `model`, `messages` (system first; multimodal user messages as `content` part arrays; tool results as `role: 'tool'`), `tools`, `stream: true`, `stream_options: { include_usage: true }`, plus the effort fields, `temperature`, `max_tokens`, `stop` when set.

Response: SSE `data:` payloads, `data: [DONE]` sentinel. `delta.reasoning_content` → harness `reasoning` blocks (Qwen thinking channel); `delta.content` → `text` blocks; `delta.tool_calls` → `tool-call` blocks with raw-JSON `argumentsDelta`. `finish_reason`: `stop`/`content_filter` → `stop`, `length` → `max-tokens`, `tool_calls` → `tool-calls`, anything else → an `error` finish. Usage arrives attached to the finish chunk and/or as a trailing usage-only chunk; both are buffered and flushed after all `block-end`s and before `finish` (nothing is emitted after `finish`).

History replay: assistant reasoning blocks are **dropped at the wire boundary** (the Qwen chat template has no reasoning passback field); tool calls replay as `tool_calls` with `content: ""` (never `null`).

## Error paths

- **Thrown from `stream()`** (transport/protocol failures): fetch failure or `TRANSPORT`; non-2xx mapped to `AUTH`/`RATE_LIMIT`/`INVALID_REQUEST`/`SERVER`/`HTTP_<n>` (with `status`, `retry-after`, request id when present); malformed SSE payload `MALFORMED_RESPONSE`; truncation without `[DONE]` `STREAM_CLOSED`; idle timeout `TIMEOUT`; caller abort `ABORTED`; image/content gates `UNSUPPORTED_CONTENT`; unknown effort `UNSUPPORTED_REASONING_EFFORT`.
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
- **No `replayState`** — the endpoint is stateless and history replays cleanly from recorded blocks, so the adapter emits no adapter-private replay metadata.
- **No per-route retry policy** — v1 has no `retryPolicy` config; the harness normal defaults apply.
- **`reasoning_content` is assumed** — the thinking channel name follows the vLLM Qwen dialect; a deployment that streams thinking elsewhere would need the delta field renamed in `translate.ts`.
- **Assistant-side images are rejected** — the harness image block is user-content-only in practice; assistant/tool/system image content is refused rather than silently erased.
