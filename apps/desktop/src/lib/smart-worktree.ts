const MUTATION_VERBS =
  /\b(add|apply|build|bump|change|configure|convert|create|delete|disable|drop|edit|enable|extract|fix|generate|hook up|implement|install|integrate|make|migrate|modify|move|optimize|patch|refactor|remove|rename|replace|rewrite|rework|set|split|swap|tweak|turn|update|upgrade|wire|write)\b/i

const MUTATION_LEAD =
  /^(?:please\s+|can you\s+|could you\s+|would you\s+|let'?s\s+|go ahead and\s+|i want you to\s+)*(?:add|apply|build|bump|change|configure|convert|create|delete|disable|drop|edit|enable|extract|fix|generate|hook up|implement|install|integrate|make|migrate|modify|move|optimize|patch|refactor|remove|rename|replace|rewrite|rework|set|split|swap|tweak|turn|update|upgrade|wire|write)\b/i

const READ_ONLY_LEAD =
  /^(?:analy[sz]e|compare|describe|explain|find|how|inspect|investigate|list|look at|review|show me|summarize|tell me|trace|walk me through|what|when|where|which|why)\b/i

const EXPLICIT_READ_ONLY = /\b(?:do not|don'?t|without)\s+(?:change|edit|modify|write)\b|\bread[- ]only\b/i

const FOLLOWED_BY_MUTATION =
  /\b(?:and|then|also)\s+(?:please\s+)?(?:add|apply|build|bump|change|configure|convert|create|delete|disable|drop|edit|enable|extract|fix|generate|hook up|implement|install|integrate|make|migrate|modify|move|optimize|patch|refactor|remove|rename|replace|rewrite|rework|set|split|swap|tweak|turn|update|upgrade|wire|write)\b/i

export function promptNeedsManagedWorktree(prompt: string): boolean {
  const text = prompt.trim()

  if (!text || text.startsWith('/') || EXPLICIT_READ_ONLY.test(text) || !MUTATION_VERBS.test(text)) {
    return false
  }

  if (MUTATION_LEAD.test(text) || FOLLOWED_BY_MUTATION.test(text)) {
    return true
  }

  return !READ_ONLY_LEAD.test(text) && !text.endsWith('?')
}

export function smartWorktreeLabel(prompt: string, now = Date.now()): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(word => !['a', 'an', 'and', 'please', 'the', 'to'].includes(word))
    .slice(0, 4)

  const slug = words.join('-').slice(0, 32).replace(/-+$/g, '') || 'work'

  return `managed-${slug}-${now.toString(36).slice(-6)}`
}
