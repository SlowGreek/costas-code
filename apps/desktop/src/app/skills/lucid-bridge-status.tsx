import { cn } from '@/lib/utils'
import type { McpCatalogEntry } from '@/types/hermes'

export function LucidBridgeStatus({
  bridge,
  compact = false
}: {
  bridge: NonNullable<McpCatalogEntry['host_bridge']>
  compact?: boolean
}) {
  const identityBound = bridge.transport_admitted && bridge.identity_binding === 'request-scoped'

  return (
    <div
      aria-label="LUCID host bridge status"
      className={cn(
        'mt-3 grid gap-1 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2.5 text-[0.66rem]',
        compact && 'shadow-none'
      )}
    >
      {compact && <p className="font-medium text-foreground">LUCID host bridge</p>}
      <div className="flex items-center gap-2">
        <span className={cn('size-1.5 rounded-full', identityBound ? 'bg-emerald-500' : 'bg-foreground/20')} />
        <span className="font-medium text-foreground">
          {identityBound ? 'Host identity bound' : 'Host bridge unavailable'}
        </span>
        <span className="text-(--ui-text-tertiary)">
          {identityBound ? 'request-scoped MCP metadata' : 'enrolled packaged Butler required'}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-amber-500" />
        <span className="font-medium text-foreground">Authority held</span>
        <span className="text-(--ui-text-tertiary)">Butler capability required per call</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="size-1.5 rounded-full bg-sky-500" />
        <span className="font-medium text-foreground">Receipts native</span>
        <span className="text-(--ui-text-tertiary)">{bridge.receipt_owner}</span>
      </div>
      {compact && (
        <p className="text-(--ui-text-quaternary)">
          No capability material enters config, React state, logs, or model arguments.
        </p>
      )}
    </div>
  )
}
