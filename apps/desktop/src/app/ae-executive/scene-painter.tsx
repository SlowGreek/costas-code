import { type ReactNode, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

import type { AeExecutiveScene, UgSceneNode } from './scene'

interface AeScenePainterProps {
  scene: AeExecutiveScene
  onAction: (action: string) => void
}

const TEXT_SIZE: Record<string, string> = { s: 'text-[0.72rem]', m: 'text-sm', l: 'text-lg', xl: 'text-2xl' }

const TOKEN_COLOR: Record<string, string> = {
  surface: 'var(--ui-chat-surface-background)',
  bg: 'var(--background)',
  ink: 'var(--foreground)',
  text: 'var(--foreground)',
  line: 'var(--ui-stroke-tertiary)',
  border: 'var(--ui-stroke-tertiary)',
  accent: 'var(--theme-primary)',
  primary: 'var(--theme-primary)',
  muted: 'var(--ui-text-tertiary)',
  danger: 'var(--destructive)',
  error: 'var(--destructive)'
}

const attr = (node: UgSceneNode, key: string) => node.a?.[key]
const stringAttr = (node: UgSceneNode, key: string) => (typeof attr(node, key) === 'string' ? String(attr(node, key)) : '')

const numberAttr = (node: UgSceneNode, key: string, fallback = 0) =>
  typeof attr(node, key) === 'number' ? Number(attr(node, key)) : fallback

const layoutHeight = (node: UgSceneNode) => node.layout?.height

const layoutClass = (node: UgSceneNode) =>
  layoutHeight(node) === '*' ? 'min-h-0 flex-1 overflow-auto' : layoutHeight(node) ? 'shrink-0' : undefined

const layoutData = (node: UgSceneNode) =>
  ({ 'data-ugui-height': layoutHeight(node) === undefined ? undefined : String(layoutHeight(node)) }) as const

export function AeScenePainter({ scene, onAction }: AeScenePainterProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const nodes = useMemo(() => new Map(scene.nodes.map(node => [node.id, node])), [scene])

  const paint = (id: string): ReactNode => {
    const node = nodes.get(id)

    if (!node) {return <SceneRefusal code="node-unavailable" detail={id} key={id} />}

    switch (node.p) {
      case 'column':
        return (
          <div
            {...layoutData(node)}
            className={cn('flex min-w-0 flex-col', node.id === scene.root && 'h-full min-h-0', layoutClass(node))}
            key={node.id}
            style={{ gap: numberAttr(node, 'gap', 8) }}
          >
            {(node.kids ?? []).map(paint)}
          </div>
        )

      case 'row':
        return (
          <div
            {...layoutData(node)}
            className={cn('flex min-w-0 flex-wrap items-center', layoutClass(node))}
            key={node.id}
            style={{ gap: numberAttr(node, 'gap', 8) }}
          >
            {(node.kids ?? []).map(paint)}
          </div>
        )

      case 'stack':
        return (
          <div
            {...layoutData(node)}
            className={cn('grid min-w-0 [&>*]:col-start-1 [&>*]:row-start-1', layoutClass(node))}
            key={node.id}
          >
            {(node.kids ?? []).map(paint)}
          </div>
        )

      case 'text':
        return (
          <p
            {...layoutData(node)}
            className={cn(
              'min-w-0 whitespace-pre-wrap font-mono leading-relaxed',
              TEXT_SIZE[stringAttr(node, 'size')] ?? TEXT_SIZE.m,
              stringAttr(node, 'weight') === 'bold' && 'font-semibold',
              layoutClass(node)
            )}
            key={node.id}
            style={{ color: resolveColor(stringAttr(node, 'color')) }}
          >
            {stringAttr(node, 'text')}
          </p>
        )
      case 'button': {
        const action = node.on?.tap || node.on?.key

        return (
          <Button
            {...layoutData(node)}
            aria-current={stringAttr(node, 'role') === 'tab' && attr(node, 'primary') === true ? 'page' : undefined}
            className={cn('w-fit justify-start font-mono', layoutClass(node))}
            disabled={!action || attr(node, 'disabled') === true}
            key={node.id}
            onClick={() => action && onAction(action)}
            size="sm"
            variant={attr(node, 'primary') === true ? 'default' : 'outline'}
          >
            {stringAttr(node, 'label')}
          </Button>
        )
      }

      case 'input': {
        const value = inputs[node.id] ?? stringAttr(node, 'value')

        return (
          <Input
            {...layoutData(node)}
            aria-label={stringAttr(node, 'name') || stringAttr(node, 'placeholder') || node.id}
            className={layoutClass(node)}
            key={node.id}
            onChange={event => setInputs(current => ({ ...current, [node.id]: event.target.value }))}
            onKeyDown={event => event.key === 'Enter' && node.on?.submit && onAction(node.on.submit)}
            placeholder={stringAttr(node, 'placeholder')}
            type={stringAttr(node, 'kind') || 'text'}
            value={value}
          />
        )
      }

      case 'select': {
        const options = Array.isArray(attr(node, 'options')) ? (attr(node, 'options') as unknown[]) : []

        return (
          <select
            {...layoutData(node)}
            aria-label={stringAttr(node, 'name') || node.id}
            className={cn(
              'h-8 rounded border border-(--ui-stroke-secondary) bg-background px-2 font-mono text-xs',
              layoutClass(node)
            )}
            defaultValue={stringAttr(node, 'value')}
            key={node.id}
            onChange={() => node.on?.change && onAction(node.on.change)}
          >
            {options.map((option, index) => {
              const value = typeof option === 'string' ? option : String((option as { value?: unknown }).value ?? index)
              const label = typeof option === 'string' ? option : String((option as { label?: unknown }).label ?? value)

              return (
                <option key={`${node.id}-${value}`} value={value}>
                  {label}
                </option>
              )
            })}
          </select>
        )
      }

      case 'progress':
        return (
          <Progress
            aria-label={stringAttr(node, 'name') || node.id}
            key={node.id}
            value={Math.min(1, Math.max(0, numberAttr(node, 'value')))}
          />
        )

      case 'divider':
        return <div {...layoutData(node)} className={cn('h-px', layoutClass(node))} key={node.id} role="separator" style={{ background: resolveColor(stringAttr(node, 'color')) }} />

      case 'spacer':
        return <div {...layoutData(node)} aria-hidden="true" className={layoutClass(node)} key={node.id} style={{ height: numberAttr(node, 'size', 8) }} />

      case 'image':
        if (stringAttr(node, 'src').startsWith('asset://')) {
          return (
            <div {...layoutData(node)} className={layoutClass(node)} key={node.id}>
              <SceneRefusal
                code="asset-catalog-unavailable"
                detail={stringAttr(node, 'alt') || stringAttr(node, 'src')}
              />
            </div>
          )
        }

        return (
          <img
            {...layoutData(node)}
            alt={stringAttr(node, 'alt') || stringAttr(node, 'text-alt')}
            className={cn('max-h-full max-w-full rounded object-contain', layoutClass(node))}
            key={node.id}
            src={stringAttr(node, 'src')}
          />
        )

      case 'canvas':
        return <UguiCanvas key={node.id} node={node} />

      case 'native':
        return <SceneRefusal code="native-realization-unavailable" detail={stringAttr(node, 'catalog') || node.id} key={node.id} />

      default:
        return <SceneRefusal code="primitive-unavailable" detail={`${node.p}:${node.id}`} key={node.id} />
    }
  }

  return (
    <section aria-label="UGUI Scene" className="h-full min-h-0 overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--ui-chat-surface-background)_86%,transparent)] p-5 shadow-sm" data-scene-root={scene.root} data-scene-version={scene.sceneVersion}>
      {paint(scene.root)}
    </section>
  )
}

function UguiCanvas({ node }: { node: UgSceneNode }) {
  const width = Math.max(1, numberAttr(node, 'w', 640))
  const height = Math.max(1, numberAttr(node, 'h', 360))
  const operations = Array.isArray(attr(node, 'ops')) ? (attr(node, 'ops') as Array<Record<string, unknown>>) : []
  const alt = stringAttr(node, 'text-alt')

  return (
    <figure className="grid gap-1.5 overflow-x-auto">
      <svg aria-label={alt || undefined} className="max-w-full" role={alt ? 'img' : undefined} viewBox={`0 0 ${width} ${height}`}>
        {operations.map((operation, index) => {
          const fill = resolveColor(String(operation.fill ?? 'text'))

          if (operation.op === 'rect') {
            return <rect fill={fill} height={Number(operation.h ?? 0)} key={`${node.id}-${index}`} width={Number(operation.w ?? 0)} x={Number(operation.x ?? 0)} y={Number(operation.y ?? 0)} />
          }

          if (operation.op === 'text') {
            return <text fill={fill} fontFamily="JetBrains Mono, monospace" fontSize={Number(operation.size ?? 12)} key={`${node.id}-${index}`} x={Number(operation.x ?? 0)} y={Number(operation.y ?? 0)}>{String(operation.text ?? '')}</text>
          }

          return null
        })}
      </svg>
      {alt && <figcaption className="sr-only">{alt}</figcaption>}
    </figure>
  )
}

function resolveColor(value: string): string | undefined {
  if (!value) {return undefined}

  if (TOKEN_COLOR[value]) {return TOKEN_COLOR[value]}

  return /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined
}

function SceneRefusal({ code, detail }: { code: string; detail: string }) {
  return <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">UGUI refusal · {code} · {detail}</div>
}
