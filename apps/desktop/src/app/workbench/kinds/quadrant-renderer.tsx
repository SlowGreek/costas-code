import type { KindArtifactLike } from './timeline-renderer'

export interface QuadrantAxis {
  high: string
  low: string
}

export interface QuadrantItem {
  id: string
  label: string
  x: number
  y: number
}

export interface QuadrantModel {
  items: QuadrantItem[]
  x: QuadrantAxis
  y: QuadrantAxis
}

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

const asUnit = (value: unknown): null | number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null

const readAxis = (raw: unknown, lowFallback: string, highFallback: string): QuadrantAxis => {
  const record = (raw ?? {}) as Record<string, unknown>

  return { high: asString(record.high, highFallback), low: asString(record.low, lowFallback) }
}

export function readQuadrant(payload: unknown): QuadrantModel {
  const record = (payload ?? {}) as Record<string, unknown>
  const axes = (record.axes ?? {}) as Record<string, unknown>
  const rawItems = Array.isArray(record.items) ? record.items : []
  const items: QuadrantItem[] = []

  for (const entry of rawItems) {
    if (!entry || typeof entry !== 'object') {
      continue
    }

    const item = entry as Record<string, unknown>
    const id = asString(item.id, '')
    const label = asString(item.label, '')
    const x = asUnit(item.x)
    const y = asUnit(item.y)

    if (!id || !label || x === null || y === null) {
      continue
    }

    items.push({ id, label, x, y })
  }

  return {
    items,
    x: readAxis(axes.x, 'low', 'high'),
    y: readAxis(axes.y, 'low', 'high')
  }
}

// Percentage geometry only — the renderer owns pixels; the payload's 0..1 x/y
// carry meaning. y is inverted so semantic "high" sits at the top.
const toStyle = (item: QuadrantItem) => ({
  left: `${item.x * 100}%`,
  top: `${(1 - item.y) * 100}%`
})

export function QuadrantRenderer({ artifact }: { artifact: KindArtifactLike }) {
  const model = readQuadrant(artifact.payload)

  if (model.items.length === 0) {
    return (
      <div
        className="flex flex-1 items-center justify-center p-6 text-center text-sm text-(--ui-text-tertiary)"
        data-testid="quadrant-empty"
      >
        No trade-offs plotted yet. Keep talking — the axes will fill in.
      </div>
    )
  }

  return (
    <div
      aria-label="Ideation quadrant"
      className="grid min-h-0 flex-1 grid-cols-[14px_1fr_14px] grid-rows-[14px_1fr_14px] gap-1.5 p-4 text-(--ui-text-primary)"
      data-testid="quadrant-canvas"
      role="group"
    >
      {/* y-high */}
      <div className="col-start-2 row-start-1 truncate text-center text-[10px] leading-[14px] font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
        {model.y.high}
      </div>

      {/* y-low */}
      <div className="col-start-2 row-start-3 truncate text-center text-[10px] leading-[14px] font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
        {model.y.low}
      </div>

      {/* x-low (rotated, reads bottom-to-top on the left edge) */}
      <div className="col-start-1 row-start-2 flex items-center justify-center">
        <span className="rotate-180 [writing-mode:vertical-rl] truncate text-[10px] font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
          {model.x.low}
        </span>
      </div>

      {/* x-high */}
      <div className="col-start-3 row-start-2 flex items-center justify-center">
        <span className="[writing-mode:vertical-rl] truncate text-[10px] font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
          {model.x.high}
        </span>
      </div>

      <div
        className="relative col-start-2 row-start-2 rounded-md border border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)/40"
        data-testid="quadrant-field"
      >
        {/* Axis crosshair at the semantic midpoint. */}
        <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-px bg-(--ui-stroke-secondary)" />
        <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-(--ui-stroke-secondary)" />

        {model.items.map(item => (
          <span
            className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border border-(--ui-accent) bg-(--ui-bg-primary) px-2 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap shadow-sm"
            data-testid="quadrant-item"
            data-x={item.x}
            data-y={item.y}
            key={item.id}
            style={toStyle(item)}
            title={item.label}
          >
            <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-(--ui-accent)" />
            <span className="max-w-32 truncate">{item.label}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default QuadrantRenderer
