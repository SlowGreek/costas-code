import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { test } from 'vitest'

import {
  loadOrCreateWindowsPeepsVoiceAuthTlsMaterial,
  resolveWindowsPeepsVoiceAuthPaths
} from './peeps-voice-auth-windows'

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']

const ADMIN_CHECK = String.raw`$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[Console]::Out.Write($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString().ToLowerInvariant())`

const PROTECT = String.raw`$bytes = [Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_SECRET_B64', 'Process'))
$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))`

const UNPROTECT = String.raw`$bytes = [Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_SECRET_B64', 'Process'))
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($decrypted))`

const STORE_CHECK = String.raw`$thumbprint = [Environment]::GetEnvironmentVariable('HERMES_THUMBPRINT', 'Process')
$root = Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $thumbprint)
$my = Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $thumbprint)
[Console]::Out.Write((@{ root = $root; my = $my } | ConvertTo-Json -Compress))`

const CLEANUP = String.raw`$thumbprint = [Environment]::GetEnvironmentVariable('HERMES_THUMBPRINT', 'Process')
if ($thumbprint -match '^[0-9A-Fa-f]{40}$') {
  Remove-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $thumbprint) -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $thumbprint) -Force -ErrorAction SilentlyContinue
}`

function powershell(script: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync('powershell.exe', [...POWERSHELL_ARGS, Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
    windowsHide: true
  })

  if (result.error || result.status !== 0) {
    throw new Error('Windows live certificate helper failed')
  }

  return result.stdout
}

test.runIf(process.platform === 'win32')(
  'provisions a non-elevated CurrentUser localhost certificate and removes the test trust entry',
  () => {
    assert.equal(powershell(ADMIN_CHECK, {}), 'false')

    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'catalyst-peeps-auth-'))
    const paths = resolveWindowsPeepsVoiceAuthPaths(userData)
    let thumbprint = ''

    try {
      const material = loadOrCreateWindowsPeepsVoiceAuthTlsMaterial({
        platform: 'win32',
        safeStorage: {
          decryptString: encrypted =>
            Buffer.from(powershell(UNPROTECT, { HERMES_SECRET_B64: encrypted.toString('base64') }), 'base64').toString(
              'utf8'
            ),
          encryptString: value =>
            Buffer.from(powershell(PROTECT, { HERMES_SECRET_B64: Buffer.from(value).toString('base64') }), 'base64'),
          isEncryptionAvailable: () => true
        },
        userDataPath: () => userData
      })

      assert.equal(material.kind, 'pfx')
      assert.equal(fs.existsSync(paths.pfxPath), true)
      assert.equal(fs.existsSync(paths.passwordPath), true)
      const certificate = new X509Certificate(fs.readFileSync(paths.certificatePath))
      thumbprint = certificate.fingerprint.replaceAll(':', '')

      const stores = JSON.parse(powershell(STORE_CHECK, { HERMES_THUMBPRINT: thumbprint })) as {
        my: boolean
        root: boolean
      }

      assert.deepEqual(stores, { my: false, root: true })
    } finally {
      if (thumbprint) {
        powershell(CLEANUP, { HERMES_THUMBPRINT: thumbprint })
      }

      fs.rmSync(userData, { force: true, recursive: true })
    }
  },
  60_000
)
