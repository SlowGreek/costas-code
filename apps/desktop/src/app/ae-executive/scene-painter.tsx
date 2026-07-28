import {
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

import { type AeExecutiveScene, type UgSceneNode, validateExecutiveScene } from './scene'

interface AeScenePainterProps {
  scene: AeExecutiveScene
  onAction?: (action: string) => void
  onEvent?: (event: UguiSceneEvent) => void
  depth?: number
}

export interface UguiSceneEvent {
  schema: 'ugui-scene-event/1'
  scene_id: string
  revision: number
  node_id: string
  gesture: 'change' | 'drag' | 'focus' | 'key' | 'longpress' | 'submit' | 'tap'
  action: string
  payload: null | { value: string }
}

interface SelectionRect extends CSSProperties {
  left: number
  top: number
  width: number
  height: number
}

const TEXT_SIZE: Record<string, string> = { s: 'text-[0.72rem]', m: 'text-sm', l: 'text-lg', xl: 'text-2xl' }
const MAX_NESTED_SCENE_DEPTH = 2
const NESTED_SCENE_CATALOGS = new Set(['scene', 'system-shell', 'system-shell-scene', 'ugui-scene'])

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

const nodeData = (node: UgSceneNode) => ({ 'data-ugui-node-id': node.id }) as const

export function AeScenePainter({ depth = 0, scene, onAction, onEvent }: AeScenePainterProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const nodes = useMemo(() => new Map(scene.nodes.map(node => [node.id, node])), [scene])

  const editor = scene.receipt?.editor && typeof scene.receipt.editor === 'object'
    ? scene.receipt.editor as Record<string, unknown>
    : null

  const selectableNodeIds = useMemo(() => new Set(
    Array.isArray(editor?.selectable_node_ids)
      ? editor.selectable_node_ids.filter((id): id is string => typeof id === 'string' && nodes.has(id))
      : []
  ), [editor, nodes])

  const selectedNodeId = typeof editor?.selected_node_id === 'string' && selectableNodeIds.has(editor.selected_node_id)
    ? editor.selected_node_id
    : null

  useEffect(() => {
    const root = rootRef.current

    if (!root || !selectedNodeId) {
      setSelectionRect(null)

      return
    }

    const findSelected = () => [...root.querySelectorAll<HTMLElement>('[data-ugui-node-id]')]
      .find(element => element.dataset.uguiNodeId === selectedNodeId) ?? null

    const update = () => {
      const selected = findSelected()

      if (!selected) {
        setSelectionRect(null)

        return
      }

      const rootBounds = root.getBoundingClientRect()
      const selectedBounds = selected.getBoundingClientRect()

      setSelectionRect({
        left: selectedBounds.left - rootBounds.left + root.scrollLeft,
        top: selectedBounds.top - rootBounds.top + root.scrollTop,
        width: selectedBounds.width,
        height: selectedBounds.height
      })
    }

    update()
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)

    resize?.observe(root)
    const selected = findSelected()

    if (selected) {resize?.observe(selected)}
    root.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)

    return () => {
      resize?.disconnect()
      root.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [scene, selectedNodeId])

  const emit = (node: UgSceneNode, gesture: UguiSceneEvent['gesture'], action: string, payload: UguiSceneEvent['payload']) => {
    if (onEvent) {
      onEvent({
        schema: 'ugui-scene-event/1',
        scene_id: scene.id ?? scene.root,
        revision: typeof scene.receipt?.revision === 'number' ? scene.receipt.revision : 0,
        node_id: node.id,
        gesture,
        action,
        payload
      })
    } else {
      onAction?.(action)
    }
  }

  const interactionProps = (node: UgSceneNode): HTMLAttributes<HTMLElement> => {
    const handlers = node.on ?? {}
    const keyboardAction = handlers.key || handlers.tap
    const name = stringAttr(node, 'name') || stringAttr(node, 'label') || node.id

    if (!Object.keys(handlers).length) {return {}}

    return {
      'aria-label': name,
      draggable: Boolean(handlers.drag),
      onClick: handlers.tap ? () => emit(node, 'tap', handlers.tap!, null) : undefined,
      onContextMenu: handlers.longpress
        ? event => {
            event.preventDefault()
            emit(node, 'longpress', handlers.longpress!, null)
          }
        : undefined,
      onDragEnd: handlers.drag ? () => emit(node, 'drag', handlers.drag!, null) : undefined,
      onFocus: handlers.focus ? () => emit(node, 'focus', handlers.focus!, null) : undefined,
      onKeyDown: keyboardAction
        ? (event: KeyboardEvent<HTMLElement>) => {
            if (event.key !== 'Enter' && event.key !== ' ') {return}
            event.preventDefault()
            emit(node, handlers.key ? 'key' : 'tap', keyboardAction, null)
          }
        : undefined,
      role: stringAttr(node, 'role') || 'button',
      tabIndex: 0
    }
  }

  const paint = (id: string): ReactNode => {
    const node = nodes.get(id)

    if (!node) {return <SceneRefusal code="node-unavailable" detail={id} key={id} />}

    const rendered = paintNode(node)

    if (!selectableNodeIds.has(node.id)) {return rendered}

    return (
      <div
        aria-label={`Select ${stringAttr(node, 'name') || stringAttr(node, 'label') || node.p} ${node.id}`}
        aria-selected={selectedNodeId === node.id}
        className="relative min-w-0 rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-(--theme-primary)"
        data-ugui-node-id={node.id}
        key={`studio-select-${node.id}`}
        onClick={event => {
          event.stopPropagation()
          emit(node, 'focus', 'studio.element.select', { value: node.id })
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            emit(node, 'focus', 'studio.element.select', { value: node.id })
          }
        }}
        role="option"
        tabIndex={0}
      >
        {rendered}
      </div>
    )
  }

  const paintNode = (node: UgSceneNode): ReactNode => {
    switch (node.p) {
      case 'column':
        return (
          <div
            {...layoutData(node)}
            {...nodeData(node)}
            {...interactionProps(node)}
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
            {...nodeData(node)}
            {...interactionProps(node)}
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
            {...nodeData(node)}
            {...interactionProps(node)}
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
            {...nodeData(node)}
            aria-live={stringAttr(node, 'role') === 'status' ? 'polite' : undefined}
            className={cn(
              'min-w-0 whitespace-pre-wrap font-mono leading-relaxed',
              TEXT_SIZE[stringAttr(node, 'size')] ?? TEXT_SIZE.m,
              stringAttr(node, 'weight') === 'bold' && 'font-semibold',
              layoutClass(node)
            )}
            key={node.id}
            role={stringAttr(node, 'role') || undefined}
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
            {...nodeData(node)}
            aria-current={stringAttr(node, 'role') === 'tab' && attr(node, 'primary') === true ? 'page' : undefined}
            aria-label={stringAttr(node, 'name') || stringAttr(node, 'label') || node.id}
            className={cn('w-fit justify-start font-mono', layoutClass(node))}
            disabled={!action || attr(node, 'disabled') === true}
            key={node.id}
            onClick={() => action && emit(node, 'tap', action, null)}
            onFocus={() => node.on?.focus && emit(node, 'focus', node.on.focus, null)}
            onKeyDown={event => {
              if (!node.on?.key || (event.key !== 'Enter' && event.key !== ' ')) {return}
              event.preventDefault()
              emit(node, 'key', node.on.key, null)
            }}
            role={stringAttr(node, 'role') === 'tab' ? 'tab' : undefined}
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
            {...nodeData(node)}
            aria-label={stringAttr(node, 'name') || stringAttr(node, 'placeholder') || node.id}
            className={layoutClass(node)}
            key={node.id}
            onChange={event => setInputs(current => ({ ...current, [node.id]: event.target.value }))}
            onKeyDown={event =>
              event.key === 'Enter' && node.on?.submit && emit(node, 'submit', node.on.submit, { value })
            }
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
            {...nodeData(node)}
            aria-label={stringAttr(node, 'name') || node.id}
            className={cn(
              'h-8 rounded border border-(--ui-stroke-secondary) bg-background px-2 font-mono text-xs',
              layoutClass(node)
            )}
            defaultValue={stringAttr(node, 'value')}
            key={node.id}
            onChange={event =>
              node.on?.change && emit(node, 'change', node.on.change, { value: event.target.value })
            }
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
            {...nodeData(node)}
            key={node.id}
            value={Math.min(1, Math.max(0, numberAttr(node, 'value')))}
          />
        )

      case 'divider':
        return <div {...layoutData(node)} {...nodeData(node)} className={cn('h-px', layoutClass(node))} key={node.id} role="separator" style={{ background: resolveColor(stringAttr(node, 'color')) }} />

      case 'spacer':
        return <div {...layoutData(node)} {...nodeData(node)} aria-hidden="true" className={layoutClass(node)} key={node.id} style={{ height: numberAttr(node, 'size', 8) }} />

      case 'image':
        if (stringAttr(node, 'src').startsWith('asset://')) {
          return (
            <div {...layoutData(node)} {...nodeData(node)} className={layoutClass(node)} key={node.id}>
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
            {...nodeData(node)}
            alt={stringAttr(node, 'alt') || stringAttr(node, 'text-alt')}
            className={cn('max-h-full max-w-full rounded object-contain', layoutClass(node))}
            key={node.id}
            src={stringAttr(node, 'src')}
          />
        )

      case 'canvas':
        return <UguiCanvas key={node.id} node={node} />

      case 'native':
        if (NESTED_SCENE_CATALOGS.has(stringAttr(node, 'catalog'))) {
          return (
            <NestedScene
              depth={depth}
              key={node.id}
              node={node}
              onAction={onAction}
              onEvent={onEvent}
            />
          )
        }

        return (
          <div {...nodeData(node)} key={node.id}>
            <SceneRefusal
              code="native-realization-unavailable"
              detail={stringAttr(node, 'placeholder') || stringAttr(node, 'catalog') || node.id}
            />
          </div>
        )

      default:
        return <SceneRefusal code="primitive-unavailable" detail={`${node.p}:${node.id}`} key={node.id} />
    }
  }

  return (
    <section
      aria-label="UGUI Scene"
      className="relative h-full min-h-0 overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--ui-chat-surface-background)_86%,transparent)] p-5 shadow-sm motion-reduce:scroll-auto motion-reduce:transition-none"
      data-scene-depth={depth}
      data-scene-root={scene.root}
      data-scene-version={scene.sceneVersion}
      ref={rootRef}
    >
      <VisualLossReceipt receipt={scene.receipt} />
      {paint(scene.root)}
      {selectionRect && selectedNodeId ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute z-50 rounded-[3px] border-2 border-(--theme-primary) shadow-[0_0_0_1px_color-mix(in_srgb,var(--theme-primary)_35%,transparent)]"
          data-ugui-selection-overlay={selectedNodeId}
          style={selectionRect}
        >
          <span className="absolute -top-5 left-0 rounded-sm bg-(--theme-primary) px-1.5 py-0.5 font-mono text-[0.6rem] leading-none text-white">
            {selectedNodeId}
          </span>
        </div>
      ) : null}
    </section>
  )
}

