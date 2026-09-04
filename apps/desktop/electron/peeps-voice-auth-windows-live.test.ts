import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import {
  loadOrCreateWindowsPeepsVoiceAuthTlsMaterial,
  resolveWindowsPeepsVoiceAuthPaths,
  validateWindowsPeepsVoiceAuthLeaf,
  WINDOWS_ACL_SCRIPT,
  WINDOWS_CLEANUP_SCRIPT,
  WINDOWS_PROVISION_SCRIPT,
  WINDOWS_TRUST_VALIDATE_SCRIPT,
  WINDOWS_VALIDATE_SCRIPT
} from './peeps-voice-auth-windows'

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']

const ADMIN_CHECK = String.raw`$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
[Console]::Out.Write($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator).ToString().ToLowerInvariant())`

const PROTECT = String.raw`Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_SECRET_B64', 'Process'))
$encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($encrypted))`

const UNPROTECT = String.raw`Add-Type -AssemblyName System.Security
$bytes = [Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_SECRET_B64', 'Process'))
$decrypted = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($decrypted))`

const STORE_CHECK = String.raw`$thumbprint = [Environment]::GetEnvironmentVariable('HERMES_THUMBPRINT', 'Process')
$root = Test-Path -LiteralPath ('Cert:\CurrentUser\Root\' + $thumbprint)
$my = Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $thumbprint)
[Console]::Out.Write((@{ root = $root; my = $my } | ConvertTo-Json -Compress))`

const HEADLESS_TRUST_FIXTURE_INSTALL = String.raw`$certificatePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_CERT_PATH_B64', 'Process')))
& certutil.exe -user -f -addstore Root $certificatePath | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Disposable CurrentUser Root fixture insertion failed' }`

const ACL_CHECK = String.raw`$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable('HERMES_PATHS_B64', 'Process'))) | ConvertFrom-Json
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
foreach ($target in $paths) {
  $acl = Get-Acl -LiteralPath $target
  if (-not $acl.AreAccessRulesProtected) { throw 'ACL inheritance is not protected' }
  foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -ne 'Allow' -or $allowed -notcontains $sid) { throw 'Unexpected ACL entry' }
  }
  foreach ($sid in $allowed) {
    if (-not ($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) })) { throw 'Missing full-control ACL entry' }
  }
}
[Console]::Out.Write('true')`

function powershell(script: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync('powershell.exe', [...POWERSHELL_ARGS, Buffer.from(script, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    shell: false,
    timeout: 30_000,
    windowsHide: true
  })

  if (result.error || result.status !== 0) {
    const stage =
      script === HEADLESS_TRUST_FIXTURE_INSTALL
        ? 'fixture-install'
        : script === STORE_CHECK
          ? 'store-check'
          : script === ACL_CHECK
            ? 'acl-check'
            : script === PROTECT
              ? 'dpapi-protect'
              : script === UNPROTECT
                ? 'dpapi-unprotect'
                : 'helper'
    const detail = String(result.error?.message || result.stderr || '')
      .replace(/[A-Za-z0-9+/_-]{64,}={0,2}/g, '[redacted]')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 1500)
    console.error(`peeps_windows_helper_stage=${stage} status=${result.status ?? 'spawn-error'} detail=${detail}`)
    throw new Error('Windows live certificate helper failed')
  }

  return result.stdout
}

const PRODUCT_STAGE_BY_SCRIPT = new Map(
  [
    ['acl', WINDOWS_ACL_SCRIPT],
    ['cleanup', WINDOWS_CLEANUP_SCRIPT],
    ['provision', WINDOWS_PROVISION_SCRIPT],
    ['trust-validate', WINDOWS_TRUST_VALIDATE_SCRIPT],
    ['validate', WINDOWS_VALIDATE_SCRIPT]
  ].map(([name, script]) => [Buffer.from(script, 'utf16le').toString('base64'), name])
)

const diagnosticProductSpawnSync = ((command: string, args: readonly string[], options: object) => {
  const result = spawnSync(command, [...args], options)

  if (result.error || result.status !== 0) {
    const stage = PRODUCT_STAGE_BY_SCRIPT.get(args.at(-1) ?? '') ?? 'unknown'
    const detail = String(result.error?.message || result.stderr || '')
      .replace(/[A-Za-z0-9+/_-]{64,}={0,2}/g, '[redacted]')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, 1500)
    console.error(`peeps_windows_stage=${stage} status=${result.status ?? 'spawn-error'} detail=${detail}`)
  } else if (PRODUCT_STAGE_BY_SCRIPT.get(args.at(-1) ?? '') === 'trust-validate') {
    try {
      const trust = JSON.parse(String(result.stdout || '{}')) as { rootPresent?: unknown; trusted?: unknown }
      console.error(
        `peeps_windows_trust_state=root:${trust.rootPresent === true ? 'present' : 'missing'},trusted:${trust.trusted === true ? 'yes' : 'no'}`
      )
    } catch {
      console.error('peeps_windows_trust_state=malformed')
    }
  }

  return result
}) as typeof spawnSync

