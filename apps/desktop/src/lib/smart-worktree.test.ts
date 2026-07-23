import { describe, expect, it } from 'vitest'

import { promptNeedsManagedWorktree, smartWorktreeLabel } from './smart-worktree'

describe('promptNeedsManagedWorktree', () => {
  it.each([
    'Fix the failing authentication test.',
    'Please add a dark mode toggle.',
    'Investigate the crash and then implement the fix.',
    'Refactor this module to remove the legacy API.',
    'I want you to update the dependencies and run the tests.',
    'Make the header sticky.',
    'Set the timeout to 30s.',
    'Generate a migration.',
    'Convert this to TypeScript.',
    'Enable dark mode.',
    'Disable telemetry.',
    'Drop the deprecated column.',
    'Bump the version.',
    'Turn the callback into async.',
    'Extract this into a helper.',
    'Split the file.',
    'Swap axios for fetch.',
    'Optimize the render loop.',
    'Hook up the API client.'
  ])('isolates mutating work: %s', prompt => {
    expect(promptNeedsManagedWorktree(prompt)).toBe(true)
  })

  it.each([
    'Explain how authentication works.',
    'How would you fix this bug?',
    'Review the current implementation.',
    'Investigate the crash without changing files.',
    'Do not modify anything; summarize the repository.',
    'Can you explain how the add feature works?',
    'Walk me through the update logic.',
    'Show me where we write to disk.',
    'Tell me about the migrate script.',
    '/help'
  ])('keeps read-only work on the current checkout: %s', prompt => {
    expect(promptNeedsManagedWorktree(prompt)).toBe(false)
  })
})

it('builds a stable, git-safe managed label', () => {
  expect(smartWorktreeLabel('Please fix the auth regression!', 123456789)).toBe('managed-fix-auth-regression-21i3v9')
})