function UguiCanvas({ node }: { node: UgSceneNode }) {
  const width = Math.max(1, numberAttr(node, 'w', 640))
  const height = Math.max(1, numberAttr(node, 'h', 360))
  const operations = Array.isArray(attr(node, 'ops')) ? (attr(node, 'ops') as Array<Record<string, unknown>>) : []
  const alt = stringAttr(node, 'text-alt')

  return (
    <figure className="grid gap-1.5 overflow-x-auto" {...nodeData(node)}>
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

function NestedScene({
  depth,
  node,
  onAction,
  onEvent
}: {
  depth: number
  node: UgSceneNode
  onAction?: (action: string) => void
  onEvent?: (event: UguiSceneEvent) => void
}) {
  if (depth >= MAX_NESTED_SCENE_DEPTH) {
    return <SceneRefusal code="scene-recursion-refused" detail={`depth-${depth + 1}`} />
  }

  const spec = objectAttr(node, 'spec')
  const candidate = spec?.scene ?? spec?.sceneJson
  let nested: unknown = candidate

  if (typeof candidate === 'string') {
    if (candidate.length > 512 * 1024) {
      return <SceneRefusal code="nested-scene-bound" detail={node.id} />
    }

    try {
      nested = JSON.parse(candidate)
    } catch {
      return <SceneRefusal code="nested-scene-json" detail={node.id} />
    }
  }

  try {
    validateExecutiveScene(nested as AeExecutiveScene)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : 'invalid'

    return <SceneRefusal code="nested-scene-invalid" detail={detail} />
  }

  return (
    <div
      {...nodeData(node)}
      aria-label={stringAttr(node, 'name') || `Nested UGUI Scene ${node.id}`}
      className="h-full min-h-0 overflow-hidden rounded-lg border border-(--ui-stroke-secondary) p-2 motion-reduce:transition-none"
      data-ugui-recursion-depth={depth + 1}
      role="group"
    >
      <AeScenePainter
        depth={depth + 1}
        onAction={onAction}
        onEvent={onEvent}
        scene={nested as AeExecutiveScene}
      />
    </div>
  )
}

function objectAttr(node: UgSceneNode, key: string): Record<string, unknown> | null {
  const value = attr(node, key)

  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function VisualLossReceipt({ receipt }: { receipt: AeExecutiveScene['receipt'] }) {
  if (!receipt) {return null}
  const render = receipt.render && typeof receipt.render === 'object' && !Array.isArray(receipt.render)
    ? receipt.render as Record<string, unknown>
    : null
  const raw = receipt.namedLosses ?? receipt.named_losses ?? render?.namedLosses ?? render?.named_losses
  const losses = Array.isArray(raw)
    ? [...new Set(raw.filter((loss): loss is string => typeof loss === 'string' && loss.length > 0 && loss.length <= 256))]
      .slice(0, 32)
    : []

  if (!losses.length) {return null}

  return (
    <aside
      aria-label="Visual loss receipt"
      className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 font-mono text-[0.68rem] text-amber-700"
      data-ugui-visual-loss-count={losses.length}
      role="status"
    >
      Visual loss receipt · {losses.join(' · ')}
    </aside>
  )
}

function SceneRefusal({ code, detail }: { code: string; detail: string }) {
  return <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">UGUI refusal · {code} · {detail}</div>
}
