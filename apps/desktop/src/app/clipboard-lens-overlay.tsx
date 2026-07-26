import { useStore } from '@nanostores/react'
import { useState } from 'react'

import { requestComposerFocus, requestComposerInsert } from '@/app/chat/composer/focus'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { untrustedClipboardBlock } from '@/lib/clipboard-lens'
import { Clipboard, FileText, RefreshCw } from '@/lib/icons'
import {
  $clipboardLensError,
  $clipboardLensLoading,
  $clipboardLensOpen,
  $clipboardLensSnapshot,
  closeClipboardLens,
  refreshClipboardLens
} from '@/store/clipboard-lens'
import { notify, notifyError } from '@/store/notifications'

const bytesLabel = (value: number) => {
  if (value < 1024) {
    return `${value} B`
  }

  return `${(value / 1024).toFixed(1)} KiB`
}

const errorMessage = (code: string) => {
  if (code === 'clipboard-changed') {
    return 'The clipboard changed after inspection. Refresh before using it.'
  }

  if (code === 'clipboard-refused') {
    return 'The current clipboard text is not admitted.'
  }

  return code
}

export function ClipboardLensOverlay() {
  const open = useStore($clipboardLensOpen)
  const loading = useStore($clipboardLensLoading)
  const snapshot = useStore($clipboardLensSnapshot)
  const error = useStore($clipboardLensError)
  const [consuming, setConsuming] = useState(false)

  const consumeText = async () => {
    if (!snapshot || snapshot.state !== 'ready') {
      return
    }

    setConsuming(true)

    try {
      const result = await window.hermesDesktop.clipboardLens.consumeText(snapshot.content_hash)

      if (!result.ok) {
        throw new Error(errorMessage(result.code))
      }

      requestComposerInsert(untrustedClipboardBlock(result.text), { mode: 'block', target: 'active' })
      requestComposerFocus('active')
      closeClipboardLens()
      notify({ kind: 'success', title: 'Clipboard Lens', message: 'Inserted as untrusted data in the active composer.' })
    } catch (reason) {
      notifyError(reason, 'Clipboard Lens could not insert the snapshot')
    } finally {
      setConsuming(false)
    }
  }

  return (
    <Dialog onOpenChange={next => (!next ? closeClipboardLens() : undefined)} open={open}>
      <DialogContent className="sm:max-w-xl" onOpenAutoFocus={preventCloseButtonAutoFocus}>
        <DialogHeader>
          <DialogTitle icon={Clipboard}>Clipboard Lens</DialogTitle>
          <DialogDescription>
            One explicit, text-only inspection. History, ambient monitoring, sync, training, and automatic AI are off.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground" role="status">
            Inspecting current clipboard text…
          </div>
        ) : error ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 p-3 text-sm text-destructive" role="alert">
            Invalid or unavailable clipboard receipt: {error}
          </div>
        ) : snapshot?.state === 'empty' ? (
          <div className="rounded-lg border border-(--stroke-nous) p-4 text-sm text-muted-foreground">
            The clipboard has no admitted plain text.
          </div>
        ) : snapshot?.state === 'refused' ? (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/7 p-4" role="status">
            <div className="font-medium">Clipboard text withheld</div>
            <p className="text-sm text-muted-foreground">
              {snapshot.reason_code === 'sensitive-content'
                ? 'A local sensitivity rule matched. No clipboard text was projected into the renderer.'
                : 'The clipboard text exceeds the 262,144-byte explicit inspection bound.'}
            </p>
            <div className="font-mono text-xs text-muted-foreground">
              {snapshot.content_hash.slice(0, 23)}… · history off · ephemeral
            </div>
          </div>
        ) : snapshot?.state === 'ready' ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <Fact label="Media" value="plain text" />
              <Fact label="Size" value={bytesLabel(snapshot.byte_length)} />
              <Fact label="Authority" value="none" />
              <Fact label="Retention" value="ephemeral" />
            </div>

            <div className="rounded-lg border border-(--stroke-nous) bg-(--chrome-surface) p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <FileText className="size-4" />
                Preview
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                {snapshot.text_preview}
              </pre>
            </div>

            <div className="space-y-1 text-xs text-muted-foreground">
              <div className="font-mono">{snapshot.content_hash}</div>
              <div>Sensitivity: admitted · revocable: yes · automatic AI: off</div>
              <div>Insertion is visibly wrapped as untrusted data and never submits the message.</div>
              <div>After confirmation, the block follows ordinary active-session draft persistence.</div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button disabled={loading || consuming} onClick={() => void refreshClipboardLens()} variant="secondary">
            <RefreshCw className="size-4" />
            Refresh
          </Button>
          {snapshot?.state === 'ready' ? (
            <Button disabled={consuming} onClick={() => void consumeText()}>
              Add untrusted data to draft
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-(--stroke-nous) px-2.5 py-2">
      <div className="text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-medium text-foreground">{value}</div>
    </div>
  )
}
