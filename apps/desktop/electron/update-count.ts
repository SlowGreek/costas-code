// Whether `git rev-list HEAD..origin/<branch> --count` produces a meaningful
// number worth computing. On a SHALLOW checkout (installer clones with
// --depth 1) the local history often shares no merge-base with the freshly
// fetched origin tip, so the count enumerates the entire remote ancestry and
// returns a bogus huge number (e.g. 12104) — see #51922. resolveBehindCount
// discards that bogus count in favour of a SHA compare, so the caller should
// SKIP the expensive rev-list entirely in that case rather than run it and
// throw the result away.
function shouldCountCommits({ isShallow: _isShallow, hasMergeBase }) {
  // Without a merge base, rev-list is either meaningless (shallow divergence)
  // or fails outright (the packaged stamp object is absent). In both cases the
  // caller must use the binary SHA comparison instead of trusting empty output.
  return hasMergeBase
}

// Resolve how many commits the local checkout is behind origin for the desktop
// update indicator. When the count isn't meaningful (shallow + no merge-base)
// fall back to a binary up-to-date check by SHA, exactly like the official-SSH
// path in checkUpdates() and the CLI guard in hermes_cli/banner.py. Full clones
// (developers / Docker dev images) keep the exact count path unchanged.
function resolveBehindCount({ countStr, currentSha, targetSha, isShallow, hasMergeBase }) {
  if (!shouldCountCommits({ isShallow, hasMergeBase })) {
    if (currentSha && targetSha && currentSha === targetSha) {
      return 0
    }

    return 1 // behind by an unknown amount — show a generic "update available"
  }

  return Number.parseInt(countStr, 10) || 0
}

// Desktop and backend update on separate clocks. A packaged client's update
// baseline is the commit baked into the running app, not the managed backend
// checkout it happens to point at. Source/dev runs still use the live checkout.
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

export { resolveBackendDrift }
export { resolveBehindCount, resolveClientUpdateBaseline, shouldCountCommits }
