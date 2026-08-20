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
 *  - `<meta http-equiv="refresh">` is stripped: it is a navigation primitive
 *    that does NOT need `allow-top-navigation` to move the sketch frame itself
 *    to an attacker-chosen URL, and would replace the document with a fresh one
 *    outside our CSP.
 *
 * OFFLINE RUNTIME (sketch-runtime.ts)
 * A small first-party 3D/animation helper library is inlined into <head>
 * BEFORE the model's markup, exposed as `window.Sketch`. It is part of the
 * srcdoc, never fetched, and performs no network access itself — so it adds
 * capability without touching the CSP or the sandbox tokens. It is injected by
 * the builder alongside the model's HTML and therefore does NOT count against
 * MAX_SKETCH_HTML_BYTES, which remains entirely the model's budget.
 *
 * Runaway scripts: nothing injected into the document can stop a blocking
 * `while (true)` — that code owns its own thread of execution. The real
 * mitigation is structural and lives in the renderer: the iframe is a separate
 * browsing context (it cannot freeze the app's own event loop beyond paint),
 * and the component exposes a "stop" control that blanks `srcdoc`, tearing the
 * document down and killing whatever it was running. The byte cap bounds the
 * payload before any of that.
 */

import { SKETCH_RUNTIME_SCRIPT } from './sketch-runtime'

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
  '<style>*,*::before,*::after{box-sizing:border-box}' +
  'html,body{margin:0!important;padding:0!important;width:100%!important;min-width:0!important;' +
  'max-width:100%!important;height:100%!important;min-height:0!important;max-height:100%!important;' +
  'background:#0b0d10;color:#e6e9ef;font-family:ui-sans-serif,system-ui,sans-serif;' +
  'overflow:hidden!important}' +
  'body{position:relative}' +
  '#hermes-sketch-root{position:absolute;inset:0;overflow:hidden;transform-origin:0 0}' +
  '#hermes-sketch-root>*{max-width:100%!important;max-height:100%!important}' +
  'canvas,svg,img,video{display:block;max-width:100%!important;max-height:100%!important}</style>'

/**
 * Scale an authored scene into the real iframe viewport.
 *
 * Bounding html/body is not enough: the reported sketch had a responsive
 * `.grid` whose own overflow region was 866px tall inside a 484px box. The
 * outer document fit perfectly while a nested scrollbar remained. Expanding
 * the root's logical dimensions and scaling it back down gives authored
 * percentage/calc layouts enough room without clipping any content.
 */
const VIEWPORT_FIT_SCRIPT = `<script data-hermes-viewport-fit>(function(){
  var root=document.getElementById('hermes-sketch-root');if(!root)return;
  var raf=0;
  function own(name,value){root.style.setProperty(name,value,'important')}
  own('position','absolute');own('inset','0');own('overflow','hidden');own('transform-origin','0 0');
  function fit(){
    cancelAnimationFrame(raf);
    raf=requestAnimationFrame(function(){
      own('transform','none');own('width','100%');own('height','100%');
      requestAnimationFrame(function(){
        var needW=root.scrollWidth,needH=root.scrollHeight,rootRect=root.getBoundingClientRect();
        root.querySelectorAll('*').forEach(function(el){
          var rect=el.getBoundingClientRect();
          needW=Math.max(needW,(rect.left-rootRect.left)+el.scrollWidth);
          needH=Math.max(needH,(rect.top-rootRect.top)+el.scrollHeight);
        });
        var scale=Math.min(1,root.clientWidth/Math.max(1,needW),root.clientHeight/Math.max(1,needH));
        var viewportW=root.clientWidth,viewportH=root.clientHeight;
        function apply(next,attempt){
          if(next>=0.999)return;
          own('width',(100/next)+'%');own('height',(100/next)+'%');
          own('transform','scale('+next+')');
          if(attempt>=3)return;
          requestAnimationFrame(function(){
            var extraW=0,extraH=0;
            root.querySelectorAll('*').forEach(function(el){
              extraW=Math.max(extraW,el.scrollWidth-el.clientWidth);
              extraH=Math.max(extraH,el.scrollHeight-el.clientHeight);
            });
            if(extraW>2||extraH>2){
              var refined=Math.min(next,viewportW/Math.max(1,root.clientWidth+extraW),viewportH/Math.max(1,root.clientHeight+extraH));
              if(refined<next-0.001)apply(refined,attempt+1);
            }
          });
        }
        apply(scale,0);
      });
    });
  }
  addEventListener('resize',fit);addEventListener('load',fit);
  new MutationObserver(fit).observe(root,{childList:true,subtree:true});
  fit();
})()</script>`

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

/**
 * Remove `<meta http-equiv="refresh">`. Unlike link/form navigation this does
 * NOT require `allow-top-navigation` to navigate the sketch frame itself, so
 * it is the one navigation primitive the sandbox flags do not already cover.
 */
function stripMetaRefresh(html: string): string {
  return html.replace(/<meta\b[^>]*http-equiv\s*=\s*("|')?\s*refresh[^>]*>/gi, '')
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
  body = stripMetaRefresh(body)
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
    '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
    '<meta name="referrer" content="no-referrer">' +
    BASE_STYLE +
    SKETCH_RUNTIME_SCRIPT +
    '</head><body><div id="hermes-sketch-root">' +
    inner +
    '</div>' +
    VIEWPORT_FIT_SCRIPT +
    '</body></html>'

  return { html, truncated }
}
