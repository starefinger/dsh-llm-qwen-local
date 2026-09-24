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
 * True when typed model content contains an image block, walking nested
 * tool-result content.
 * @param content - typed model content blocks.
 * @returns whether any nested block is an image.
 */
export function contentHasImage(content: readonly ContentBlock[]): boolean {
  return content.some(block => block.type === 'image'
    || (block.type === 'tool-result' && contentHasImage(block.content)))
}
