import { type CSSProperties, type ReactNode, useMemo, useState } from 'react'

import {
  type UguiDocument,
  type UguiDocumentItem,
  type UguiDocumentValue,
  validateUguiDocument
} from '@hermes/shared/ugui-document'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

interface UguiDocumentPainterProps {
  document: UguiDocument
  onAction?: (action: string) => void
  onEvent?: (event: UguiDocumentEvent) => void
}

export interface UguiDocumentEvent {
  schema: 'ugui-document-event/1'
  document_id: string
  item_id: string
  gesture: 'change' | 'focus' | 'key' | 'submit' | 'tap'
  action: string
  payload: null | { value: string }
}

const MAX_PAINT_DEPTH = 64

const object = (value: unknown): value is UguiDocumentItem =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value))

const text = (item: UguiDocumentItem, ...keys: string[]) => {
  for (const key of keys) {
    if (typeof item[key] === 'string') {return item[key] as string}
  }

  return ''
}

const number = (item: UguiDocumentItem, key: string, fallback = 0) =>
  typeof item[key] === 'number' ? Number(item[key]) : fallback

const itemStyle = (item: UguiDocumentItem): CSSProperties | undefined => {
  const width = item.width

  return Number.isInteger(width) && Number(width) >= 1 && Number(width) <= 12
    ? { gridColumn: `span ${Number(width)} / span ${Number(width)}` }
    : undefined
}

const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) {return 'UNAVAILABLE'}
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }

  return JSON.stringify(value)
}

