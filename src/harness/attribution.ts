/**
 * Local, dependency-free copy of the harness attribution (User-Agent) header
 * builder.
 *
 * Reproduced from `@deepseek-ai/dsh-llm`'s `attributionHeaders` / `userAgent`
 * / `APP_IDENTITY`. The published plugin carries no runtime dependency on the
 * package, so the identity is built here. The plugin's OWN manifest version is
 * used (read at module load, exactly like the harness does for its own
 * package) so the User-Agent cannot drift from what is published; the product
 * name and self-identification URL match the harness convention. Header names
 * are lowercase (HTTP field names are case-insensitive on the wire).
 *
 * @module dsh-llm-qwen-local/harness/attribution
 */

import { createRequire } from 'node:module'

// The plugin's own manifest is the single source of the version so the
// User-Agent cannot drift from what is published. The relative path resolves
// from the compiled `lib/harness/` location back to the package root.
const { version } = createRequire(import.meta.url)('../../package.json')

/**
 * The app-attribution identity every provider request sends as `User-Agent`.
 */
const APP_IDENTITY = {
  product: 'deepseek-harness',
  version,
  url: 'https://github.com/deepseek-ai/deepseek-harness',
} as const

/** The standard `User-Agent` value: `product/version (+url)`. */
export function userAgent(identity: { product: string; version: string; url: string } = APP_IDENTITY): string {
  return `${identity.product}/${identity.version} (+${identity.url})`
}

/**
 * Build the attribution headers an adapter must send on every provider
 * request (currently just a lowercase `user-agent`).
 */
export function attributionHeaders(): Record<string, string> {
  return { 'user-agent': userAgent() }
}
