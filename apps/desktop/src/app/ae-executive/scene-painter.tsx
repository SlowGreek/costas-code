import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

import type { AeExecutiveScene, UgSceneNode } from './scene'

interface AeScenePainterProps {
  scene: AeExecutiveScene
  onAction?: (action: string) => void
  onEvent?: (event: UguiSceneEvent) => void
}

export interface UguiSceneEvent {
  schema: 'ugui-scene-event/1'
  scene_id: string
  revision: number
  node_id: string
  gesture: 'change' | 'focus' | 'key' | 'submit' | 'tap'
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

export function AeScenePainter({ scene, onAction, onEvent }: AeScenePainterProps) {
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
    onEvent?.({
      schema: 'ugui-scene-event/1',
      scene_id: scene.id ?? scene.root,
      revision: typeof scene.receipt?.revision === 'number' ? scene.receipt.revision : 0,
      node_id: node.id,
      gesture,
      action,
      payload
    })
    onAction?.(action)
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
            onClick={() => action && emit(node, 'tap', action, null)}
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
        if (stringAttr(node, 'catalog') === 'shell-structural-viewport') {
          return <ShellViewportFrame key={node.id} model={attr(node, 'model')} />
        }

        return <SceneRefusal code="native-realization-unavailable" detail={stringAttr(node, 'catalog') || node.id} key={node.id} />

      default:
        return <SceneRefusal code="primitive-unavailable" detail={`${node.p}:${node.id}`} key={node.id} />
    }
  }

  return (
    <section
      aria-label="UGUI Scene"
      className="relative h-full min-h-0 overflow-hidden rounded-xl border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--ui-chat-surface-background)_86%,transparent)] p-5 shadow-sm"
      data-scene-root={scene.root}
      data-scene-version={scene.sceneVersion}
      ref={rootRef}
    >
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

function ShellViewportFrame({ model }: { model: unknown }) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return <SceneRefusal code="shell-viewport-model" detail="invalid" />
  }

  const row = model as Record<string, unknown>
  const geometry = row.geometry && typeof row.geometry === 'object' ? (row.geometry as Record<string, unknown>) : {}
  const viewport = geometry.viewport && typeof geometry.viewport === 'object' ? (geometry.viewport as Record<string, unknown>) : {}
  const width = typeof viewport.width === 'number' && viewport.width > 0 ? viewport.width : 1280
  const height = typeof viewport.height === 'number' && viewport.height > 0 ? viewport.height : 720
  const ratio = Math.max(0.2, Math.min(5, width / height))
  const formFactor = typeof row.form_factor === 'string' ? row.form_factor : 'desktop'
  const shell = typeof row.shell_id === 'string' ? row.shell_id : 'unknown-shell'
  const warning = typeof row.warning === 'string' ? row.warning : 'STRUCTURAL PROJECTION'
  const chrome = Array.isArray(row.chrome) ? row.chrome.filter((item): item is string => typeof item === 'string') : []

  return (
    <div className="grid min-h-72 place-items-center overflow-auto rounded-(--morph-radius-md) border border-(--morph-border-color) bg-(--morph-desktop) p-(--morph-spacing)" data-shell-form-factor={formFactor} data-shell-target={shell}>
      <div
        className="relative grid max-h-[34rem] min-h-52 w-full max-w-4xl overflow-hidden border-[length:var(--morph-stroke-width)] border-(--morph-border-color) bg-(--morph-surface) text-(--morph-on-surface) shadow-[var(--morph-shadow)]"
        style={{
          aspectRatio: String(ratio),
          borderRadius: formFactor === 'handset' ? 'min(12%, var(--morph-radius-lg))' : 'var(--morph-radius-md)'
        }}
      >
        {chrome.includes('status-bar') || chrome.includes('title-bar') ? (
          <div className="flex h-7 items-center justify-between bg-(--morph-titlebar) px-3 text-[0.65rem] font-semibold">
            <span>{shell}</span>
            <span>{Math.round(width)}×{Math.round(height)}</span>
          </div>
        ) : null}
        <div className="grid min-h-0 place-items-center p-4">
          <div className="grid max-w-sm gap-3 rounded-(--morph-radius-md) border border-(--morph-border-color) bg-(--morph-surface) p-4 shadow-[var(--morph-shadow)]">
            <div className="text-sm font-semibold">Same semantic GenUI experience</div>
            <div className="text-xs opacity-75">One identity and action set. Shell constraints alter projection, not meaning.</div>
            <Button size="sm">Inspect evidence</Button>
          </div>
        </div>
        <div className="border-t border-(--morph-border-color) px-2 py-1 text-center font-mono text-[0.6rem] uppercase tracking-wide">
          STRUCTURE ONLY · AUTHORITY NONE · NOT RUN · {warning}
        </div>
      </div>
    </div>
  )
}

function SceneRefusal({ code, detail }: { code: string; detail: string }) {
  return <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">UGUI refusal · {code} · {detail}</div>
}
