# dsh-llm-qwen-local

English | [简体中文](README.zh.md)

![Qwen 本地 (vLLM) configuration page](docs/assets/setting.png)

DeepSeek Harness LLM adapter plugin for a **locally deployed Qwen model** (e.g. Qwen3.8-27B) served by **vLLM** behind its OpenAI-compatible `/v1/chat/completions` endpoint.

> **v0.6.0** · exact compatibility target: DSH `0.2.0-rc.2` · MIT · community-maintained and not a DeepSeek or Qwen product.

> **✨ New in v0.6.0 — the configuration page moves to the Plugins page**
>
> - **The page is now rendered inline on the bundle's detail page in the Web sidebar's Plugins page** — the 0.2.0 plugin-configuration surface where each plugin is edited on its own page: open **Plugins → dsh-llm-qwen-local** and the form appears directly on the detail page (the same surface the official single-config bundles use; no extra navigation hop). The settings-window section (Settings → Qwen 本地 (vLLM)) is gone: 0.2.0 keeps plugin configuration on the Plugins page and leaves the settings window the read-only built-in inventory.
> - **Same data, standard plumbing.** The page now rides the settings domain's shared `ConfigForm` scope — staged read, ordered revision-fenced writes, recovery reload — over the same `llm-qwen-local` namespace, so a save still persists through the profile's Cordis patch and reaches the next request live. The inline form follows the row's enablement (it disappears when the row is switched off).
>
> **Upgrading:** drop-in for users on DSH 0.2.0 and newer — `dsh plugin --profile web add dsh-llm-qwen-local@0.6.0` (or the pinned snapshot tag `#dsh-0.2.0-rc.2-plugin-0.6.0`). No configuration changes required.

> **✨ New in v0.5.0 — DSH 0.2.0-line compatibility**
>
> - **Rebuilt around the 0.2.0 message model.** Tool results are first-class `role: 'tool'` messages (keyed by `toolCallId`) instead of content blocks, so a tool result serializes 1:1 onto the wire (text-only, with any images split into a follow-up `role: 'user'` message for multimodal models — the same split as before). Image projection uses the 0.2.0 per-image `ImageRequestTarget` (`width` / `height` / `maxBytes`), and `offloaded` image blocks are serialized as a placeholder text instead of raw bytes.
> - **0.2.0 cold-start and live-settings fixes.** The six route-level fields are marked `volatile` on the frozen settings envelope, and the exported `Config` exposes a dereferenced live-schema node view (its `toJSON()` still answers the frozen envelope), so the 0.2.0 settings service's `describe`/`write` works during the desktop cold start and a settings write reaches the next request without a restart. (The 0.1.2 `settings.installSection` seam was removed upstream; the plugin now injects `settings` and disables auto-registration.)
> - **Compatibility target is now DSH `0.2.0-rc.2`.** DSH `0.1.2-rc.1` is no longer supported: the adapter contract, the message model, and the settings seam all changed.
>
> **Upgrading:** drop-in for users on DSH 0.2.0 and newer — `dsh plugin --profile web add dsh-llm-qwen-local@0.5.0` (or the pinned snapshot tag `#dsh-0.2.0-rc.2-plugin-0.5.0`). No configuration changes required; an existing `settings.yaml` carries over as-is.
>
> **Still on DSH 0.1.2-rc.1?** Keep plugin `0.4.1` (npm or a tag targeting that line) until you upgrade `dsh`.

> **✨ New in v0.4.1 — settings-page fixes; `maxRequestImageBytes` route cap removed**
>
> - **No more focus loss while typing a reasoning-effort id (or a model id)** — list rows now key off a stable row identity instead of the id text, so typing no longer remounts the row.
> - **Shorter, uniform field labels** — long explanations moved into input placeholders; model-card columns are width-aligned.
> - **`maxRequestImageBytes` (the per-request total image byte cap) is removed** from config, schema, and the settings page. Every image is inlined once it fits its per-image budget (`imageMaxPixels` / `imageMaxBytes` are unchanged); an oversized request is refused by the backend LLM service against its own input limits. A leftover value in an existing `settings.yaml` is silently ignored — no migration needed.
> - **"Discover models from endpoint" now probes with the key currently in the API Key field** — a freshly typed key works without saving first.
> - **The model list can be emptied** — `models` no longer requires at least one entry: save an empty list and the route stays mounted but dormant (no selectable models), then re-populate via "discover models from endpoint" or a manual add.

