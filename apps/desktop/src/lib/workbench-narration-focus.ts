import type { WorkbenchNode } from '@/store/workbench'

/** Normalize speech and node names without introducing fuzzy referents. */
export function normalizeNarrationText(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Match exact normalized node labels/ids in narration. Labels are considered
 * longest-first so "API Gateway" wins over "Gateway". This is deliberately
 * pure and lexical: no model call, fuzzy search, or persistence belongs here.
 */
export function matchNarrationNode(
  transcript: string,
  nodes: readonly Pick<WorkbenchNode, 'id' | 'label'>[]
): null | string {
  const spoken = normalizeNarrationText(transcript)

  if (!spoken) {
    return null
  }

  const haystack = ` ${spoken} `

  const candidates = nodes.flatMap(node => {
    const label = normalizeNarrationText(node.label)
    const id = normalizeNarrationText(node.id)

    const names = [
      ...(label.replace(/\s/g, '').length >= 3 ? [{ text: label, type: 'label' as const }] : []),
      ...(id ? [{ text: id, type: 'id' as const }] : [])
    ]

    return names.map(name => ({ ...name, nodeId: node.id }))
  })

  const matches = candidates
    .map(candidate => {
      const needle = ` ${candidate.text} `
      const start = haystack.lastIndexOf(needle)

      return { ...candidate, end: start < 0 ? -1 : start + needle.length }
    })
    .filter(candidate => candidate.end >= 0)

  // Follow speech chronologically. If two names end at the same position
  // ("API Gateway" and "Gateway" in the same phrase), the longer exact label
  // wins; otherwise the latest completed mention wins, regardless of length.
  matches.sort((left, right) => {
    const recency = right.end - left.end

    if (recency) {
      return recency
    }

    const length = right.text.length - left.text.length

    return length || (left.type === right.type ? 0 : left.type === 'label' ? -1 : 1)
  })

  return matches[0]?.nodeId ?? null
}
