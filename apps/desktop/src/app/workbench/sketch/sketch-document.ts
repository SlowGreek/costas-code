/**
 * Builds the `srcdoc` document for a sandboxed workbench sketch.
 *
 * Security model: the iframe carries `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so the document runs in an opaque origin — it cannot
 * touch the app's DOM, storage, cookies, preload bridge, or the local gateway
 * JSON-RPC surface. This builder adds defence in depth on top of that:
 *
 *  - a restrictive CSP meta is injected as the FIRST child of <head> so it
 *    applies to everything after it: `default-src 'none'; script-src
 *    'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src
 *    'none'; base-uri 'none'; form-action 'none'; frame-src 'none';
 *    object-src 'none'`.
 *    `'unsafe-inline'` for script/style is required — running model-authored
 *    inline code is the whole feature — and is acceptable because the origin
 *    is opaque and `default-src`/`connect-src 'none'` mean the code can
 *    compute and paint but cannot fetch, load, or exfiltrate anything.
 *  - `<base>` tags are stripped (they would repoint relative URLs).
 *  - `target="_top"` / `target="_parent"` is rewritten to `_blank`, which the
 *    sandbox then blocks, so no navigation of the host app.
 *  - `<form>` elements are neutralised (action removed, target defused);
 *    `allow-forms` is not granted either.
 *  - authored CSP metas are stripped (they could only loosen ours).
 *
 * Runaway scripts: nothing injected into the document can stop a blocking
 * `while (true)` — that code owns its own thread of execution. The real
 * mitigation is structural and lives in the renderer: the iframe is a separate
 * browsing context (it cannot freeze the app's own event loop beyond paint),
 * and the component exposes a "stop" control that blanks `srcdoc`, tearing the
 * document down and killing whatever it was running. The byte cap bounds the
 * payload before any of that.
 */

/** Matches the python-side MAX_SKETCH_HTML_BYTES. */
export const MAX_SKETCH_HTML_BYTES = 128 * 1024

export const SKETCH_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; " +
  "form-action 'none'; frame-src 'none'; object-src 'none'; media-src 'none'"

/** The only sandbox token granted. Never add allow-same-origin. */
export const SKETCH_SANDBOX = 'allow-scripts'

const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${SKETCH_CSP}">`

const BASE_STYLE =
  '<style>html,body{margin:0;padding:0;height:100%;background:#0b0d10;' +
  "color:#e6e9ef;font-family:ui-sans-serif,system-ui,sans-serif;overflow:hidden}" +
  'canvas{display:block}</style>'

function stripBaseTags(html: string): string {
  return html.replace(/<base\b[^>]*>/gi, '')
}

function defuseTopNavigation(html: string): string {
  return html.replace(
    /\btarget\s*=\s*("|')?\s*_(top|parent)\s*\1?/gi,
    'target="_blank"'
  )
}

function neutraliseForms(html: string): string {
  return html
    .replace(/<form\b([^>]*)>/gi, (_match, attrs: string) => {
      const cleaned = String(attrs)
        .replace(/\baction\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\bmethod\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/\btarget\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')

      return `<form${cleaned} onsubmit="return false">`
    })
}

/** Remove any CSP meta the model tried to author (it could only loosen ours). */
function stripAuthoredCsp(html: string): string {
  return html.replace(
    /<meta\b[^>]*http-equiv\s*=\s*("|')?\s*content-security-policy[^>]*>/gi,
    ''
  )
}

export interface SketchDocumentResult {
  html: string
  truncated: boolean
}

/**
 * Turn raw model-authored HTML into the hardened srcdoc string.
 * Pure: no DOM, no globals, safe to unit test.
 */
export function buildSketchDocument(raw: unknown): SketchDocumentResult {
  let body = typeof raw === 'string' ? raw : ''
  let truncated = false

  if (body.length > MAX_SKETCH_HTML_BYTES) {
    body = body.slice(0, MAX_SKETCH_HTML_BYTES)
    truncated = true
  }

  body = stripAuthoredCsp(body)
  body = stripBaseTags(body)
  body = defuseTopNavigation(body)
  body = neutraliseForms(body)

  // Always wrap: we own <head> so the CSP meta is guaranteed to be the first
  // thing the parser sees. A model-supplied <!doctype>/<html> wrapper is
  // discarded rather than trusted — nesting is harmless in the sandbox and the
  // parser hoists stray body content out of it.
  const inner = body.replace(/<!doctype[^>]*>/gi, '')

  const html =
    '<!doctype html><html><head>' +
    CSP_META +
    '<meta charset="utf-8">' +
    '<meta name="referrer" content="no-referrer">' +
    BASE_STYLE +
    '</head><body>' +
    inner +
    '</body></html>'

  return { html, truncated }
}
