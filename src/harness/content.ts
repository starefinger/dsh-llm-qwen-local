/**
 * Local, dependency-free copies of the harness content-block image helpers.
 *
 * Reproduced field-for-field from `@deepseek-ai/dsh-llm`'s `content.js`
 * (`contentHasImage`, `offloadedImageText`, `offloadRequestImagesWithPolicy`
 * and their private helpers `imageIdentity`, `base64Length`,
 * `collectImageLengths`, `replaceOldestImages`, `offloadedImagePrefixCount`).
 * The published plugin carries no runtime dependency on the package, so these
 * are reproduced verbatim. Type shapes are imported type-only from
 * `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-attachment` and are erased from
 * the build.
 *
 * The offload algorithm is deterministic: it counts the OLDEST image
 * occurrences (in request order, walking nested tool-result content) whose
 * represented lengths put the request over the route's byte/count budgets, in
 * whole removal quanta, and replaces them with a text placeholder. The result
 * depends only on the represented lengths, so a consumer cannot diverge from
 * the harness's own projection.
 *
 * @module dsh-llm-qwen-local/harness/content
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

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

/** Base64 length of raw image bytes, including padding. */
function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/**
 * One image-omission policy: byte/count budgets and removal quanta for one
 * request representation. Mirrors the harness `RequestImageOffloadPolicy`.
 */
export interface RequestImageOffloadPolicy {
  /** Image count accepted by the route; omission leaves count unbounded. */
  maxImages?: number
  /** Accumulated image bytes accepted by the route; omission leaves bytes unbounded. */
  maxBytes?: number
  /** Number of excess images removed as one deterministic step. */
  countQuantum?: number
  /** Number of excess bytes removed as one deterministic step. */
  byteQuantum?: number
  /** Whether byte accounting uses raw file bytes or inline base64 length. */
  representation: 'raw' | 'base64'
  /** Resolve the encoded request-version length; omission uses normalized attachment bytes. */
  byteLength?: (ref: ImageAttachmentRef) => number
  /** Build the model-visible replacement for each omitted attachment. */
  placeholder: (ref: ImageAttachmentRef) => string
}

/** Deterministic identity text for one durable image reference. */
function imageIdentity(ref: ImageAttachmentRef): string {
  return ref.name === undefined
    ? String(ref.attachmentId)
    : `${JSON.stringify(ref.name)} (${ref.attachmentId})`
}

/**
 * Stable per-image placeholder for a request-limit omission.
 * @param ref - durable normalized attachment omitted from this request.
 * @returns identity and the available recovery path.
 */
export function offloadedImageText(ref: ImageAttachmentRef): string {
  const identity = `image omitted to fit request image limits; ${imageIdentity(ref)}.`
  return `[${identity} No local normalized image path is available; ask the user to attach it again if needed.]`
}

/** Collect represented image lengths in request and nested-block order. */
function collectImageLengths(
  blocks: readonly ContentBlock[],
  lengths: number[],
  policy: RequestImageOffloadPolicy,
): void {
  for (const block of blocks) {
    if (block.type === 'image') {
      const bytes = policy.byteLength === undefined
        ? block.attachment.bytes
        : policy.byteLength(block.attachment)
      lengths.push(policy.representation === 'base64' ? base64Length(bytes) : bytes)
    }
    else if (block.type === 'tool-result') {
      collectImageLengths(block.content, lengths, policy)
    }
  }
}

/** Replace the first `remaining.count` image occurrences without mutating durable messages. */
function replaceOldestImages(
  blocks: ContentBlock[],
  remaining: { count: number },
  placeholder: (ref: ImageAttachmentRef) => string,
): ContentBlock[] {
  let next: ContentBlock[] | undefined
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'image' && remaining.count > 0) {
      remaining.count -= 1
      next ??= blocks.slice(0, index)
      next.push({ type: 'text', text: placeholder(block.attachment) })
      continue
    }
    if (block.type === 'tool-result') {
      const content = replaceOldestImages(block.content, remaining, placeholder)
      if (content !== block.content) {
        next ??= blocks.slice(0, index)
        next.push({ ...block, content })
        continue
      }
    }
    next?.push(block)
  }
  return next ?? blocks
}

/**
 * Number of oldest image occurrences one request projection removes, in whole
 * count and byte quanta, once a route budget is exceeded.
 * @param lengths - represented byte length of every occurrence, in request order.
 * @param policy - count/byte budgets and removal quanta; unbounded when absent.
 * @returns how many leading occurrences the projection replaces with placeholders.
 */
export function offloadedImagePrefixCount(
  lengths: readonly number[],
  policy: Pick<RequestImageOffloadPolicy, 'maxImages' | 'maxBytes' | 'countQuantum' | 'byteQuantum'>,
): number {
  const total = lengths.reduce((sum, bytes) => sum + bytes, 0)
  const excessCount = policy.maxImages === undefined ? 0 : Math.max(0, lengths.length - policy.maxImages)
  const excessBytes = policy.maxBytes === undefined ? 0 : Math.max(0, total - policy.maxBytes)
  if (excessCount === 0 && excessBytes === 0) return 0
  const countQuantum = policy.countQuantum ?? 1
  const byteQuantum = policy.byteQuantum ?? 1
  const removeCount = excessCount === 0 ? 0 : Math.ceil(excessCount / countQuantum) * countQuantum
  const removeBytes = excessBytes === 0 ? 0 : Math.ceil(excessBytes / byteQuantum) * byteQuantum
  let count = 0
  let removedBytes = 0
  for (const imageBytes of lengths) {
    const byteTargetMet = removeBytes === 0
      || (byteQuantum === 1 ? removedBytes >= removeBytes : removedBytes > removeBytes)
    if (count >= removeCount && byteTargetMet) break
    removedBytes += imageBytes
    count += 1
  }
  return count
}

/**
 * Return a deterministic transient projection whose oldest images are replaced
 * in whole count and byte quanta after a route budget is exceeded.
 * @param messages - complete request history, oldest first.
 * @param policy - route representation, budgets, and removal quanta.
 * @returns original messages below both bounds, otherwise shallow copies with deterministic placeholders.
 */
export function offloadRequestImagesWithPolicy(
  messages: readonly Message[],
  policy: RequestImageOffloadPolicy,
): readonly Message[] {
  const lengths: number[] = []
  for (const message of messages) collectImageLengths(message.content, lengths, policy)
  const count = offloadedImagePrefixCount(lengths, policy)
  if (count === 0) return messages
  const remaining = { count }
  return messages.map((message) => {
    const content = replaceOldestImages(message.content, remaining, policy.placeholder)
    return content === message.content ? message : { ...message, content }
  })
}
