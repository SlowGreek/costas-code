/**
 * build-version.ts
 *
 * Give every CI build a unique, SemVer-2.0.0-valid version.
 *
 * The problem this solves: `package.json` pins `0.17.0`, so every artifact was
 * named `Catalyst-0.17.0-mac-arm64.dmg` no matter which commit produced it.
 * Two builds a day apart were indistinguishable by filename or by the About
 * box — a tester couldn't tell whether the download actually replaced anything,
 * and a bug report naming "0.17.0" identified no particular code.
 *
 * SemVer 2.0.0 §10 covers exactly this case: build metadata is appended with a
 * `+`, MUST be ignored when determining version precedence, and is the
 * canonical place for a commit sha. §9 pre-release identifiers (`-`) carry the
 * CI run number so successive builds of the SAME commit stay distinct and
 * ordered.
 *
 *   0.17.0-ci.42+sha.be31aea5
 *   │      │      └── build metadata: which code (ignored for precedence)
 *   │      └───────── pre-release: which build of it (ordered)
 *   └──────────────── the release version, untouched
 *
 * The base version is never modified: bumping major/minor/patch is a release
 * decision, not something CI should do behind a maintainer's back.
 */

/** SemVer 2.0.0 identifiers are alphanumerics and hyphens only. */
function sanitizeIdentifier(value) {
  return value.replace(/[^0-9A-Za-z-]/g, '')
}

/**
 * Strip any pre-release / build metadata already present on the base version.
 *
 * Guards against compounding (`0.17.0-ci.1+sha.a` becoming
 * `0.17.0-ci.1+sha.a-ci.2+sha.b`) when a stamped version is fed back in — which
 * happens whenever a build runs against an already-stamped working tree.
 */
export function baseOf(version) {
  return (version || '').split('+')[0].split('-')[0].trim()
}

/**
 * Compose a unique build version.
 *
 * With neither a run number nor a sha (a plain local build) the base version is
 * returned untouched — a developer's `npm run build` should not produce
 * artifacts labelled as CI builds.
 */
export function buildVersion({ baseVersion, runNumber, commitSha }) {
  const base = baseOf(baseVersion) || '0.0.0'

  const run = runNumber == null ? '' : sanitizeIdentifier(String(runNumber))
  const sha = commitSha ? sanitizeIdentifier(String(commitSha)).slice(0, 8) : ''

  if (!run && !sha) return base

  // §9: dot-separated pre-release identifiers. A numeric run number compares
  // numerically, so ci.10 correctly sorts after ci.9.
  const prerelease = run ? `-ci.${run}` : ''
  // §10: build metadata, ignored for precedence — the right home for a sha.
  const metadata = sha ? `+sha.${sha}` : ''

  return `${base}${prerelease}${metadata}`
}

/** Loose SemVer 2.0.0 validity check (official §11 pattern, anchored). */
export function isValidSemver(version) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(
    version
  )
}

/**
 * Read the inputs CI actually provides.
 *
 * GITHUB_RUN_NUMBER increments per workflow; GITHUB_SHA is the built commit.
 * Both are absent locally, which is how a local build keeps its plain version.
 */
export function buildVersionFromEnv(baseVersion, env = process.env) {
  return buildVersion({
    baseVersion,
    runNumber: env.GITHUB_RUN_NUMBER || null,
    commitSha: env.GITHUB_SHA || null
  })
}