function proveElectronSafeStorage(userData: string): void {
  const electronPath = process.env.HERMES_ELECTRON_PATH
  assert.ok(electronPath, 'HERMES_ELECTRON_PATH is required')
  const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'peeps-voice-auth-windows-native-fixture.cjs')

  const result = spawnSync(electronPath, [fixture], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_PEEPS_TEST_USER_DATA: userData },
    shell: false,
    timeout: 30_000,
    windowsHide: true
  })

  assert.equal(result.status, 0, 'Electron safeStorage fixture failed')
  assert.deepEqual(JSON.parse(result.stdout), {
    available: true,
    ciphertextDistinct: true,
    roundTrip: true,
    userData
  })
}

async function proveHttpsHandshake(material: { passphrase: string; pfx: Buffer }, certificate: Buffer): Promise<void> {
  const server = https.createServer(material, (_request, response) => response.end('ok'))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')

  try {
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get({ ca: certificate, host: '127.0.0.1', port: address.port, rejectUnauthorized: true }, response => {
          let value = ''
          response.setEncoding('utf8')
          response.on('data', chunk => (value += chunk))
          response.on('end', () => resolve(value))
        })
        .once('error', reject)
    })

    assert.equal(body, 'ok')
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())))
  }
}

test.runIf(process.platform === 'win32')(
  'provisions and reuses a non-admin CurrentUser localhost certificate around the OS consent seam',
  async () => {
    assert.equal(powershell(ADMIN_CHECK, {}), 'false')
    const userData = process.env.HERMES_PEEPS_TEST_USER_DATA
    assert.ok(userData && path.win32.isAbsolute(userData), 'explicit temporary-user userData is required')
    assert.ok(userData.startsWith(process.env.USERPROFILE ?? ''), 'userData must be under the temporary user profile')
    fs.mkdirSync(userData, { recursive: true })
    proveElectronSafeStorage(userData)

    const paths = resolveWindowsPeepsVoiceAuthPaths(userData)
    let thumbprint = ''

    const safeStorage = {
      // Vitest runs in node.exe, not Electron main. The Electron fixture above
      // proves the real non-admin safeStorage API; these wrappers inject the
      // same CurrentUser DPAPI boundary into the product module under test.
      decryptString: (encrypted: Buffer) =>
        Buffer.from(powershell(UNPROTECT, { HERMES_SECRET_B64: encrypted.toString('base64') }), 'base64').toString(
          'utf8'
        ),
      encryptString: (value: string) =>
        Buffer.from(powershell(PROTECT, { HERMES_SECRET_B64: Buffer.from(value).toString('base64') }), 'base64'),
      isEncryptionAvailable: () => true
    }
    const headlessTrustConsent = {
      // GitHub's temporary account has no interactive desktop. Production
      // uses the visible Windows root-trust confirmation. This disposable-user
      // fixture substitutes only that OS-owned click; product validation and
      // cleanup still execute their exact CurrentUser scripts.
      installTrustedCertificate: (certificatePath: string) => {
        powershell(HEADLESS_TRUST_FIXTURE_INSTALL, {
          HERMES_CERT_PATH_B64: Buffer.from(certificatePath).toString('base64')
        })
      }
    }

    try {
      const first = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial({
        ...headlessTrustConsent,
        platform: 'win32',
        safeStorage,
        spawnSync: diagnosticProductSpawnSync,
        userDataPath: () => userData
      })
      const pfxBefore = Buffer.from(first.pfx)
      const certificateDer = fs.readFileSync(paths.certificatePath)
      const certificate = new X509Certificate(certificateDer)
      validateWindowsPeepsVoiceAuthLeaf(certificate, new Date())
      thumbprint = certificate.fingerprint.replaceAll(':', '')

      assert.deepEqual(JSON.parse(powershell(STORE_CHECK, { HERMES_THUMBPRINT: thumbprint })), {
        my: false,
        root: true
      })
      assert.equal(
        powershell(ACL_CHECK, {
          HERMES_PATHS_B64: Buffer.from(JSON.stringify(Object.values(paths))).toString('base64')
        }),
        'true'
      )
      await proveHttpsHandshake(first, certificateDer)

      const second = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial({
        ...headlessTrustConsent,
        platform: 'win32',
        safeStorage,
        spawnSync: diagnosticProductSpawnSync,
        userDataPath: () => userData
      })
      assert.deepEqual(second.pfx, pfxBefore)
      assert.equal(
        new X509Certificate(fs.readFileSync(paths.certificatePath)).fingerprint.replaceAll(':', ''),
        thumbprint
      )
    } finally {
      if (!thumbprint && fs.existsSync(paths.certificatePath)) {
        try {
          thumbprint = new X509Certificate(fs.readFileSync(paths.certificatePath)).fingerprint.replaceAll(':', '')
        } catch {
          // No trusted-store identity can be derived from a corrupt public certificate.
        }
      }
      if (thumbprint) {
        powershell(WINDOWS_CLEANUP_SCRIPT, {
          HERMES_PEEPS_THUMBPRINT_B64: Buffer.from(thumbprint).toString('base64')
        })
        assert.deepEqual(JSON.parse(powershell(STORE_CHECK, { HERMES_THUMBPRINT: thumbprint })), {
          my: false,
          root: false
        })
      }

      fs.rmSync(userData, { force: true, recursive: true })
    }
  },
  120_000
)
