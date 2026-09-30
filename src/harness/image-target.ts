/**
 * Local, dependency-free copy of the harness request-image projection
 * geometry (`requestImageDimensions`).
 *
 * Reproduced field-for-field from `@deepseek-ai/dsh-attachment`'s
 * `request-projection` module (0.2.0). On DSH >= 0.2.0 the attachment
 * service's `readImageRequest` takes an exact `ImageRequestTarget`
 * (`{ width, height, maxBytes }`), so the model route that owns a per-model
 * pixel budget must derive the target box per image from the image's
 * intrinsic size. The published plugin carries no runtime dependency on the
 * package, so the geometry is reproduced verbatim.
 *
 * @module dsh-llm-qwen-local/harness/image-target
 */

/** Integer width and height of one projected image. */
export interface ProjectedDimensions {
  width: number
  height: number
}

/**
 * Compute aspect-preserving integer dimensions within a hard total-pixel
 * budget.
 * @param width - positive source width.
 * @param height - positive source height.
 * @param maxPixels - positive width-times-height cap.
 * @returns inward-rounded dimensions; small images are not enlarged.
 */
export function requestImageDimensions(width: number, height: number, maxPixels: number): ProjectedDimensions {
  const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
  if (scale === 1) return { width, height }
  if (width >= height) {
    let projectedWidth = Math.max(1, Math.floor(width * scale))
    let projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    while (projectedWidth * projectedHeight > maxPixels && projectedWidth > 1) {
      projectedWidth -= 1
      projectedHeight = Math.max(1, Math.round(projectedWidth * height / width))
    }
    return { width: projectedWidth, height: projectedHeight }
  }
  let projectedHeight = Math.max(1, Math.floor(height * scale))
  let projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  while (projectedWidth * projectedHeight > maxPixels && projectedHeight > 1) {
    projectedHeight -= 1
    projectedWidth = Math.max(1, Math.round(projectedHeight * width / height))
  }
  return { width: projectedWidth, height: projectedHeight }
}
