/**
 * Local, dependency-free copy of the harness content-block image helper.
 *
 * Reproduced field-for-field from `@deepseek-ai/dsh-llm`'s `content.js`
 * (`contentHasImage`). The published plugin carries no runtime dependency on
 * the package, so this is reproduced verbatim. The harness's request-image
 * OFFLOAD helpers are deliberately NOT copied: this plugin sends every image
 * once it fits its per-image budget and has no route-level total cap, so the
 * oldest-image placeholder policy has no consumer here. Type shapes are
 * imported type-only from `@deepseek-ai/dsh-llm` and erased from the build.
 *
 * @module dsh-llm-qwen-local/harness/content
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/**
 * True when typed model content contains an image block.
 *
 * The 0.2.0 block vocabulary is flat — tool results are first-class
 * `role: 'tool'` messages, not nested content blocks — so the walk is a
 * single `some()`. (The 0.1.2 copy also recursed into `tool-result` blocks,
 * which no longer exist in `ContentBlockMap`.)
 * @param content - typed model content blocks.
 * @returns whether any block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image')
}
