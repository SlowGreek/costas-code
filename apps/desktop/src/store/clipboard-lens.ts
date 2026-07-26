import { atom } from 'nanostores'

import type { HermesClipboardLensSnapshot } from '@/lib/clipboard-lens'
import { parseClipboardLensSnapshot } from '@/lib/clipboard-lens'

export const $clipboardLensOpen = atom(false)
export const $clipboardLensLoading = atom(false)
export const $clipboardLensSnapshot = atom<HermesClipboardLensSnapshot | null>(null)
export const $clipboardLensError = atom<string | null>(null)

let generation = 0

export async function openClipboardLens(): Promise<void> {
  $clipboardLensOpen.set(true)
  await refreshClipboardLens()
}

export function closeClipboardLens(): void {
  generation += 1
  $clipboardLensOpen.set(false)
  $clipboardLensLoading.set(false)
  $clipboardLensSnapshot.set(null)
  $clipboardLensError.set(null)
}

export async function refreshClipboardLens(): Promise<void> {
  const token = ++generation
  $clipboardLensLoading.set(true)
  $clipboardLensError.set(null)

  try {
    const inspect = window.hermesDesktop?.clipboardLens?.inspect

    if (!inspect) {
      throw new Error('clipboard-lens-unavailable')
    }

    const raw = await inspect()
    const snapshot = parseClipboardLensSnapshot(raw)

    if (!snapshot) {
      throw new Error('clipboard-lens-invalid-receipt')
    }

    if (token === generation) {
      $clipboardLensSnapshot.set(snapshot)
    }
  } catch (error) {
    if (token === generation) {
      $clipboardLensSnapshot.set(null)
      $clipboardLensError.set(error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (token === generation) {
      $clipboardLensLoading.set(false)
    }
  }
}
