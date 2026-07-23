import assert from 'node:assert/strict'

import { test } from 'vitest'

import { blockedEgressDomains, isBlockedEgressUrl } from './egress-policy'

test('blocks Nous Research and telemetry domains including subdomains', () => {
  assert.equal(isBlockedEgressUrl('https://portal.nousresearch.com/account'), true)
  assert.equal(isBlockedEgressUrl('https://hermes-agent.nousresearch.com/docs'), true)
  assert.equal(isBlockedEgressUrl('https://us.i.posthog.com/e'), true)
  assert.equal(isBlockedEgressUrl('https://cloud.langfuse.com/api'), true)
})

test('does not confuse blocked names with attacker-controlled suffixes', () => {
  assert.equal(isBlockedEgressUrl('https://nousresearch.com.example.org'), false)
  assert.equal(isBlockedEgressUrl('https://notnousresearch.com'), false)
  assert.equal(isBlockedEgressUrl('https://api.githubcopilot.com'), false)
})

test('merges configured domains with the privacy defaults', () => {
  const domains = blockedEgressDomains('telemetry.example.com, .Metrics.Example.com.')

  assert.ok(domains.includes('nousresearch.com'))
  assert.ok(domains.includes('telemetry.example.com'))
  assert.ok(domains.includes('metrics.example.com'))
  assert.equal(isBlockedEgressUrl('https://a.metrics.example.com/x', domains), true)
})

test('ignores malformed and non-host URLs', () => {
  assert.equal(isBlockedEgressUrl('not a URL'), false)
  assert.equal(isBlockedEgressUrl('file:///tmp/report.txt'), false)
})
