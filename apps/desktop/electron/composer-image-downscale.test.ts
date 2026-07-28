import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  COMPOSER_IMAGE_MAX_EDGE,
  downscaleComposerImage,
  shouldDownscaleComposerImage
} from './composer-image-downscale'

interface FakeImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: string }): FakeImage
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
}

function fakeImage(width: number, height: number, byteSize = 1_200_000): FakeImage {
  const image: FakeImage = {
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: ({ width: w, height: h }) => {
      const scale = w ? w / width : h ? h / height : 1

      return fakeImage(Math.round(width * scale), Math.round(height * scale), Math.round(byteSize * scale * scale))
    },
    toPNG: () => Buffer.alloc(byteSize, 0x01),
    // JPEG at q<100 is dramatically smaller than PNG for photographic content.
    toJPEG: (quality: number) => Buffer.alloc(Math.round((byteSize * quality) / 400), 0x02)
  }

  return image
}

test('shouldDownscaleComposerImage is true when either edge exceeds the cap', () => {
  assert.equal(shouldDownscaleComposerImage({ width: COMPOSER_IMAGE_MAX_EDGE + 1, height: 100 }), true)
  assert.equal(shouldDownscaleComposerImage({ width: 100, height: COMPOSER_IMAGE_MAX_EDGE + 1 }), true)
})

test('shouldDownscaleComposerImage is false for images already within the cap', () => {
  assert.equal(shouldDownscaleComposerImage({ width: COMPOSER_IMAGE_MAX_EDGE, height: 100 }), false)
  assert.equal(shouldDownscaleComposerImage({ width: 640, height: 480 }), false)
})

test('shouldDownscaleComposerImage tolerates missing/zero dimensions', () => {
  assert.equal(shouldDownscaleComposerImage({ width: 0, height: 0 }), false)
  assert.equal(shouldDownscaleComposerImage(null), false)
})

test('a large screenshot is resized so its longest edge hits the cap', () => {
  const result = downscaleComposerImage(fakeImage(3840, 2160) as never)

  assert.ok(result.resized)
  assert.equal(result.width, COMPOSER_IMAGE_MAX_EDGE)
  // Aspect ratio preserved.
  assert.equal(result.height, Math.round((COMPOSER_IMAGE_MAX_EDGE * 2160) / 3840))
})

test('a tall screenshot caps its height, not its width', () => {
  const result = downscaleComposerImage(fakeImage(1000, 4000) as never)

  assert.equal(result.height, COMPOSER_IMAGE_MAX_EDGE)
  assert.ok(result.width < COMPOSER_IMAGE_MAX_EDGE)
})

test('a small image is passed through untouched as PNG', () => {
  const result = downscaleComposerImage(fakeImage(640, 480, 40_000) as never)

  assert.equal(result.resized, false)
  assert.equal(result.ext, '.png')
  assert.equal(result.width, 640)
})

test('downscaling a multi-megabyte paste yields a dramatically smaller buffer', () => {
  const original = fakeImage(3840, 2160, 6_000_000)
  const before = original.toPNG().length

  const result = downscaleComposerImage(original as never)

  assert.ok(
    result.buffer.length < before / 4,
    `expected a >4x reduction, got ${before} -> ${result.buffer.length}`
  )
})

test('resized output is encoded as JPEG for size', () => {
  const result = downscaleComposerImage(fakeImage(3840, 2160) as never)

  assert.equal(result.resized, true)
  assert.equal(result.ext, '.jpg')
})

test('an empty image is returned as-is without throwing', () => {
  const result = downscaleComposerImage(fakeImage(0, 0, 0) as never)

  assert.equal(result.resized, false)
})

test('a null image does not throw and reports no resize', () => {
  const result = downscaleComposerImage(null as never)

  assert.equal(result.resized, false)
  assert.equal(result.buffer.length, 0)
})

test('the cap is a sane vision-model-friendly edge length', () => {
  // Anthropic/OpenAI both downsample above ~1568px; going higher just
  // inflates the payload without improving what the model sees.
  assert.ok(COMPOSER_IMAGE_MAX_EDGE >= 1024 && COMPOSER_IMAGE_MAX_EDGE <= 2048)
})
