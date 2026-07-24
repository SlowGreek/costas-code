import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { test } from 'vitest'

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
)

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8')

test('desktop surfaces Catalyst branding while preserving Hermes compatibility identifiers', () => {
  assert.equal(packageJson.name, 'hermes')
  assert.equal(packageJson.build.appId, 'com.nousresearch.hermes')
  assert.deepEqual(packageJson.build.protocols[0].schemes, ['hermes'])

  assert.equal(packageJson.productName, 'Catalyst')
  assert.equal(packageJson.build.productName, 'Catalyst')
  assert.equal(packageJson.build.executableName, 'Catalyst')
  assert.equal(packageJson.build.artifactName, 'Catalyst-${version}-${os}-${arch}.${ext}')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleDisplayName, 'Catalyst')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleExecutable, 'Catalyst')
  assert.equal(packageJson.build.mac.extendInfo.CFBundleName, 'Catalyst')
  assert.equal(packageJson.build.dmg.title, 'Install Catalyst')
  assert.equal(packageJson.build.win.legalTrademarks, 'Catalyst')
  assert.equal(packageJson.build.linux.synopsis, 'Native desktop shell for Catalyst.')
  assert.equal(packageJson.build.nsis.shortcutName, 'Catalyst')
  assert.equal(packageJson.build.nsis.uninstallDisplayName, 'Catalyst')
  assert.match(indexHtml, /<title>Catalyst<\/title>/)
})
