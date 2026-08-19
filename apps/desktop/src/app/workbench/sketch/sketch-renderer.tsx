import { useMemo, useState } from 'react'

import type { WorkbenchArtifact } from '@/store/workbench'

import { buildSketchDocument, SKETCH_SANDBOX } from './sketch-document'

interface SketchRendererProps {
  artifact: WorkbenchArtifact
}

function readHtml(payload: unknown): string {
  if (payload && typeof payload === 'object' && 'html' in payload) {
    const value = (payload as { html?: unknown }).html

    if (typeof value === 'string') {return value}
  }

  return ''
}

/**
 * Renders a model-authored sketch inside a locked-down iframe.
 *
 * The document is passed via `srcdoc` only — it never touches the app DOM, so
 * there is no `dangerouslySetInnerHTML` anywhere in this file. `sandbox` is
 * exactly `allow-scripts`: withholding `allow-same-origin` gives the document
 * an opaque origin, which is what actually severs it from app storage, the
 * preload bridge, and the local gateway. See sketch-document.ts for the CSP.
 *
 * `key` is bound to the artifact revision because a sketch is
 * whole-regeneration: a new revision replaces the browsing context outright
 * rather than mutating a live one.
 */
export default function SketchRenderer({ artifact }: SketchRendererProps) {
  const [stopped, setStopped] = useState(false)
  const raw = readHtml(artifact.payload)
  const doc = useMemo(() => buildSketchDocument(raw), [raw])

  if (!raw.trim()) {
    return (
      <div className="workbench-sketch workbench-sketch--empty" data-testid="workbench-sketch-empty">
        This sketch is empty.
      </div>
    )
  }

  return (
    <div
      className="workbench-sketch flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="workbench-sketch"
    >
      <div className="workbench-sketch__bar shrink-0" data-testid="workbench-sketch-toolbar">
        <span className="workbench-sketch__badge" data-testid="workbench-sketch-badge">
          sandboxed sketch
        </span>
        {doc.truncated ? (
          <span data-testid="workbench-sketch-truncated">truncated — sketch was too large</span>
        ) : null}
        <button
          data-testid="workbench-sketch-stop"
          onClick={() => {
            setStopped(true)
          }}
          type="button"
        >
          Stop
        </button>
      </div>
      <iframe
        className="workbench-sketch__frame min-h-0 w-full flex-1 border-0"
        data-testid="workbench-sketch-frame"
        key={`${artifact.artifact_id}:${artifact.semantic_rev}:${stopped ? 'stopped' : 'live'}`}
        loading="lazy"
        referrerPolicy="no-referrer"
        sandbox={SKETCH_SANDBOX}
        srcDoc={stopped ? '' : doc.html}
        title="Workbench sketch"
      />
    </div>
  )
}
