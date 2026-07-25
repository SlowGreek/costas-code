/**
 * private-repo-fetch.ts
 *
 * Fetching a file out of a PRIVATE GitHub repo, for the first-launch
 * bootstrapper.
 *
 * Why this exists: `bootstrap-runner` downloads `scripts/install.sh` from
 * `raw.githubusercontent.com` over anonymous HTTPS. That is correct for a
 * public repo and returns **404** for a private one — GitHub refuses anonymous
 * reads and deliberately does not distinguish "no access" from "does not
 * exist". So a packaged Catalyst app installed from a DMG could never
 * bootstrap: no managed checkout, no `hermes` CLI, no backend, no OTA updates.
 *
 * The fix reuses the GitHub CLI's existing credentials rather than inventing a
 * token of our own. Anyone who can install Catalyst already ran `gh auth login`
 * (the README's install one-liners require it), so there is no new secret to
 * store, rotate, or leak into a log — and nothing to do when the repo
 * eventually goes public, because anonymous HTTPS is still tried first.
 *
 * Order is deliberate:
 *   1. anonymous HTTPS  — free, works for public repos, no dependency on gh
 *   2. `gh api`         — only on 404/403, and only when gh is authenticated
 *
 * Everything here is dependency-injected so it can be tested without a network,
 * a real gh install, or a private repo to point at.
 */

export interface GhProbe {
  /** True when the `gh` binary exists AND has a valid auth session. */
  isAuthenticated: () => boolean
  /** Fetch `path` at `ref` through `gh api`, returning the file's bytes. */
  fetchFile: (repo: string, ref: string, filePath: string) => Buffer
}

export type HttpStatus = number | undefined

/**
 * Should we fall back to `gh` for this HTTP status?
 *
 * 404 is the private-repo signal (GitHub hides existence from anonymous
 * callers). 403 covers rate limiting and org SSO policies, which an
 * authenticated request also gets past. Anything else is a genuine failure —
 * a 500 or a network error will not be fixed by adding credentials, and
 * retrying through gh would only obscure the real cause.
 */
export function shouldTryGhFallback(status: HttpStatus): boolean {
  return status === 404 || status === 403
}

/**
 * Human-readable explanation for a bootstrap that could not fetch its script.
 *
 * The default 404 message ("Failed to download install.sh: HTTP 404") sends
 * people hunting for a typo in a URL that is perfectly correct. Name the
 * actual cause and the actual fix.
 */
export function explainFetchFailure(
  status: HttpStatus,
  url: string,
  ghAuthenticated: boolean
): string {
  if (shouldTryGhFallback(status)) {
    if (!ghAuthenticated) {
      return [
        `Cannot reach ${url} (HTTP ${status}).`,
        '',
        'Catalyst is a private repository, so anonymous downloads are refused —',
        'this is an access response, not a missing file.',
        '',
        'Fix: install the GitHub CLI (https://cli.github.com) and run:',
        '  gh auth login',
        'then relaunch Catalyst.'
      ].join('\n')
    }

    return [
      `Cannot reach ${url} (HTTP ${status}) even with GitHub CLI credentials.`,
      '',
      'Your gh session is valid but lacks access to this repository.',
      'Ask the repo owner for access, then relaunch Catalyst.'
    ].join('\n')
  }

  return `Failed to download from ${url}: HTTP ${status}`
}

/**
 * Fetch a repo file, falling back to `gh` when anonymous access is refused.
 *
 * `httpGet` resolves with the body on 200 and rejects with an
 * `{status}`-bearing error otherwise, mirroring the shape the existing
 * bootstrap downloader already produces.
 */
export async function fetchRepoFile(opts: {
  repo: string
  ref: string
  filePath: string
  url: string
  httpGet: (url: string) => Promise<Buffer>
  gh: GhProbe
}): Promise<Buffer> {
  const { repo, ref, filePath, url, httpGet, gh } = opts

  try {
    return await httpGet(url)
  } catch (err: any) {
    const status: HttpStatus = err?.status

    if (!shouldTryGhFallback(status)) {throw err}

    const authenticated = gh.isAuthenticated()

    if (!authenticated) {
      throw new Error(explainFetchFailure(status, url, false))
    }

    try {
      return gh.fetchFile(repo, ref, filePath)
    } catch (ghErr: any) {
      // Surface the private-repo explanation, but keep gh's own message —
      // it usually names the real problem (SSO, expired token, no access).
      throw new Error(
        `${explainFetchFailure(status, url, true)}\n\ngh error: ${ghErr?.message || ghErr}`
      )
    }
  }
}
