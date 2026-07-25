import { describe, expect, it } from 'vitest'

import { group, split } from '@/components/pane-shell/tree/model'
import type { SessionTile } from '@/store/session-states'
import { openSessionDisposition, orderTilesByTree, selectionHomesToWorkspace } from '@/store/session-states'

const tile = (storedSessionId: string): SessionTile => ({ storedSessionId })
const tilePane = (id: string) => `session-tile:${id}`

describe('orderTilesByTree', () => {
  it('no-ops (null) without a tree or below two tiles', () => {
    expect(orderTilesByTree(null, [tile('a'), tile('b')])).toBeNull()
    expect(orderTilesByTree(group([tilePane('a')]), [tile('a')])).toBeNull()
  })

  it('reorders tiles to layout-tree encounter order across a split', () => {
    const tree = split('row', [group(['workspace', tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('a'), tile('b')])).toEqual([tile('b'), tile('a')])
  })

  it('returns null when the array already matches strip order (skip persist)', () => {
    const tree = split('row', [group([tilePane('b')]), group([tilePane('a')])])

    expect(orderTilesByTree(tree, [tile('b'), tile('a')])).toBeNull()
  })

  it('sorts not-yet-adopted tiles after placed ones, stably', () => {
    const tree = group(['workspace', tilePane('b')])

    expect(orderTilesByTree(tree, [tile('a'), tile('b'), tile('c')])).toEqual([tile('b'), tile('a'), tile('c')])
  })
})

describe('selectionHomesToWorkspace', () => {
  const tiles = [tile('a'), tile('b')]

  it('homes for a null selection or a non-tile session', () => {
    expect(selectionHomesToWorkspace(null, tiles)).toBe(true)
    expect(selectionHomesToWorkspace('c', tiles)).toBe(true)
  })

  it('skips homing when the selected id is already an open tile', () => {
    expect(selectionHomesToWorkspace('a', tiles)).toBe(false)
  })
})

describe('openSessionDisposition', () => {
  const tiles = [tile('tile-a')]

  it('focuses an open tile without replacing the workspace route', () => {
    expect(openSessionDisposition('tile-a', 'main-a', tiles)).toBe('tile')
  })

  it('requires chat-route navigation for the main session', () => {
    expect(openSessionDisposition('main-a', 'main-a', tiles)).toBe('main')
  })

  it('loads a session that is not already on screen', () => {
    expect(openSessionDisposition('other', 'main-a', tiles)).toBe('load')
  })
})
