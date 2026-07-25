import { Codicon } from '@/components/ui/codicon'
import type { ParsedLucidSafetyState } from '@/lib/lucid-receipt'

export function LucidSafetyStateCard({ value }: { value: ParsedLucidSafetyState }) {
  const outcomeUnknown = value.code === 'lucid-outcome-unknown'
  const title = outcomeUnknown ? 'Outcome unknown' : 'Invalid receipt'

  const guidance = outcomeUnknown
    ? 'Do not retry automatically'
    : 'No effect status accepted from this response'

  return (
    <section
      aria-label="LUCID safety state"
      className="mt-1.5 overflow-hidden rounded-lg border border-amber-500/30 bg-amber-500/5"
      role="alert"
    >
      <div className="flex items-center gap-2 border-b border-amber-500/20 px-3 py-2">
        <span className="grid size-5 place-items-center rounded bg-amber-500/12 text-amber-500">
          <Codicon name="warning" size="0.75rem" />
        </span>
        <span className="font-mono text-[0.72rem] font-semibold tracking-wide text-foreground">
          LUCID · {value.verb.toUpperCase()}
        </span>
        <span className="ml-auto text-[0.65rem] font-medium text-amber-500">{title}</span>
      </div>
      <div className="grid gap-1.5 px-3 py-2.5 text-[0.68rem]">
        <p className="text-(--ui-text-secondary)">{value.message}</p>
        <p className="font-medium text-amber-500">{guidance}</p>
      </div>
    </section>
  )
}
