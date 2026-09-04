import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

import { test } from 'vitest'

// Execute the real wrapper with only its filesystem/process boundaries replaced.
function builderArgs(input: string[]): string[] {
  const source = fs.readFileSync(path.resolve('scripts/run-electron-builder.mjs'), 'utf8')
    .replace(/^import .* from .*$/gm, '')
    .replace('import.meta.url', '"file:///desktop/scripts/run-electron-builder.mjs"')
  let captured: string[] = []
  const requirePackage = Object.assign(
    () => ({ bin: { 'electron-builder': 'cli.js' } }),
    { resolve: (name: string) => `/modules/${name}` }
  )
  vm.runInNewContext(source, {
    fs: { existsSync: () => true },
    path,
    createRequire: () => requirePackage,
    spawnSync: (_command: string, args: string[]) => {
      captured = args.slice(1)
      return { status: 0 }
    },
    process: { platform: 'win32', execPath: 'node', argv: ['node', 'wrapper', ...input], exit: () => {} },
    console
  })
  return Array.from(captured)
}

for (const option of [['--publish', 'never'], ['--publish=never'], ['-p', 'never']]) {
  test(`builder preserves a single explicit publish policy: ${option.join(' ')}`, () => {
    const args = builderArgs(['--win', 'nsis', ...option])
    assert.deepEqual(args.filter(arg => !arg.startsWith('-c.electronDist=')), ['--win', 'nsis', ...option])
  })
}

test('builder defaults to never publishing when no policy is supplied', () => {
  const args = builderArgs(['--dir'])
  assert.deepEqual(args.filter(arg => !arg.startsWith('-c.electronDist=')), ['--publish', 'never', '--dir'])
})