> **✨ New in v0.4.0 — zero runtime `@deepseek-ai` dependencies**
>
> **The published plugin no longer depends on any `@deepseek-ai` package at runtime** — no `schemastery`, `dsh-llm`, `dsh-settings`, `dsh-attachment`, `dsh-launch-environment`, or `cordis`. Its only runtime dependencies are the MIT-licensed `eventsource-parser` and Node.js builtins.
>
> **Why:** the plugin now reproduces every DSH seam it touches (adapter contract, failure snapshots, brand ids, API-key/attribution/launch-env helpers, the settings-namespace `Config` surface) as small local modules under `src/harness/` plus a frozen, hand-owned configuration surface. It loads against the host's live services without importing the packages that define them — the same dependency posture as the `dsh-llm-ollama` reference implementation.
>
> **What did *not* change (at the time):** external plugin behavior was identical — provider route `qwen-local`, settings namespace `llm-qwen-local`, the settings page, model discovery, and the wire dialect. The DSH compatibility target then stayed `0.1.2-rc.1` (superseded by v0.5.0's `0.2.0-rc.2`). The `@deepseek-ai` packages remain **dev-only** type pins (their `import type` references are erased from the build), so existing installs keep working as-is.
>
> **Upgrading:** drop-in — just `dsh plugin --profile web add dsh-llm-qwen-local@0.4.1` (or your pinned snapshot tag). No configuration changes required.

```sh
dsh plugin --profile web add dsh-llm-qwen-local
```

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
            - { id: off, wire: none }
            - { id: low, wire: low }
            - { id: medium, wire: medium }
            - { id: xhigh, wire: xhigh }
          defaultEffort: xhigh
```

## Documentation

| | English | 中文 |
|---|---|---|
| Installation & usage | (this README) | (此 README) |
| Configuration reference — every field | [docs/configuration.md](docs/configuration.md) | [docs/configuration.zh.md](docs/configuration.zh.md) |
| Design notes — wire dialect, model parameters, framework compatibility, error paths, limitations | [docs/design.md](docs/design.md) | [docs/design.zh.md](docs/design.zh.md) |

## Requirements

- An installed `dsh` (the CLI) **0.2.0 or newer**, and a vLLM instance serving your Qwen model with the OpenAI-compatible API.
- Node.js with global `fetch` (18+).
- A profile whose composition mounts `@deepseek-ai/dsh-attachment` — the standard `web` and `headless` profiles do, via `dsh-base`.

### Supported DSH versions

| DSH version | Status |
|---|---|
| **0.2.0** and newer | ✅ **Supported** — the version the plugin is built and tested against (0.2.0-rc.2). |
| **0.1.2-rc.1** | ⛔ **Not supported** — the adapter contract, message model, and settings seam all changed in 0.2.0; use plugin `0.4.1` on this line. |
| **0.1.1-rc.2** and older | ⛔ **Not supported** — the web app **fails to boot** (see below). |

The plugin's configuration page talks to the host through DSH's **"remote-namespace" client model**: the settings domain's shared `configForms` scope (the staged `llm-qwen-local` section read and its ordered writes) plus `ctx.remote.credentials` / `ctx.remote.llm`. Those services are host-provided and **only exist on DSH 0.2.0 and newer** — earlier releases (e.g. `0.1.1-rc.2`) expose the older shared `api`/`connection` client instead, so the page cannot find them.

On DSH `0.1.2-rc.1` the settings seam cannot activate (0.1.2's settings service does not understand the 0.2.0 volatile/live-schema `Config` surface), so the web app fails to boot. On DSH `0.1.1-rc.2` and older the failure is the same in kind — the typed `remote.*` namespaces the page injects do not exist at all — with the web app aborting at startup:

```
web boot: 1 entry did not activate
dsh-llm-qwen-local: pending (waiting for services: remote.credentials, remote.llm, configForms)
```

This is expected on DSH < 0.2.0 — the plugin is not compatible with those versions. **Fix:** upgrade `dsh` to `0.2.0` or newer (the compatibility target is `0.2.0-rc.2`), or remove the plugin on the older build:

```sh
dsh plugin --profile web remove dsh-llm-qwen-local
```

**Required vLLM serve flags** (per the official vLLM recipe): `--reasoning-parser qwen3` is effectively mandatory — without it the whole reasoning block lands in `message.content` — plus `--enable-auto-tool-choice --tool-call-parser qwen3_coder` for tool calling and `--max-model-len 262144` (or higher).

## Install

```sh
# install from npm (recommended — prebuilt, no build step on install):
dsh plugin --profile web add dsh-llm-qwen-local

# install from git (the prepare script builds lib/ on install):
dsh plugin --profile web add github:starefinger/dsh-llm-qwen-local

# or from a local checkout (same prepare build runs on install):
dsh plugin --profile web add ./path/to/qwen3.8-LLM-plugin

# or from a packed tarball (prebuilt — no build step on install):
dsh plugin --profile web add ./dsh-llm-qwen-local-0.6.0.tgz

# verify the contributed layer, then start:
dsh --profile web --dump-config
dsh --profile web
```

### Version-pinned install (tag)

Each compatibility snapshot is tagged with the dsh version it targets. Snapshots published since 0.3.1 use `dsh-<dsh-version>-plugin-<plugin-version>` (dsh version first, plugin version as suffix); earlier snapshots use the bare `dsh-<dsh-version>` form. **For a given dsh version, several tags may exist — use the one with the newest plugin-version suffix: it is the latest snapshot that supports your dsh.** To install a specific snapshot, append `#<tag>` to the git URL — pnpm resolves the tag to the exact commit, so the install is reproducible and independent of `main`'s current state:

```sh
# install the latest snapshot for dsh 0.2.0-rc.2 (plugin 0.6.0):
dsh plugin --profile web add "git+https://github.com/starefinger/dsh-llm-qwen-local.git#dsh-0.2.0-rc.2-plugin-0.6.0"
```

Pick the tag matching your dsh version (`dsh --version`) — when several tags share the same dsh version, take the newest plugin-version suffix. After upgrading dsh, remove and re-add with the tag for the new version:

```sh
dsh plugin --profile web remove dsh-llm-qwen-local
dsh plugin --profile web add "git+https://github.com/starefinger/dsh-llm-qwen-local.git#dsh-<new-dsh-version>-plugin-<plugin-version>"
```

Tags are immutable snapshots: a fix for an already-published tag ships as a new tag (a newer plugin-version suffix for the same dsh version), never by moving an existing one.

Git and local-path installs run the package's `prepare` script (→ `pnpm build`) to produce `lib/` during install. pnpm v10 blocks dependency build scripts until they are allowed: if the first install fails with a "blocked build scripts" notice, add the exact key pnpm printed under `allowBuilds` in the profile's `pnpm-workspace.yaml`, then re-run the same `dsh plugin add` command. The tarball install is prebuilt and never needs this.

## Quick start

### 1. Configure on the Plugins page

The bundle's `cordis.patch.yml` inserts a baseline `llm-qwen-local` line (model `qwen3.8`, `multimodal: true`, `off/low/medium/xhigh` efforts, default `xhigh`). Open **Plugins → dsh-llm-qwen-local** in the Web sidebar: the configuration form is rendered inline on the bundle's detail page (the same surface the official single-config bundles use) — no extra navigation hop. It edits the endpoint, an optional API key (stored in the host credentials service, never in `settings.yaml`), and one card per model — id, display name, context window, output cap, image budgets, the multimodal switch, thinking preservation, and the reasoning-effort table:

![Configuration page: endpoint, image budget, API key, and the model card](docs/assets/setting.png)

![Configuration page: reasoning-effort table, default level, and the discover/save actions](docs/assets/setting2.png)

- **Discover models** probes `{baseURL}/models` and merges the ids it finds.
- **Save** applies **live** — the adapter re-resolves per request, so a saved change reaches the next model call without a restart.
- Prefer config files? Override the line from your profile's `cordis.patch.yml` by `id: llm-qwen-local` — a patch replaces the target line's **entire** `config` (no deep merge), so restate every key you keep.

### 2. Select the model

In the Web UI's model selector, the baseline `qwen3.8` entry appears under its **Qwen (local)** provider group:

![Model selector with Qwen3.8-27B (local) selected](docs/assets/use_guide_1.png)

### 3. Switch the reasoning level per request

Click the input footer (model name + effort, e.g. `Qwen3.8-27B (local) xhigh`) to switch the session model or the per-request **reasoning level** (the levels your config declares, e.g. `off` / `low` / `medium` / `xhigh`):

![Reasoning level menu opened from the input footer](docs/assets/use_guide_2.png)

## Configuration at a glance

All fields are optional; schema defaults fill the rest.

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8000/v1` | Endpoint base; `/chat/completions` is appended. |
| `apiKeyEnv` | — (no auth header) | Env-var name holding an optional bearer token, read per request. |
| `models` | `[]` | Model entries (see below). Empty = the route is mounted but dormant (no selectable models). |
| `defaultContextWindow` | `262144` | Context capacity used when a model has no exact value. |
| `maxTokens` | `32768` | Per-request output cap fallback. |

There is no route-level image cap: every image is inlined once it fits its per-image budget; an oversized request is the backend LLM service's to refuse.

Model entries: `id` (**required**), `name`, `contextWindow`, `maxTokens`, `multimodal` (the vision switch — set `true` for Qwen3.8-27B), `preserveThinking`, `imageMaxPixels`, `imageMaxBytes`, and `reasoning` (absent = no selectable efforts).

Full field-by-field reference, the multimodal switch semantics (over- vs under-claiming), and the reasoning-effort details: [docs/configuration.md](docs/configuration.md) · [中文](docs/configuration.zh.md).

## Headline limitations

- **A modality declaration is not verified** — `multimodal: true` on a text-only endpoint fails mid-turn after the image message is durable; `multimodal: false` on a vision endpoint is **silent** (images become text placeholders).
- **Tool-result images ride a follow-up user message** — since DSH 0.2.0, tool results are first-class text-only `role: 'tool'` wire messages (keyed by `toolCallId`), so for a multimodal model an image inside a tool result is split into a follow-up `role: 'user'` multimodal message.
- **No video input, no DashScope / Qwen Cloud** — the harness has no video content block, and the adapter targets local OpenAI-compatible servers only.

The complete list (thinking-replay shape, projection caveats, deferred work) and what this plugin does not claim: [docs/design.md](docs/design.md) · [中文](docs/design.zh.md).

## Development

```sh
pnpm install
pnpm build     # tsc → lib/ + client bundle
pnpm typecheck
pnpm test      # vitest: serialization, translation, e2e against a mock vLLM
```

Tests run against a scripted in-process vLLM (SSE) mock — no real model or endpoint is required.

## Zero runtime harness dependencies

The published plugin carries **no runtime dependency on any `@deepseek-ai` package** (no `schemastery`, `dsh-llm`, `dsh-settings`, `dsh-attachment`, `dsh-launch-environment`, or `cordis`). Its only runtime dependencies are the MIT-licensed `eventsource-parser` and Node.js builtins. The DSH seams it touches — the `LlmAdapter` contract, the `LlmError` failure snapshot, brand identity functions, API-key validation, attribution headers, the launch-environment reader, the content/image helpers, and the settings-namespace `Config` surface — are reproduced as small local modules under `src/harness/` and a frozen, hand-owned configuration surface in `src/config.ts`, so the plugin loads against the host's live services without importing the packages that define them.

The `@deepseek-ai` packages remain **dev** dependencies: they pin the type-level contract (the `import type` imports are erased from the build) and let the test suite boot a real `LlmRuntime`. If a host changes a seam's runtime shape, the local module must be updated to match — the `tests/boot.test.ts` regression drives the real Cordis load-time validator against the frozen `Config` to catch a drift in the one seam that is validated at plugin load.

Regenerating the frozen settings envelope after a `Config` shape change: dump the live envelope with `node scripts/dump-envelope.mjs` and paste it into the `ENVELOPE` constant in `src/config.ts` (keeping the two in sync), then verify with `node scripts/extract-envelope.mjs --check` (diffs the frozen constant against the reference schema in `scripts/envelope-source.ts`).

## License

This repository is licensed under [MIT](LICENSE).

The plugin's only runtime dependencies are MIT-licensed (`eventsource-parser`, plus Node.js builtins); it has no runtime dependency on any `@deepseek-ai` package. Its development toolchain includes TypeScript (Apache-2.0) among other MIT-licensed tools, and the `@deepseek-ai` packages remain available as dev-only type pins. No DeepSeek Harness or Qwen source is vendored into this repository. The Qwen3.8-27B model weights and the DSH product remain subject to their own upstream terms; this plugin is a community project and is not an official DeepSeek or Qwen/Alibaba product.