export function UguiDocumentPainter({ document, onAction, onEvent }: UguiDocumentPainterProps) {
  const admitted = useMemo(() => validateUguiDocument(document), [document])
  const [inputs, setInputs] = useState<Record<string, string>>({})

  const emit = (
    item: UguiDocumentItem,
    path: string,
    gesture: UguiDocumentEvent['gesture'],
    action: string,
    payload: UguiDocumentEvent['payload']
  ) => {
    if (onEvent) {
      onEvent({
        schema: 'ugui-document-event/1',
        document_id: admitted.id,
        item_id: text(item, 'id') || path,
        gesture,
        action,
        payload
      })
    } else {
      onAction?.(action)
    }
  }

  const paintValues = (values: UguiDocumentValue[], path: string, depth: number): ReactNode => {
    if (depth > MAX_PAINT_DEPTH) {return <DocumentRefusal code="depth" detail={path} />}

    return values.map((value, index) => paintValue(value, `${path}.${index}`, depth + 1))
  }

  const paintValue = (value: UguiDocumentValue, path: string, depth: number): ReactNode => {
    if (Array.isArray(value)) {
      return <div className="grid min-w-0 gap-2" key={path}>{paintValues(value, path, depth)}</div>
    }

    if (!object(value)) {
      return <span className="min-w-0 break-words text-sm text-foreground" key={path}>{displayValue(value)}</span>
    }

    const kind = text(value, 'type') || 'value'
    const id = text(value, 'id') || path
    const label = text(value, 'label', 'title', 'name', 'body', 'text') || id
    const action = text(value, 'action')
    const style = itemStyle(value)
    const key = `${path}:${id}`

    if (kind === 'text') {
      const variant = text(value, 'style')

      return (
        <div
          className={cn(
            'min-w-0 break-words',
            variant === 'heading' && 'text-base font-semibold text-foreground',
            variant === 'subtitle' && 'text-sm font-medium text-foreground',
            variant === 'caption' && 'text-xs text-muted-foreground',
            variant === 'code' && 'font-mono text-xs text-foreground',
            !['heading', 'subtitle', 'caption', 'code'].includes(variant) && 'text-sm text-foreground'
          )}
          data-ugui-item-id={id}
          key={key}
          style={style}
        >
          {text(value, 'body', 'text', 'label')}
        </div>
      )
    }

    if (kind === 'button' || kind === 'tool') {
      return (
        <Button
          data-ugui-item-id={id}
          disabled={value.disabled === true}
          key={key}
          onClick={() => emit(value, path, 'tap', action || id, null)}
          size="sm"
          style={style}
          variant={value.primary === true || value.style === 'primary' ? 'default' : 'secondary'}
        >
          {label}
        </Button>
      )
    }

    if (kind === 'input') {
      const current = inputs[id] ?? text(value, 'value', 'default')

      return (
        <label className="grid min-w-0 gap-1" data-ugui-item-id={id} key={key} style={style}>
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <Input
            onChange={event => {
              const next = event.target.value
              setInputs(state => ({ ...state, [id]: next }))
              if (action) {emit(value, path, 'change', action, { value: next })}
            }}
            onKeyDown={event => {
              if (event.key === 'Enter' && action) {emit(value, path, 'submit', action, { value: current })}
            }}
            placeholder={text(value, 'placeholder')}
            value={current}
          />
        </label>
      )
    }

    if (kind === 'select') {
      const options = Array.isArray(value.options) ? value.options : []
      const current = inputs[id] ?? text(value, 'value', 'default')

      return (
        <label className="grid min-w-0 gap-1" data-ugui-item-id={id} key={key} style={style}>
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          <select
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground"
            onChange={event => {
              const next = event.target.value
              setInputs(state => ({ ...state, [id]: next }))
              if (action) {emit(value, path, 'change', action, { value: next })}
            }}
            value={current}
          >
            {options.map((option, index) => {
              const optionValue = object(option) ? text(option, 'value', 'id', 'label') : String(option)
              const optionLabel = object(option) ? text(option, 'label', 'value', 'id') : String(option)

              return <option key={`${key}:option:${index}`} value={optionValue}>{optionLabel}</option>
            })}
          </select>
        </label>
      )
    }

    if (kind === 'slider' || kind === 'stepper') {
      const current = inputs[id] ?? String(number(value, 'value', number(value, 'min')))

      return (
        <label className="grid min-w-0 gap-1" data-ugui-item-id={id} key={key} style={style}>
          <span className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
            <span>{label}</span><span className="font-mono text-foreground">{current}</span>
          </span>
          <input
            className="w-full accent-(--theme-primary)"
            max={number(value, 'max', 100)}
            min={number(value, 'min')}
            onChange={event => {
              const next = event.target.value
              setInputs(state => ({ ...state, [id]: next }))
              if (action) {emit(value, path, 'change', action, { value: next })}
            }}
            step={number(value, 'step', 1)}
            type={kind === 'slider' ? 'range' : 'number'}
            value={current}
          />
        </label>
      )
    }

    if (['progress', 'ratio', 'milli-percent'].includes(kind)) {
      const raw = number(value, 'value', number(value, 'current'))
      const maximum = number(value, 'max', kind === 'milli-percent' ? 1000 : 100)
      const percent = maximum > 0 ? Math.max(0, Math.min(100, raw / maximum * 100)) : 0

      return (
        <div className="grid min-w-0 gap-1" data-ugui-item-id={id} key={key} style={style}>
          <div className="flex justify-between gap-2 text-xs text-muted-foreground"><span>{label}</span><span>{Math.round(percent)}%</span></div>
          <Progress value={percent} />
        </div>
      )
    }

    if (kind === 'status_grid' || kind === 'key_value') {
      const items = Array.isArray(value.items) ? value.items : []

      return (
        <dl className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1 border-l-2 border-(--ui-stroke-tertiary) pl-3 text-xs" data-ugui-item-id={id} key={key} style={style}>
          {items.map((item, index) => {
            const row = object(item) ? item : { value: item }

            return [
              <dt className="truncate text-muted-foreground" key={`${key}:label:${index}`}>{text(row, 'label', 'key', 'id') || `Item ${index + 1}`}</dt>,
              <dd className="min-w-0 break-words font-mono text-foreground" key={`${key}:value:${index}`}>{displayValue(row.value ?? row.body ?? row.status)}</dd>
            ]
          })}
        </dl>
      )
    }

    if (kind === 'data_table') {
      const columns = Array.isArray(value.columns) ? value.columns : []
      const rows = Array.isArray(value.rows) ? value.rows : []

      return (
        <div className="min-w-0 overflow-auto" data-ugui-item-id={id} key={key} style={style}>
          {text(value, 'heading') ? <div className="mb-1 text-sm font-semibold">{text(value, 'heading')}</div> : null}
          <table className="w-full border-collapse text-left text-xs">
            <thead><tr>{columns.map((column, index) => <th className="border-b border-border px-2 py-1 text-muted-foreground" key={`${key}:head:${index}`}>{object(column) ? text(column, 'label', 'id') : String(column)}</th>)}</tr></thead>
            <tbody>{rows.map((row, rowIndex) => <tr key={`${key}:row:${rowIndex}`}>{(Array.isArray(row) ? row : object(row) ? columns.map(column => object(column) ? row[text(column, 'id')] : null) : [row]).map((cell, cellIndex) => <td className="border-b border-border/60 px-2 py-1 align-top" key={`${key}:cell:${rowIndex}:${cellIndex}`}>{displayValue(cell)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )
    }

    if (kind === 'metric_grid') {
      const metrics = Array.isArray(value.metrics) ? value.metrics : []

      return (
        <section className="grid min-w-0 gap-2" data-ugui-item-id={id} key={key} style={style}>
          {text(value, 'heading') ? <h3 className="text-sm font-semibold">{text(value, 'heading')}</h3> : null}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-px overflow-hidden rounded-md border border-border bg-border">
            {metrics.map((metric, index) => {
              const row = object(metric) ? metric : { value: metric }

              return <div className="min-w-0 bg-background p-2" key={`${key}:metric:${index}`}><div className="truncate text-xs text-muted-foreground">{text(row, 'label', 'id')}</div><div className="break-words font-mono text-sm font-semibold">{displayValue(row.value)}{row.unit ? ` ${row.unit}` : ''}</div></div>
            })}
          </div>
        </section>
      )
    }

    if (kind === 'list' || kind === 'alert_list' || kind === 'log_stream') {
      const items = Array.isArray(value.items) ? value.items : Array.isArray(value.alerts) ? value.alerts : Array.isArray(value.lines) ? value.lines : []

      return (
        <section className="grid min-w-0 gap-1" data-ugui-item-id={id} key={key} style={style}>
          {text(value, 'heading') ? <h3 className="text-sm font-semibold">{text(value, 'heading')}</h3> : null}
          <div className={cn('grid gap-1', kind === 'log_stream' && 'font-mono text-xs')}>
            {items.map((item, index) => <div className="min-w-0 break-words border-l-2 border-(--ui-stroke-tertiary) pl-2" key={`${key}:item:${index}`}>{object(item) ? text(item, 'title', 'label', 'body', 'detail') || displayValue(item) : displayValue(item)}</div>)}
          </div>
        </section>
      )
    }

    if (kind === 'image' && text(value, 'src')) {
      return <img alt={text(value, 'alt', 'label') || ''} className="max-h-64 max-w-full object-contain" data-ugui-item-id={id} key={key} src={text(value, 'src')} style={style} />
    }

    const childFields = Object.entries(value).filter(([, child]) => Array.isArray(child))
    const scalarFields = Object.entries(value).filter(([field, child]) =>
      !['id', 'type', 'width', 'action'].includes(field) && !Array.isArray(child) && child !== null && typeof child !== 'object'
    )

    return (
      <section className="grid min-w-0 gap-2 border-l-2 border-(--ui-stroke-tertiary) pl-3" data-ugui-item-id={id} key={key} style={style}>
        {label !== id ? <h3 className="text-sm font-semibold text-foreground">{label}</h3> : null}
        {scalarFields.length > 0 ? <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">{scalarFields.flatMap(([field, fieldValue]) => [<dt className="text-muted-foreground" key={`${key}:${field}:label`}>{field}</dt>, <dd className="break-words font-mono" key={`${key}:${field}:value`}>{displayValue(fieldValue)}</dd>])}</dl> : null}
        {childFields.map(([field, children]) => <div className="grid min-w-0 gap-2" key={`${key}:${field}`}><div className="text-[0.7rem] font-medium uppercase text-muted-foreground">{field}</div>{paintValues(children as UguiDocumentValue[], `${path}.${field}`, depth)}</div>)}
        {action ? <Button onClick={() => emit(value, path, 'tap', action, null)} size="sm" variant="secondary">{label}</Button> : null}
      </section>
    )
  }

  const region = (name: 'header' | 'sections' | 'actions', values: UguiDocumentValue[]) => (
    <section
      aria-label={`Document ${name}`}
      className={cn(
        'grid min-w-0 grid-cols-12 gap-2',
        name === 'sections' && 'min-h-0 content-start overflow-auto py-1',
        name === 'actions' && 'border-t border-border pt-2'
      )}
      data-ugui-document-region={name}
    >
      {values.map((value, index) => (
        <div className="col-span-12 min-w-0" key={`${name}:${index}`}>
          {paintValue(value, `${name}.${index}`, 1)}
        </div>
      ))}
    </section>
  )

  return (
    <article className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-2" data-ugui-document-id={admitted.id}>
      {region('header', admitted.header)}
      {region('sections', admitted.sections)}
      {region('actions', admitted.actions)}
    </article>
  )
}

function DocumentRefusal({ code, detail }: { code: string; detail: string }) {
  return <div className="border border-destructive/40 bg-destructive/5 p-2 font-mono text-xs text-destructive">UGUI Document refused · {code} · {detail}</div>
}
