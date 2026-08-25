// Whether `git rev-list HEAD..origin/<branch> --count` produces a meaningful
// number worth computing. Installer checkouts are shallow (`--depth 1`), so
// their visible graph is incomplete even when `merge-base` happens to find a
// common commit. A merge can expose ancestry that the local shallow boundary
// hides from HEAD, inflating the count with old commits. Exact counts are only
// trustworthy in full clones; shallow checkouts use presence-only status plus
// any positively proven local-ahead ancestry.
function shouldCountCommits({ isShallow }) {
  return !isShallow
}

// Resolve how many commits the local checkout is behind origin for the desktop
// update indicator. Shallow checkouts use SHA equality plus any positively
// proven local-ahead ancestry; exact counts remain exclusive to full clones.
function resolveBehindCount({ countStr, currentSha, targetSha, isShallow, targetIsAncestorOfHead = false }) {
  if (!shouldCountCommits({ isShallow })) {
    if (currentSha && targetSha && (currentSha === targetSha || targetIsAncestorOfHead)) {
      return 0
    }

    // An update IS available, but its size is unknowable without a merge-base.
    // Return null — never a numeric sentinel: the UI used to render the old
    // `1` as a literal "1 change included" even when the true distance was
    // far larger. null lets every surface say "update available" honestly.
    return null
  }

  const count = Number.parseInt(countStr, 10)

  return Number.isInteger(count) && count >= 0 ? count : null
}

// Shallow history can also contaminate the changelog range. Trust the fetched
// remote tip itself, but do not walk its ancestry. Full clones retain the
// detailed range used by the existing update overlay.
function resolveCommitLogSelection({ branch, currentSha = '', isShallow }) {
  const remote = `origin/${branch}`
  const baseline = /^[0-9a-f]{7,64}$/i.test(currentSha || '') ? currentSha : 'HEAD'

  return isShallow ? { limit: 1, revision: remote } : { limit: 40, revision: `${baseline}..${remote}` }
}

// When the local graph can't count (behind === null), the GitHub compare API
// still can: `GET /repos/<owner>/<repo>/compare/<current>...<target>` returns
// `ahead_by` — how many commits the remote tip is ahead of the local HEAD,
// i.e. exactly the behind count the shallow clone lost. Unauthenticated, no
// clone depth required. Pure URL builder + response parser here; the network
// call lives with the caller.
function compareApiUrl({ currentSha, originUrl, targetSha }) {
  const sha = /^[0-9a-f]{40}$/i

  if (!sha.test(currentSha || '') || !sha.test(targetSha || '')) {
    return null
  }

  // Only GitHub remotes have a compare API. Reuse the canonical form the
  // official-remote check produces: `github.com/<owner>/<repo>`.
  const canonical = canonicalRemoteForCompare(originUrl)

  if (!canonical) {
    return null
  }

  return `https://api.github.com/repos/${canonical}/compare/${currentSha}...${targetSha}`
}

function canonicalRemoteForCompare(originUrl) {
  const value = String(originUrl || '').trim()

  const match =
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(value) ||
    /^(?:ssh:\/\/git@|https:\/\/|http:\/\/)github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(value)

  return match ? match[1] : null
}

// `ahead_by` counts target commits not reachable from current — the behind
// count. `status` is "ahead" / "behind" / "diverged" / "identical" relative to
// current...target; any shape surprise returns null so the caller keeps the
// honest "update available" fallback instead of trusting a partial answer.
function parseCompareBehindCount(payload) {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const ahead = payload.ahead_by

  if (typeof ahead !== 'number' || !Number.isInteger(ahead) || ahead < 0) {
    return null
  }

  return ahead
}

// Desktop and backend update on separate clocks. A packaged client's update
// baseline is the commit baked into the running app, not the managed backend
// checkout it happens to point at. Source/dev runs still use the live checkout.
// FORK-ONLY: upstream has no packaged-vs-checkout split here.
function resolveClientUpdateBaseline({ checkoutBranch, checkoutSha, installStamp, isPackaged }) {
  const stampedCommit = isPackaged && typeof installStamp?.commit === 'string' ? installStamp.commit.trim() : ''
  const validStampedCommit = /^[0-9a-f]{7,64}$/i.test(stampedCommit) && !/^0+$/.test(stampedCommit)

  if (validStampedCommit) {
    return {
      currentBranch: installStamp.branch || checkoutBranch,
      currentSha: stampedCommit
    }
  }

  return {
    currentBranch: checkoutBranch,
    currentSha: checkoutSha
  }
}

// The app and the backend it talks to are separate artifacts on separate
// clocks: the packaged Electron bundle carries a baked-in commit, while the
// managed checkout at HERMES_HOME advances only when `hermes update` runs.
//
// When they diverge the failure is SILENT and confusing rather than loud: the
// UI ships a feature whose gateway/agent half does not exist yet, so the
// feature simply misbehaves. A real instance: the desktop began sending images
// with a mid-turn correction while the backend still had the text-only
// `redirect(text: str)`, and corrections were rejected with no error anywhere.
//
// The update indicator alone cannot catch this — it compares the app against
// the REMOTE, so both "up to date" and a stale backend can be true at once.
function resolveBackendDrift({ appCommit, backendCommit }) {
  const clean = value => (typeof value === 'string' ? value.trim() : '')
  const app = clean(appCommit)
  const backend = clean(backendCommit)

  const valid = sha => /^[0-9a-f]{7,64}$/i.test(sha) && !/^0+$/.test(sha)

  // Unknown is not drift. A dev run, a missing stamp, or a backend outside git
  // must not raise a warning we cannot substantiate.
  if (!valid(app) || !valid(backend)) {
    return { drifted: false, reason: 'unknown' }
  }

  // Compare on the shorter length: the stamp carries a full 40-char sha while
  // a caller may pass an abbreviated one, and a length mismatch would read as
  // drift on identical commits.
  const width = Math.min(app.length, backend.length)
  const same = app.slice(0, width).toLowerCase() === backend.slice(0, width).toLowerCase()

  return same ? { drifted: false, reason: 'match' } : { drifted: true, reason: 'mismatch' }
}

export { compareApiUrl, parseCompareBehindCount, resolveBackendDrift, resolveBehindCount, resolveClientUpdateBaseline, resolveCommitLogSelection, shouldCountCommits }
