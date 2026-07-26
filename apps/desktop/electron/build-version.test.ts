import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import { baseOf, buildVersion, buildVersionFromEnv, isValidSemver } from '../scripts/build-version.mjs'

const SHA = 'be31aea55e9172199386c49167b49ffe1b022cda'

describe('buildVersion', () => {
  test('a CI build is uniquely identifiable', () => {
    // The reported problem: two builds a day apart both read "0.17.0", so a
    // tester could not tell whether the download replaced anything.
    assert.equal(
      buildVersion({ baseVersion: '0.17.0', runNumber: 42, commitSha: SHA }),
      '0.17.0-ci.42+sha.be31aea5'
    )
  })

  test('successive builds of the same commit stay distinct', () => {
    const a = buildVersion({ baseVersion: '0.17.0', runNumber: 1, commitSha: SHA })
    const b = buildVersion({ baseVersion: '0.17.0', runNumber: 2, commitSha: SHA })
    assert.notEqual(a, b)
  })

  test('the release version is never modified', () => {
    // Bumping major/minor/patch is a maintainer decision, not CI's.
    const v = buildVersion({ baseVersion: '0.17.0', runNumber: 99, commitSha: SHA })
    assert.ok(v.startsWith('0.17.0'))
    assert.equal(baseOf(v), '0.17.0')
  })

  test('a local build keeps its plain version', () => {
    assert.equal(buildVersion({ baseVersion: '0.17.0' }), '0.17.0')
  })

  test('re-stamping does not compound', () => {
    // Building against an already-stamped tree must not yield
    // 0.17.0-ci.1+sha.a-ci.2+sha.b.
    const once = buildVersion({ baseVersion: '0.17.0', runNumber: 1, commitSha: SHA })
    const twice = buildVersion({ baseVersion: once, runNumber: 2, commitSha: SHA })
    assert.equal(twice, '0.17.0-ci.2+sha.be31aea5')
  })

  test('run number alone is enough', () => {
    assert.equal(buildVersion({ baseVersion: '0.17.0', runNumber: 7 }), '0.17.0-ci.7')
  })

  test('sha alone is enough', () => {
    assert.equal(buildVersion({ baseVersion: '0.17.0', commitSha: SHA }), '0.17.0+sha.be31aea5')
  })

  test('non-identifier characters are stripped', () => {
    // SemVer identifiers are [0-9A-Za-z-] only; a slash from a branch-shaped
    // input would produce an invalid version.
    const v = buildVersion({ baseVersion: '0.17.0', runNumber: 'feat/x 1', commitSha: SHA })
    assert.ok(isValidSemver(v), v)
  })
})

describe('SemVer 2.0.0 conformance', () => {
  test('every generated version validates', () => {
    const inputs = [
      { baseVersion: '0.17.0', runNumber: 1, commitSha: SHA },
      { baseVersion: '1.0.0', runNumber: 12345, commitSha: 'abc' },
      { baseVersion: '2.3.4' },
      { baseVersion: '0.17.0', runNumber: 0, commitSha: SHA }
    ]
    for (const input of inputs) {
      const v = buildVersion(input)
      assert.ok(isValidSemver(v), `${JSON.stringify(input)} -> ${v}`)
    }
  })

  test('build metadata is separated by + and pre-release by -', () => {
    // §9 and §10: precedence ignores everything after '+', so the sha belongs
    // there and the ordered run number belongs in the pre-release.
    const v = buildVersion({ baseVersion: '0.17.0', runNumber: 5, commitSha: SHA })
    const [core, metadata] = v.split('+')
    assert.equal(metadata, 'sha.be31aea5')
    assert.equal(core, '0.17.0-ci.5')
  })

  test('the validator rejects malformed versions', () => {
    for (const bad of ['0.17', 'v0.17.0', '0.17.0+sha.be31aea5+extra', '01.0.0', '']) {
      assert.equal(isValidSemver(bad), false, bad)
    }
  })
})

describe('buildVersionFromEnv', () => {
  test('reads the env vars CI actually sets', () => {
    const v = buildVersionFromEnv('0.17.0', {
      GITHUB_RUN_NUMBER: '77',
      GITHUB_SHA: SHA
    })
    assert.equal(v, '0.17.0-ci.77+sha.be31aea5')
  })

  test('an empty environment means a local build', () => {
    assert.equal(buildVersionFromEnv('0.17.0', {}), '0.17.0')
  })
})

describe('baseOf', () => {
  test('strips pre-release and metadata', () => {
    assert.equal(baseOf('0.17.0-ci.42+sha.abc1234'), '0.17.0')
    assert.equal(baseOf('0.17.0+sha.abc'), '0.17.0')
    assert.equal(baseOf('0.17.0'), '0.17.0')
  })
})
