import type { NativeImage } from 'electron'

/**
 * Longest edge (px) a composer image is allowed to keep.
 *
 * Vision models already downsample above ~1568px (Anthropic's documented
 * long-edge cap; OpenAI's high-detail path tiles a 2048px square), so pixels
 * beyond this add request bytes without adding anything the model can see.
 *
 * That gap is the bug this constant exists to close: a 3840x2160 clipboard
 * paste is ~1.2MB of PNG, four of them base64-encode to ~6.5MB of request
 * body, and providers answer HTTP 413 — while the context meter, which
 * charges a flat per-image token estimate, still reads nearly empty.
 */
export const COMPOSER_IMAGE_MAX_EDGE = 1568

/** JPEG quality for resized composer images. High enough for UI screenshots
 * and text-bearing content, low enough to shed most of the payload. */
export const COMPOSER_IMAGE_JPEG_QUALITY = 82

export interface ComposerImageSize {
  width: number
  height: number
}

export interface DownscaledComposerImage {
  buffer: Buffer
  ext: '.png' | '.jpg'
  width: number
  height: number
  resized: boolean
}

export function shouldDownscaleComposerImage(size: ComposerImageSize | null | undefined): boolean {
  if (!size) {
    return false
  }

  const width = Number(size.width) || 0
  const height = Number(size.height) || 0

  return width > COMPOSER_IMAGE_MAX_EDGE || height > COMPOSER_IMAGE_MAX_EDGE
}

/**
 * Cap a pasted/dropped composer image at {@link COMPOSER_IMAGE_MAX_EDGE} on its
 * longest edge, re-encoding resized output as JPEG. Images already within the
 * cap pass through as PNG untouched.
 */
export function downscaleComposerImage(image: NativeImage | null | undefined): DownscaledComposerImage {
  const empty: DownscaledComposerImage = {
    buffer: Buffer.alloc(0),
    ext: '.png',
    width: 0,
    height: 0,
    resized: false
  }

  if (!image || image.isEmpty()) {
    return empty
  }

  const size = image.getSize()
  const width = Number(size?.width) || 0
  const height = Number(size?.height) || 0

  if (!width || !height) {
    return empty
  }

  if (!shouldDownscaleComposerImage({ width, height })) {
    return { buffer: image.toPNG(), ext: '.png', width, height, resized: false }
  }

  // Resize on the longer edge only; Electron derives the other from the
  // source aspect ratio.
  const resized =
    width >= height
      ? image.resize({ width: COMPOSER_IMAGE_MAX_EDGE, quality: 'good' })
      : image.resize({ height: COMPOSER_IMAGE_MAX_EDGE, quality: 'good' })

  const resizedSize = resized.getSize()

  return {
    buffer: resized.toJPEG(COMPOSER_IMAGE_JPEG_QUALITY),
    ext: '.jpg',
    width: Number(resizedSize?.width) || COMPOSER_IMAGE_MAX_EDGE,
    height: Number(resizedSize?.height) || COMPOSER_IMAGE_MAX_EDGE,
    resized: true
  }
}
