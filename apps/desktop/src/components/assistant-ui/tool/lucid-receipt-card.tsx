import { Codicon } from '@/components/ui/codicon'
import type { ParsedLucidToolResult } from '@/lib/lucid-receipt'
import { cn } from '@/lib/utils'

function resultText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function LucidReceiptCard({ value }: { value: ParsedLucidToolResult }) {
  const { error, receipt, result } = value

  const status = receipt.needs_user
    ? 'Needs user · not run'
    : receipt.refusal_code
      ? 'Refused · not run'
      : receipt.ran
        ? 'Executed'
        : 'Verified · not run'

  const tone = receipt.needs_user || receipt.refusal_code ? 'text-amber-500' : receipt.ran ? 'text-emerald-500' : 'text-sky-500'
  const detail = error ?? resultText(result)
  const shortHash = `${receipt.content_hash.slice(0, 15)}…${receipt.content_hash.slice(-8)}`

  return (
    <section
      aria-label="LUCID receipt"
      className="mt-1.5 overflow-hidden rounded-lg border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--theme-primary)_4%,var(--ui-chat-surface-background))]"
    >
      <div className="flex items-center gap-2 border-b border-(--ui-stroke-quaternary) px-3 py-2">
        <span className="grid size-5 place-items-center rounded bg-(--theme-primary)/12 text-(--theme-primary)">
          <Codicon name="verified-filled" size="0.75rem" />
        </span>
        <span className="font-mono text-[0.72rem] font-semibold tracking-wide text-foreground">
          LUCID · {receipt.verb.toUpperCase()}
        </span>
        <span className={cn('ml-auto text-[0.65rem] font-medium', tone)}>{status}</span>
      </div>

      <div className="grid gap-2 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.62rem] text-(--ui-text-tertiary)">
          <span className="font-mono text-(--ui-text-secondary)">{receipt.trust}</span>
          {receipt.refusal_code && <span className="font-mono text-amber-500">{receipt.refusal_code}</span>}
          <span className="font-mono" title={receipt.content_hash}>
            {shortHash}
          </span>
          <time dateTime={receipt.timestamp}>{receipt.timestamp}</time>
        </div>

        {detail && (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap wrap-break-word rounded-md bg-(--ui-bg-quinary) px-2.5 py-2 font-mono text-[0.68rem] leading-relaxed text-(--ui-text-secondary)">
            {detail}
          </pre>
        )}
      </div>
    </section>
  )
}
