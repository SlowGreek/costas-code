import assert from 'node:assert/strict'

import { test } from 'vitest'

import { resolveBehindCount, resolveClientUpdateBaseline, shouldCountCommits } from './update-count'

test('packaged update status uses the running app stamp instead of a newer backend checkout', () => {
  assert.deepEqual(
    resolveClientUpdateBaseline({
      checkoutBranch: 'costas-code',
      checkoutSha: '803bf1686c5aeca7076fcac4f917b079c8a9f24e',
      installStamp: { branch: 'costas-code', commit: '8555ac23bd1a497fe7d9ed0976547ab641a59f99' },
      isPackaged: true
    }),
    { currentBranch: 'costas-code', currentSha: '8555ac23bd1a497fe7d9ed0976547ab641a59f99' }
  )
})

test('source builds keep using their live checkout even when a local build stamp exists', () => {
  assert.deepEqual(
    resolveClientUpdateBaseline({
      checkoutBranch: 'feature/dev',
      checkoutSha: 'checkout-current',
      installStamp: { branch: 'costas-code', commit: 'last-build' },
      isPackaged: false
    }),
    { currentBranch: 'feature/dev', currentSha: 'checkout-current' }
  )
})

test('packaged builds without a valid stamp fall back to the checkout', () => {
  assert.deepEqual(
    resolveClientUpdateBaseline({
      checkoutBranch: 'costas-code',
      checkoutSha: 'checkout-current',
      installStamp: null,
      isPackaged: true
    }),
    { currentBranch: 'costas-code', currentSha: 'checkout-current' }
  )
})

test('packaged builds reject the all-zero fallback stamp', () => {
  assert.deepEqual(
    resolveClientUpdateBaseline({
      checkoutBranch: 'costas-code',
      checkoutSha: '803bf1686c5aeca7076fcac4f917b079c8a9f24e',
      installStamp: { branch: 'costas-code', commit: '0000000000000000000000000000000000000000' },
      isPackaged: true
    }),
    {
      currentBranch: 'costas-code',
      currentSha: '803bf1686c5aeca7076fcac4f917b079c8a9f24e'
    }
  )
})

// FAIL-BEFORE: pre-fix the function did `Number.parseInt(countStr) || 0`
// unconditionally, so a shallow checkout with no merge-base surfaced the bogus
// rev-list count (e.g. 12104). This asserts the new shallow/no-merge-base branch.
test('shallow checkout with no merge-base does NOT trust the bogus rev-list count', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '12104',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: false
    }),
    1
  )
})

test('shallow checkout with no merge-base but identical SHA reports up-to-date', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '12104',
      currentSha: 'abc',
      targetSha: 'abc',
      isShallow: true,
      hasMergeBase: false
    }),
    0
  )
})

test('shallow checkout WITH a merge-base keeps the exact count (reliable)', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '3',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: true
    }),
    3
  )
})

test('full (non-shallow) clone keeps the exact count path unchanged', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '7',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: false,
      hasMergeBase: true
    }),
    7
  )
})

test('full clone with no merge-base falls back to binary SHA comparison', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'missing-stamped-commit',
      targetSha: 'target',
      isShallow: false,
      hasMergeBase: false
    }),
    1
  )
})

test('up-to-date full clone reports 0', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '0',
      currentSha: 'x',
      targetSha: 'x',
      isShallow: false,
      hasMergeBase: true
    }),
    0
  )
})

test('non-numeric count falls back to 0 (defensive, unchanged behaviour)', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: false,
      hasMergeBase: true
    }),
    0
  )
})

// shouldCountCommits gates the expensive `rev-list --count` in checkUpdates().
// FAIL-BEFORE: in the shallow + no-merge-base case the caller ran rev-list
// unconditionally and discarded the bogus result; this predicate lets the
// caller SKIP the whole-ancestry enumeration in exactly that case (#51922).
test('shallow checkout with no merge-base SKIPS the rev-list count', () => {
  assert.equal(shouldCountCommits({ isShallow: true, hasMergeBase: false }), false)
})

test('shallow checkout WITH a merge-base still runs the count', () => {
  assert.equal(shouldCountCommits({ isShallow: true, hasMergeBase: true }), true)
})

test('full clone runs the count only when the comparison has a merge-base', () => {
  assert.equal(shouldCountCommits({ isShallow: false, hasMergeBase: true }), true)
  assert.equal(shouldCountCommits({ isShallow: false, hasMergeBase: false }), false)
})

// The skip path produces an empty countStr; resolveBehindCount must NOT trust
// it and must fall through to the SHA compare (mirrors the live call site).
test('skipped-count path resolves via SHA compare, never via empty countStr', () => {
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'aaa',
      targetSha: 'bbb',
      isShallow: true,
      hasMergeBase: false
    }),
    1
  )
  assert.equal(
    resolveBehindCount({
      countStr: '',
      currentSha: 'same',
      targetSha: 'same',
      isShallow: true,
      hasMergeBase: false
    }),
    0
  )
})
