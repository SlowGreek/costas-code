import { type ReactNode, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'

import type { AeExecutiveScene, AeSceneNode } from './scene'

interface AeScenePainterProps {
  scene: AeExecutiveScene
  onAction: (action: string) => void
}

const TEXT_SIZE = {
  s: 'text-[0.72rem]',
  m: 'text-sm',
  l: 'text-lg',
  xl: 'text-2xl tracking-tight'
} as const

const TEXT_TONE = {
  muted: 'text-(--ui-text-tertiary)',
  normal: 'text-foreground',
  positive: 'text-emerald-500 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400'
} as const

export function AeScenePainter({ scene, onAction }: AeScenePainterProps) {
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const nodes = useMemo(() => new Map(scene.nodes.map(node => [node.id, node])), [scene])

  const paint = (id: string): ReactNode => {
    const node = nodes.get(id)

    if (!node) {
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive" key={id}>
          Scene node unavailable · {id}
        </div>
      )
    }

    switch (node.p) {
      case 'column':
        return (
          <div className="flex min-w-0 flex-col" key={node.id} style={{ gap: node.a?.gap ?? 8 }}>
            {node.kids.map(paint)}
          </div>
        )
      case 'row':
        return (
          <div className="flex min-w-0 flex-wrap items-center" key={node.id} style={{ gap: node.a?.gap ?? 8 }}>
            {node.kids.map(paint)}
          </div>
        )
      case 'text':
        return (
          <p
            className={cn(
              'min-w-0 whitespace-pre-wrap leading-relaxed',
              TEXT_SIZE[node.a.size ?? 'm'],
              TEXT_TONE[node.a.tone ?? 'normal'],
              node.a.weight === 'bold' && 'font-semibold'
            )}
            key={node.id}
          >
            {node.a.text}
          </p>
        )
      case 'divider':
        return <div className="h-px bg-(--ui-stroke-tertiary)" key={node.id} role="separator" />
      case 'progress':
        return (
          <div className="grid gap-1.5" key={node.id}>
            <div className="flex items-center justify-between gap-3 text-xs">
              <span className="text-(--ui-text-secondary)">{node.a.label}</span>
              <span className="font-mono text-(--ui-text-tertiary)">{Math.round(node.a.value * 100)}%</span>
            </div>
            <Progress aria-label={node.a.label} value={node.a.value} />
          </div>
        )
      case 'button':
        return (
          <Button
            className="w-fit"
            key={node.id}
            onClick={() => onAction(node.on.tap)}
            size="sm"
            variant={node.a.primary ? 'default' : 'outline'}
          >
            {node.a.label}
          </Button>
        )
      case 'input':
        return (
          <label className="grid gap-1.5" key={node.id}>
            <span className="text-xs font-medium text-(--ui-text-secondary)">{node.a.label}</span>
            <Input
              aria-label={node.a.label}
              onChange={event => setInputs(current => ({ ...current, [node.id]: event.target.value }))}
              onKeyDown={event => {
                if (event.key === 'Enter' && node.on?.change) {
                  onAction(`${node.on.change}:${inputs[node.id] ?? ''}`)
                }
              }}
              placeholder={node.a.placeholder}
              value={inputs[node.id] ?? node.a.value ?? ''}
            />
          </label>
        )
      default: {
        const exhaustive: never = node
        return exhaustive
      }
    }
  }

  return (
    <section
      aria-label={`AE ${scene.tab} Scene`}
      className="rounded-xl border border-(--ui-stroke-tertiary) bg-[color-mix(in_srgb,var(--ui-chat-surface-background)_86%,transparent)] p-5 shadow-sm"
      data-scene-revision={scene.revision}
      data-scene-version={scene.sceneVersion}
    >
      {paint(scene.root)}
    </section>
  )
}

export function validateExecutiveScene(scene: AeExecutiveScene): readonly string[] {
  const errors: string[] = []
  const ids = new Set<string>()

  if (scene.sceneVersion !== '1.0.0') errors.push('scene-version')

  for (const node of scene.nodes) {
    if (!node.id || ids.has(node.id)) errors.push(`node-id:${node.id || 'empty'}`)
    ids.add(node.id)
  }

  if (!ids.has(scene.root)) errors.push('root-missing')

  for (const node of scene.nodes) {
    if ((node.p === 'column' || node.p === 'row') && node.kids.some(id => !ids.has(id))) {
      errors.push(`child-missing:${node.id}`)
    }
    if (node.p === 'progress' && (node.a.value < 0 || node.a.value > 1)) {
      errors.push(`progress-bounds:${node.id}`)
    }
  }

  return errors
}
