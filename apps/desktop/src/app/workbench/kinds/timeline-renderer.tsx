/**
 * Structural prop type. The store still narrows `payload` to the map graph, so
 * this renderer accepts any artifact and narrows the payload itself at runtime.
 * That keeps `store/workbench.ts` untouched (owned elsewhere) while staying
 * type-safe about what we actually read.
 */
export interface KindArtifactLike {
  payload: unknown
  semantic_rev?: number
}

export interface TimelineItem {
  detail?: string
  id: string
  label: string
  order?: number
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

export function readTimelineItems(payload: unknown): TimelineItem[] {
  const raw = (payload as { items?: unknown } | null | undefined)?.items

  if (!Array.isArray(raw)) {
    return []
  }

  type Ranked = TimelineItem & { index: number; order: number }

  const items: Ranked[] = []

  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      return
    }

    const record = entry as Record<string, unknown>
    const id = asString(record.id)
    const label = asString(record.label)

    if (!id || !label) {
      return
    }

    items.push({
      detail: asString(record.detail),
      id,
      index,
      label,
      order: typeof record.order === 'number' && Number.isFinite(record.order) ? record.order : index
    })
  })

  // Stable sort on the semantic `order` key, falling back to emission order so
  // an unordered payload still renders in the sequence the model wrote it.
  return items
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ index: _index, ...item }) => item)
}

export function TimelineRenderer({ artifact }: { artifact: KindArtifactLike }) {
  const items = readTimelineItems(artifact.payload)

  if (items.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-6 text-center text-sm text-(--ui-text-tertiary)"
        data-testid="timeline-empty"
      >
        No steps yet. Keep talking — the sequence will fill in.
      </div>
    )
  }

  return (
    <div
      aria-label="Ideation timeline"
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5"
      data-testid="timeline-canvas"
      role="list"
    >
      <ol className="relative m-0 list-none p-0">
        {/* The spine. Inset so it threads the centre of each marker. */}
        <span
          aria-hidden="true"
          className="absolute top-2 bottom-2 left-[7px] w-px bg-(--ui-stroke-secondary)"
        />

        {items.map((item, index) => (
          <li
            className="relative grid grid-cols-[16px_1fr] items-start gap-x-3 pb-5 last:pb-0"
            data-testid="timeline-item"
            key={item.id}
            role="listitem"
          >
            <span
              aria-hidden="true"
              className="relative z-10 mt-[5px] size-4 rounded-full border-2 border-(--ui-accent) bg-(--ui-bg-primary)"
            />

            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <span className="shrink-0 font-mono text-[10px] leading-4 tabular-nums text-(--ui-text-quaternary)">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 text-[13px] leading-5 font-semibold break-words text-(--ui-text-primary)">
                  {item.label}
                </span>
              </div>

              {item.detail ? (
                <p className="mt-0.5 ml-[calc(1ch*2+0.5rem)] text-[11px] leading-4 break-words text-(--ui-text-tertiary)">
                  {item.detail}
                </p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

export default TimelineRenderer
