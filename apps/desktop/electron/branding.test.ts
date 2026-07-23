import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { test } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('desktop surfaces Costas Code branding while preserving Hermes compatibility identifiers', () => {
  assert.equal(packageJson.name, 'hermes')
  assert.equal(packageJson.build.appId, 'com.nousresearch.hermes')
  assert.deepEqual(packageJson.build.protocols[0].schemes, ['hermes'])

  assert.equal(packageJson.productName, 'Costas Code')
  assert.equal(packageJson.build.productName, 'Costas Code')
  assert.equal(packageJson.build.executableName, 'Costas Code')
  assert.equal(packageJson.build.artifactName, 'Costas-Code-${version}-${os}-${arch}.${ext}')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleDisplayName, 'Costas Code')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleExecutable, 'Costas Code')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleName, 'Costas Code')
  assert.equal(packageJson.build.dmg.title, 'Install Costas Code')
  assert.equal(packageJson.build.win.legalTrademarks, 'Costas Code')
  assert.equal(packageJson.build.linux.synopsis, 'Native desktop shell for Costas Code.')
  assert.equal(packageJson.build.nsis.shortcutName, 'Costas Code')
  assert.equal(packageJson.build.nsis.uninstallDisplayName, 'Costas Code')
  assert.match(indexHtml, /<title>Costas Code<\/title>/)
})
