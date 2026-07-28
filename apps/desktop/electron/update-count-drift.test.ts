import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { resolveBackendDrift } from './update-count'

const APP = 'b50b2ffd07a1c2d3e4f5061728394a5b6c7d8e9f'
const OLDER = 'd1033e10f2d5e5e2c4086de729c7d0e09c50de43'

describe('resolveBackendDrift', () => {
  test('flags a backend older than the app', () => {
    // The real incident: the app shipped image-steering UI while the backend
    // still had the text-only redirect, and corrections failed silently.
    const result = resolveBackendDrift({ appCommit: APP, backendCommit: OLDER })

    assert.equal(result.drifted, true)
    assert.equal(result.reason, 'mismatch')
  })

  test('matching commits are not drift', () => {
    const result = resolveBackendDrift({ appCommit: APP, backendCommit: APP })

    assert.equal(result.drifted, false)
    assert.equal(result.reason, 'match')
  })

  test('an abbreviated sha still matches its full form', () => {
    // A caller may hold `git rev-parse --short` output while the install stamp
    // carries all 40 chars. Comparing raw would report drift on one commit.
    const result = resolveBackendDrift({ appCommit: APP, backendCommit: APP.slice(0, 9) })

    assert.equal(result.drifted, false)
  })

  test('case differences are not drift', () => {
    const result = resolveBackendDrift({ appCommit: APP.toUpperCase(), backendCommit: APP })

    assert.equal(result.drifted, false)
  })

  describe('unknown is not drift', () => {
    // A warning we cannot substantiate is worse than none: it trains the user
    // to ignore the banner, so the real mismatch gets dismissed too.
    const cases: Array<[string, unknown, unknown]> = [
      ['missing app commit', '', OLDER],
      ['missing backend commit', APP, ''],
      ['both missing', '', ''],
      ['null', null, OLDER],
      ['undefined', undefined, OLDER],
      ['non-string', 12345, OLDER],
      ['not a sha', 'not-a-commit', OLDER],
      ['all zeroes', '0000000000000000000000000000000000000000', OLDER],
      ['too short', 'abc', OLDER]
    ]

    for (const [name, appCommit, backendCommit] of cases) {
      test(name, () => {
        const result = resolveBackendDrift({
          appCommit: appCommit as string,
          backendCommit: backendCommit as string
        })

        assert.equal(result.drifted, false, name)
        assert.equal(result.reason, 'unknown', name)
      })
    }
  })

  test('whitespace is tolerated', () => {
    // Reading a stamp or shelling out to git can leave a trailing newline.
    const result = resolveBackendDrift({ appCommit: `  ${APP}\n`, backendCommit: APP })

    assert.equal(result.drifted, false)
  })

  test('the direction of drift does not matter', () => {
    // A backend NEWER than the app is equally broken — the UI half is missing
    // instead of the gateway half.
    const forward = resolveBackendDrift({ appCommit: APP, backendCommit: OLDER })
    const backward = resolveBackendDrift({ appCommit: OLDER, backendCommit: APP })

    assert.equal(forward.drifted, backward.drifted)
  })
})
