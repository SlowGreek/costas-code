import assert from 'node:assert/strict'

import { describe, test } from 'vitest'

import {
  explainFetchFailure,
  fetchRepoFile,
  type GhProbe,
  shouldTryGhFallback
} from './private-repo-fetch'

const REPO = 'SlowGreek/costas-code'
const REF = 'abc1234'
const FILE = 'scripts/install.sh'
const URL = `https://raw.githubusercontent.com/${REPO}/${REF}/${FILE}`

function httpFailing(status: number) {
  return async () => {
    const err: any = new Error(`HTTP ${status}`)
    err.status = status
    throw err
  }
}

function gh(overrides: Partial<GhProbe> = {}): GhProbe {
  return {
    isAuthenticated: () => true,
    fetchFile: () => Buffer.from('#!/bin/bash\n# installer\n'),
    ...overrides
  }
}

describe('shouldTryGhFallback', () => {
  test('404 is the private-repo signal', () => {
    // GitHub hides a private repo's existence from anonymous callers, so the
    // "not found" here means "no access".
    assert.equal(shouldTryGhFallback(404), true)
  })

  test('403 covers rate limits and SSO policy', () => {
    assert.equal(shouldTryGhFallback(403), true)
  })

  test('server errors are not an auth problem', () => {
    // Credentials will not fix a 500; retrying through gh would hide the cause.
    assert.equal(shouldTryGhFallback(500), false)
    assert.equal(shouldTryGhFallback(502), false)
  })

  test('a network failure with no status is not retried', () => {
    assert.equal(shouldTryGhFallback(undefined), false)
  })
})

describe('fetchRepoFile', () => {
  test('anonymous HTTPS is used when it works', async () => {
    let ghCalls = 0

    const body = await fetchRepoFile({
      repo: REPO,
      ref: REF,
      filePath: FILE,
      url: URL,
      httpGet: async () => Buffer.from('public content'),
      gh: gh({ fetchFile: () => { ghCalls++;

 return Buffer.from('') } })
    })

    assert.equal(body.toString(), 'public content')
    // Public repos must not pay a gh round-trip, or require gh at all.
    assert.equal(ghCalls, 0)
  })

  test('a 404 falls back to gh and succeeds', async () => {
    const body = await fetchRepoFile({
      repo: REPO,
      ref: REF,
      filePath: FILE,
      url: URL,
      httpGet: httpFailing(404),
      gh: gh()
    })

    assert.match(body.toString(), /installer/)
  })

  test('gh receives the same repo, ref and path', async () => {
    const seen: string[] = []
    await fetchRepoFile({
      repo: REPO,
      ref: REF,
      filePath: FILE,
      url: URL,
      httpGet: httpFailing(404),
      gh: gh({
        fetchFile: (repo, ref, filePath) => {
          seen.push(repo, ref, filePath)

          return Buffer.from('ok')
        }
      })
    })

    // A pinned SHA must survive the fallback: bootstrapping a different commit
    // than the app was built from is how you get a mismatched backend.
    assert.deepEqual(seen, [REPO, REF, FILE])
  })

  test('without gh auth, the error explains the real cause', async () => {
    await assert.rejects(
      fetchRepoFile({
        repo: REPO,
        ref: REF,
        filePath: FILE,
        url: URL,
        httpGet: httpFailing(404),
        gh: gh({ isAuthenticated: () => false })
      }),
      (err: Error) => {
        // The bare "HTTP 404" sends people hunting for a typo in a correct URL.
        assert.match(err.message, /private repository/i)
        assert.match(err.message, /gh auth login/)

        return true
      }
    )
  })

  test("gh's own failure message is preserved", async () => {
    await assert.rejects(
      fetchRepoFile({
        repo: REPO,
        ref: REF,
        filePath: FILE,
        url: URL,
        httpGet: httpFailing(404),
        gh: gh({
          fetchFile: () => {
            throw new Error('SSO enforcement: token not authorized')
          }
        })
      }),
      (err: Error) => {
        // gh usually names the actual problem; swallowing it wastes the user's time.
        assert.match(err.message, /SSO enforcement/)

        return true
      }
    )
  })

  test('a 500 propagates untouched', async () => {
    let ghCalls = 0
    await assert.rejects(
      fetchRepoFile({
        repo: REPO,
        ref: REF,
        filePath: FILE,
        url: URL,
        httpGet: httpFailing(500),
        gh: gh({ fetchFile: () => { ghCalls++;

 return Buffer.from('') } })
      })
    )
    assert.equal(ghCalls, 0)
  })
})

describe('explainFetchFailure', () => {
  test('unauthenticated message points at the fix', () => {
    const msg = explainFetchFailure(404, URL, false)
    assert.match(msg, /gh auth login/)
    assert.match(msg, /cli\.github\.com/)
  })

  test('authenticated-but-denied message points at access, not install', () => {
    const msg = explainFetchFailure(404, URL, true)
    assert.match(msg, /lacks access/)
    assert.doesNotMatch(msg, /gh auth login/)
  })

  test('non-auth statuses keep the plain message', () => {
    const msg = explainFetchFailure(500, URL, false)
    assert.match(msg, /HTTP 500/)
    assert.doesNotMatch(msg, /private repository/i)
  })
})
