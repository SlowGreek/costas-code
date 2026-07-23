const DEFAULT_BLOCKED_EGRESS_DOMAINS = ['nousresearch.com', 'nous.ai', 'posthog.com', 'langfuse.com']

function normalizeDomain(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, '')
}

export function blockedEgressDomains(configured = process.env.HERMES_BLOCKED_EGRESS_DOMAINS || ''): string[] {
  const values = [...DEFAULT_BLOCKED_EGRESS_DOMAINS, ...configured.split(',')]

  return [...new Set(values.map(normalizeDomain).filter(Boolean))]
}

export function isBlockedEgressUrl(rawUrl: string | URL, domains = blockedEgressDomains()): boolean {
  let hostname: string

  try {
    const url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || '').trim())
    hostname = normalizeDomain(url.hostname)
  } catch {
    return false
  }

  return domains.some(domain => hostname === domain || hostname.endsWith(`.${domain}`))
}
