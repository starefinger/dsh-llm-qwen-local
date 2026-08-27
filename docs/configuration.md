# Configuration Reference

[← Back to README](../README.md) · [Design notes](design.md)

Every configuration field for `dsh-llm-qwen-local`. The configuration lives in the `llm-qwen-local` settings section (editable on the **Settings → Qwen 本地 (vLLM)** page, or in `cordis.patch.yml` by `id: llm-qwen-local`).

## Route-level fields

All fields except `models` are optional in `cordis.yml`; schema defaults fill the rest.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8000/v1` | Endpoint base; `/chat/completions` is appended. |
| `apiKeyEnv` | — (no auth header) | Environment-variable name holding an optional bearer token, read per request. Absent/unset/blank = no `Authorization` header. |
| `models` | **required** | At least one model entry. |
| `defaultContextWindow` | `262144` | Context capacity used when a model has no exact value. |
| `maxTokens` | `32768` | Per-request output cap fallback; explicit request values and a model's own cap win. |
| `streamIdleTimeoutMs` | `300000` | Maximum provider idle time while one stream read is outstanding. |
| `maxRequestImageBytes` | — (keep every image) | Total inlined base64 image payload bound per request; when exceeded, the **oldest** images are replaced with a deterministic text placeholder before serialization (the harness `offloadRequestImages` policy), so a history-heavy vision request still fits the endpoint's input cap. |

## Model entries

| Field | Default | Meaning |
|---|---|---|
| `id` | **required** | Wire model id vLLM accepts. |
| `name` | `id` | Selector label. |
| `description` | — | Selector detail for similar variants. |
| `contextWindow` | route default | This model's combined request/response capacity. |
| `maxTokens` | route default | This model's per-request output cap. |
| `multimodal` | `false` | The vision switch (below). Qwen3.8-27B is a native vision-language model — set `true` for it. |
| `preserveThinking` | `true` | Whether the deployment keeps historical thinking blocks (Qwen3.8's `preserve_thinking`, template default on). `false` sends `chat_template_kwargs: { preserve_thinking: false }` and the adapter stops replaying assistant reasoning into history. |
| `imageMaxPixels` | `640000` | Request-image pixel budget (width × height) after aspect-preserving projection — the harness canonical default shared with the official adapters. Raise it for detail-critical vision work; blank = default. |
| `imageMaxBytes` | `1048576` | Per-request-image encoded-byte cap before base64 inlining. |
| `reasoning` | — | Reasoning capability; absent = the model exposes no selectable efforts. |

## The multimodal switch

`multimodal` is a **claim about your endpoint, not a check of it** — nothing interrogates vLLM for what it accepts. Since the 0.1.1-rc.2 harness upgrade, the harness LLM runtime itself handles the under-claim case:

- `false` (default): the model is advertised text-only (`inputModalities: ['text']`). The harness runtime now **projects** images into a deterministic text placeholder (`[image omitted because this model accepts text only; attachment sha256:…]`) **before the adapter sees them** — the request proceeds text-only instead of being refused. The adapter keeps its own `UNSUPPORTED_CONTENT` gate at serialization time for direct (non-runtime) use and for history assembled outside the runtime projection.
- `true`: the model is advertised with `['text', 'image']`. Image bytes are resolved through the durable attachment service (`ctx.attachments`); a composition without that service refuses any image with `UNSUPPORTED_CONTENT` instead of guessing a source. **Tool-returned images are split, not refused** (see [design notes](design.md#tool-result-images-are-split-not-refused-031)): the strict OpenAI placement the wire enforces is that `image_url` parts may ride a `user` message only, so a tool result containing image parts serializes as a text-only `role: 'tool'` message followed by a `role: 'user'` multimodal message carrying a caption and the image parts (the QwenLM `qwen-code` `splitToolMedia` shape).

The two wrong answers do not cost the same: **over-claiming** admits an image the provider then rejects **mid-turn**, after the message is durable in the session log — that session will keep re-sending the failing image. Recovery is a new session, a fork before the image, or a different model; rolling an unconsumed image message back out of a failed send is deferred. **Under-claiming** no longer fails loud: the image silently becomes the placeholder above — the model still answers, but cannot see the image (recovery: flip the switch, then re-ask). The direct-adapter gate (`UNSUPPORTED_CONTENT`, naming the model) still fires for callers that bypass the runtime projection.

Image bytes are inlined as `image_url` parts with `data:<mediaType>;base64,…` values, projected through the attachment service's request-image pipeline when available (`readImageRequest`; the harness canonical policy: up to `imageMaxPixels` pixels, `imageMaxBytes` encoded bytes, cached per variant) with a fallback to the normalized master bytes (`readImage`) for providers that refuse projection with `ATTACHMENT_PROJECTION_UNSUPPORTED`.

## Reasoning efforts

```yaml
reasoning:
  efforts:
    - { id: off, wire: none }      # vLLM's canonical no-thinking spelling
    - { id: low, wire: low }       # any wire spelling your vLLM accepts
    - { id: high, wire: high }
  defaultEffort: high              # optional; absent = vLLM's own default
  offMode: chat-template-kwargs    # optional; 'chat-template-kwargs' | 'omit'
```

- **Qwen3.8-27B's official levels**: `xhigh` (the model's default), `medium`, `low` — the bundle baseline declares exactly these plus `off`. vLLM's accepted `reasoning_effort` vocabulary is `none` / `minimal` / `low` / `medium` / `high` / `xhigh`; `off` as a wire value is a 400, so `off` maps to `wire: none` (verified against a live Qwen3.8 vLLM build). Thinking is ON by default, so omitting the parameter entirely (no `defaultEffort`, or `offMode: omit` without an effort) keeps the deployment's thinking default.
- `efforts` (required, display order) — the authoritative selectable list. Each `id` is an opaque value the harness carries per request; `name` (default `id`) is what selectors show. A level not declared is not offered. `id` is unique per model. The `off` level is **optional**: it is the adapter's own "no thinking" selector. Omit it for a deployment with no way to disable thinking — then effort selection can never turn thinking off, and `session-title` calls keep the ordinary default instead of forcing `off`.
- `wire` — the exact spelling sent as `reasoning_effort`. `off` uses `none` by convention and is the only level allowed `null` (send nothing — the pre-parameter escape hatch; the offMode kwargs still carry the expression); every other level must name a non-empty wire value. Rename freely (`{ id: max, wire: high }`) — the harness never sees wire spellings.
- `defaultEffort` — materialized into requests when the caller omits an effort. Absent preserves vLLM's own default.
- `offMode` — the template-side expression of `off`, sent alongside its wire value:
  - `chat-template-kwargs` (default): also sends `chat_template_kwargs: { enable_thinking: false }` — the model's documented non-thinking mode (thinking is ON by default, so the effort value alone leaves the template's gate open; the kwarg closes it).
  - `omit`: sends nothing extra — use for deployments where `none` alone already means no thinking.
- Per-request selection takes precedence over `defaultEffort`. A request naming a level the model does not declare fails with `UNSUPPORTED_REASONING_EFFORT` before any network I/O — never clamped.
- `session-title` auxiliary calls are forced to `off`: a short title never needs thinking.
