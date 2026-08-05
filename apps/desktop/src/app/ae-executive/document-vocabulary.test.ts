import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DECLARED_ITEM_LOSSES,
  HOST_ITEM_EXTENSIONS,
  PAINTED_ITEM_TYPES
} from './document-painter'

const aeRoot = path.resolve(import.meta.dirname, '../../../../../..')
const itemsPath = path.join(aeRoot, 'ugui', 'json', 'document-items.json')

/// UGUI owns the semantic item vocabulary. Catalyst may paint an item or admit a
/// named loss, but it may never silently ignore one the engine declares.
describe('UGUI document item vocabulary is owned by UGUI', () => {
  const vocabulary = JSON.parse(fs.readFileSync(itemsPath, 'utf8')) as {
    schema: string
    items: Record<string, { fields: string[] }>
  }

  it('reads the authored vocabulary rather than a local copy', () => {
    expect(vocabulary.schema).toBe('ugui-document-items/1')
    expect(Object.keys(vocabulary.items).length).toBeGreaterThan(0)
  })

  it('accounts for every canonical item type exactly once', () => {
    const canonical = Object.keys(vocabulary.items).sort()
    const accounted = [...PAINTED_ITEM_TYPES, ...DECLARED_ITEM_LOSSES].sort()

    expect(accounted).toEqual(canonical)
  })

  it('keeps painted types, declared losses, and host extensions disjoint', () => {
    const canonical = new Set(Object.keys(vocabulary.items))

    for (const painted of PAINTED_ITEM_TYPES) {
      expect(DECLARED_ITEM_LOSSES, painted).not.toContain(painted)
    }
    for (const extension of HOST_ITEM_EXTENSIONS) {
      expect(canonical.has(extension), `${extension} is canonical, not an extension`).toBe(false)
    }
  })
})
