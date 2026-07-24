/**
 * Tests for electron/update-remote.ts — the remote-detection helpers that
 * keep passive update checks off the SSH origin for official installs.
 *
 * Run with: node --test electron/update-remote.test.ts
 * (Wired into npm test:desktop:platforms in package.json.)
 *
 * Why this matters: a public install can carry
 * origin=git@github.com:SlowGreek/costas-code.git. A background
 * `git fetch origin` then authenticates over SSH and, with a FIDO2/passkey
 * key, triggers an unexplained hardware-touch prompt. isOfficialSshRemote
 * must reliably recognize the official SSH remote (in every URL form,
 * case-insensitively) so the caller can swap in the anonymous HTTPS path —
 * while NOT misclassifying forks, other hosts, or the HTTPS remote (which
 * never prompts and should keep the normal fetch path).
 */

import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  buildUpdateBranchArgs,
  canonicalGitHubRemote,
  DEFAULT_UPDATE_BRANCH,
  isOfficialSshRemote,
  isSshRemote,
  manualUpdateCommand,
  OFFICIAL_REPO_CANONICAL,
  OFFICIAL_REPO_HTTPS_URL,
  remoteTrackingRefspec,
  resolveUpdateBranch
} from './update-remote'

test('canonicalGitHubRemote normalizes SSH and HTTPS forms to the same value', () => {
  assert.equal(canonicalGitHubRemote('git@github.com:SlowGreek/costas-code.git'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('git@github.com:SlowGreek/costas-code'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('ssh://git@github.com/SlowGreek/costas-code.git'), OFFICIAL_REPO_CANONICAL)
  assert.equal(canonicalGitHubRemote('https://github.com/SlowGreek/costas-code.git'), OFFICIAL_REPO_CANONICAL)
  // Case-insensitive: an uppercased owner still canonicalizes to the same repo.
  assert.equal(canonicalGitHubRemote('git@github.com:slowgreek/costas-code.git'), OFFICIAL_REPO_CANONICAL)
  // Trailing slashes are stripped.
  assert.equal(canonicalGitHubRemote('https://github.com/SlowGreek/costas-code/'), OFFICIAL_REPO_CANONICAL)
})

test('canonicalGitHubRemote is empty for falsy input', () => {
  assert.equal(canonicalGitHubRemote(''), '')
  assert.equal(canonicalGitHubRemote(null), '')
  assert.equal(canonicalGitHubRemote(undefined), '')
})

test('isSshRemote detects scp-like and ssh:// forms only', () => {
  assert.equal(isSshRemote('git@github.com:SlowGreek/costas-code.git'), true)
  assert.equal(isSshRemote('ssh://git@github.com/SlowGreek/costas-code.git'), true)
  assert.equal(isSshRemote('https://github.com/SlowGreek/costas-code.git'), false)
  assert.equal(isSshRemote(''), false)
  assert.equal(isSshRemote(null), false)
})

test('isOfficialSshRemote is true only for the official repo over SSH', () => {
  assert.equal(isOfficialSshRemote('git@github.com:SlowGreek/costas-code.git'), true)
  assert.equal(isOfficialSshRemote('git@github.com:SlowGreek/costas-code'), true)
  assert.equal(isOfficialSshRemote('ssh://git@github.com/SlowGreek/costas-code.git'), true)
  // Case-insensitive owner/repo match.
  assert.equal(isOfficialSshRemote('git@github.com:slowgreek/costas-code.git'), true)
})

test('isOfficialSshRemote does NOT match forks, other hosts, or HTTPS', () => {
  // A fork over SSH belongs to the user — fetching it is their own remote,
  // not the official upstream, so the SSH-avoidance swap must not apply.
  assert.equal(isOfficialSshRemote('git@github.com:someuser/hermes-agent.git'), false)
  // Same repo name on a different host is not the official repo.
  assert.equal(isOfficialSshRemote('git@gitlab.com:SlowGreek/costas-code.git'), false)
  // HTTPS to the official repo never prompts for SSH/FIDO2, so it keeps the
  // normal fetch path — must not be flagged as an official SSH remote.
  assert.equal(isOfficialSshRemote('https://github.com/SlowGreek/costas-code.git'), false)
  assert.equal(isOfficialSshRemote(''), false)
  assert.equal(isOfficialSshRemote(null), false)
})

test('OFFICIAL_REPO_HTTPS_URL canonicalizes to OFFICIAL_REPO_CANONICAL', () => {
  // Invariant: the URL we substitute in must be the same repo we detect.
  assert.equal(canonicalGitHubRemote(OFFICIAL_REPO_HTTPS_URL), OFFICIAL_REPO_CANONICAL)
})

test('update routing follows the Costas distribution branch', () => {
  assert.equal(DEFAULT_UPDATE_BRANCH, 'costas-code')
  assert.equal(resolveUpdateBranch(undefined), 'costas-code')
  assert.equal(resolveUpdateBranch(''), 'costas-code')
  assert.equal(resolveUpdateBranch('main'), 'costas-code')
  assert.equal(resolveUpdateBranch('feature/preview'), 'feature/preview')
  assert.equal(
    remoteTrackingRefspec('costas-code'),
    'costas-code:refs/remotes/origin/costas-code'
  )
  assert.deepEqual(buildUpdateBranchArgs(undefined), ['--branch', 'costas-code'])
  assert.deepEqual(buildUpdateBranchArgs('main'), ['--branch', 'costas-code'])
  assert.deepEqual(buildUpdateBranchArgs('feature/preview'), ['--branch', 'feature/preview'])
  assert.equal(manualUpdateCommand(undefined), 'hermes update')
  assert.equal(manualUpdateCommand('main'), 'hermes update')
  assert.equal(manualUpdateCommand('feature/preview'), "hermes update --branch 'feature/preview'")
  assert.equal(
    manualUpdateCommand('preview$(touch${IFS}/tmp/pwn)'),
    "hermes update --branch 'preview$(touch${IFS}/tmp/pwn)'"
  )
  assert.equal(manualUpdateCommand("preview/o'hare"), "hermes update --branch 'preview/o''hare'")
})
