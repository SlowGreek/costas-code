import { Button } from '@/components/ui/button'
import { AlertCircle, Check, iconSize, X } from '@/lib/icons'
import { cn } from '@/lib/utils'

export type MissionState =
  'researching' | 'ready' | 'awaiting_boundary' | 'resuming' | 'presenting' | 'complete' | 'failed' | 'cancelled'

export interface MissionCapsuleProps {
  state: MissionState
  label?: string
  onCancel?: () => void
  onDetails?: () => void
}

const STATUS_COPY: Record<MissionState, { prefix: string; includesLabel?: boolean }> = {
  researching: { prefix: 'Researching', includesLabel: true },
  ready: { prefix: 'Evidence ready' },
  awaiting_boundary: { prefix: 'Evidence ready' },
  resuming: { prefix: 'Building', includesLabel: true },
  presenting: { prefix: 'Building', includesLabel: true },
  complete: { prefix: 'Complete' },
  failed: { prefix: 'Failed' },
  cancelled: { prefix: 'Cancelled' }
}

const ACTIVE_STATES = new Set<MissionState>(['researching', 'resuming', 'presenting'])
const CANCELLABLE_STATES = new Set<MissionState>(['researching', 'ready', 'awaiting_boundary', 'resuming'])

function StatusMark({ state }: { state: MissionState }) {
  if (ACTIVE_STATES.has(state)) {
    return (
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 animate-pulse rounded-full bg-(--ui-accent) motion-reduce:animate-none"
      />
    )
  }

  if (state === 'failed') {
    return <AlertCircle aria-hidden="true" className={cn('shrink-0 text-destructive', iconSize.xs)} />
  }

  if (state === 'cancelled') {
    return <X aria-hidden="true" className={cn('shrink-0 text-(--ui-text-tertiary)', iconSize.xs)} />
  }

  return <Check aria-hidden="true" className={cn('shrink-0 text-(--ui-accent)', iconSize.xs)} />
}

export function MissionCapsule({ state, label, onCancel, onDetails }: MissionCapsuleProps) {
  const copy = STATUS_COPY[state]
  const statusLabel = [copy.prefix, copy.includesLabel ? label?.trim() : undefined].filter(Boolean).join(' ')
  const showCancel = Boolean(onCancel && CANCELLABLE_STATES.has(state))

  return (
    <div className="inline-flex min-w-0 items-center gap-1.5 rounded-full bg-(--ui-bg-quaternary) px-2.5 py-1 text-xs text-(--ui-text-secondary)">
      <StatusMark state={state} />
      <span aria-atomic="true" aria-live="polite" className="truncate" role="status">
        {statusLabel}
      </span>
      {onDetails && (
        <Button onClick={onDetails} size="inline" type="button" variant="text">
          Details
        </Button>
      )}
      {showCancel && (
        <Button aria-label="Cancel mission" onClick={onCancel} size="inline" type="button" variant="text">
          Cancel
        </Button>
      )}
    </div>
  )
}
