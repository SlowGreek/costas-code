import {
  type ChildProcessWithoutNullStreams,
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type SpawnOptionsWithoutStdio,
  type SpawnSyncReturns
} from 'node:child_process'
import { randomBytes as nodeRandomBytes, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'
const POWERSHELL = 'powershell.exe'
const VISIBLE_POWERSHELL_MAX_OUTPUT_BYTES = 64 * 1024
const VISIBLE_POWERSHELL_TIMEOUT_MS = 120_000

const POWERSHELL_PREFIX = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-EncodedCommand'
] as const

export const WINDOWS_PROVISION_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
function Read-HermesValue([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { throw "Missing required value" }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$pfxPath = Read-HermesValue 'HERMES_PEEPS_PFX_PATH_B64'
$certificatePath = Read-HermesValue 'HERMES_PEEPS_CERT_PATH_B64'
$passwordText = Read-HermesValue 'HERMES_PEEPS_PFX_PASSWORD_B64'
$password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
$certificate = $null
$keyContainerPath = $null
try {
  $certificate = New-SelfSignedCertificate -Subject 'CN=localhost' -FriendlyName ('Catalyst Peeps localhost ' + [Guid]::NewGuid().ToString('N')) -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter ([DateTimeOffset]::Now.AddDays(397).DateTime) -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1','2.5.29.19={critical}{text}ca=false','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  $rsa = [Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($certificate)
  try {
    if ($rsa -is [Security.Cryptography.RSACng]) {
      $keyContainerPath = Join-Path $env:APPDATA ('Microsoft\Crypto\Keys\' + $rsa.Key.UniqueName)
    }
  } finally {
    if ($rsa) { $rsa.Dispose() }
  }
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -Force | Out-Null
  Export-Certificate -Cert $certificate -FilePath $certificatePath -Type CERT -Force | Out-Null
} catch {
  Remove-Item -LiteralPath $pfxPath,$certificatePath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  $passwordText = $null
  if ($certificate) { Remove-Item -Path ('Cert:\CurrentUser\My\' + $certificate.Thumbprint) -DeleteKey -Force -ErrorAction SilentlyContinue }
}
if (Test-Path -LiteralPath ('Cert:\CurrentUser\My\' + $certificate.Thumbprint)) { throw 'Generated certificate remained in CurrentUser My' }
if ($keyContainerPath -and (Test-Path -LiteralPath $keyContainerPath)) { throw 'Generated private key container remained accessible' }
[Console]::Out.Write((@{ thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress))`

export const WINDOWS_TRUST_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$value = [Environment]::GetEnvironmentVariable('HERMES_PEEPS_CERT_PATH_B64', 'Process')
if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing required value' }
$certificatePath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
$trusted = Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\CurrentUser\Root'
if ($trusted.Thumbprint -ne $certificate.Thumbprint) { throw 'Trusted certificate thumbprint mismatch' }`

export const WINDOWS_TRUST_VALIDATE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
function Read-HermesValue([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing required value' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$certificatePath = Read-HermesValue 'HERMES_PEEPS_CERT_PATH_B64'
$expectedThumbprint = Read-HermesValue 'HERMES_PEEPS_THUMBPRINT_B64'
$publicCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
$root = Get-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $expectedThumbprint) -ErrorAction SilentlyContinue
$chain = New-Object Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
$chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
$chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::Zero
$rootPresent = $null -ne $root -and $root.Thumbprint -eq $expectedThumbprint
$trusted = $rootPresent -and $chain.Build($publicCertificate) -and $chain.ChainElements.Count -gt 0 -and $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint -eq $root.Thumbprint
[Console]::Out.Write((@{ rootPresent = $rootPresent; trusted = $trusted } | ConvertTo-Json -Compress))`

export const WINDOWS_ACL_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
function Read-HermesValue([string]$Name) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Environment]::GetEnvironmentVariable($Name, 'Process')))
}
$paths = (Read-HermesValue 'HERMES_PEEPS_ACL_PATHS_B64' | ConvertFrom-Json)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$adminsSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
foreach ($target in $paths) {
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse points are forbidden' }
  $acl = Get-Acl -LiteralPath $target
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleAll($rule) }
  $inheritance = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
  foreach ($sid in @($currentSid, $systemSid, $adminsSid)) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $target -AclObject $acl
}`

export const WINDOWS_VALIDATE_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
function Read-HermesValue([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing required value' }
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
}
$pfxPath = Read-HermesValue 'HERMES_PEEPS_PFX_PATH_B64'
$certificatePath = Read-HermesValue 'HERMES_PEEPS_CERT_PATH_B64'
$passwordText = Read-HermesValue 'HERMES_PEEPS_PFX_PASSWORD_B64'
$expectedThumbprint = Read-HermesValue 'HERMES_PEEPS_THUMBPRINT_B64'
$paths = (Read-HermesValue 'HERMES_PEEPS_ACL_PATHS_B64' | ConvertFrom-Json)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowedSids = @($currentSid, 'S-1-5-18', 'S-1-5-32-544')
$aclValid = $true
foreach ($target in $paths) {
  $item = Get-Item -LiteralPath $target -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $aclValid = $false; break }
  $acl = Get-Acl -LiteralPath $target
  if ($acl.Owner -ne $currentSid -and $acl.Owner -ne ([Security.Principal.SecurityIdentifier]$currentSid).Translate([Security.Principal.NTAccount]).Value) { $aclValid = $false; break }
  if (-not $acl.AreAccessRulesProtected) { $aclValid = $false; break }
  foreach ($rule in $acl.Access) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $allowedSids -notcontains $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value) { $aclValid = $false; break }
  }
  if (-not $aclValid) { break }
  foreach ($sid in $allowedSids) {
    if (-not ($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -eq $sid -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl })) { $aclValid = $false; break }
  }
}
$password = ConvertTo-SecureString -String $passwordText -AsPlainText -Force
$certificate = $null
$pfxValid = $true
try {
  $certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfxPath, $password, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
} catch {
  $pfxValid = $false
}
$publicCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
$pfxMatchesPublic = $pfxValid -and $certificate.Thumbprint -eq $publicCertificate.Thumbprint -and $certificate.Thumbprint -eq $expectedThumbprint
[Console]::Out.Write((@{ aclValid = $aclValid; certificateDerBase64 = [Convert]::ToBase64String($publicCertificate.RawData); pfxMatchesPublic = $pfxMatchesPublic; pfxValid = $pfxValid; thumbprint = $publicCertificate.Thumbprint } | ConvertTo-Json -Compress))
$passwordText = $null`

export const WINDOWS_CLEANUP_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$value = [Environment]::GetEnvironmentVariable('HERMES_PEEPS_THUMBPRINT_B64', 'Process')
if (-not [string]::IsNullOrWhiteSpace($value)) {
  $thumbprint = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
  if ($thumbprint -match '^[0-9A-Fa-f]{40,64}$') {
    $rootPath = 'Cert:\CurrentUser\Root\' + $thumbprint
    $myPath = 'Cert:\CurrentUser\My\' + $thumbprint
    if (Test-Path -LiteralPath $rootPath) { Remove-Item -LiteralPath $rootPath -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $myPath) { Remove-Item -Path $myPath -DeleteKey -Force -ErrorAction Stop }
    if ((Test-Path -LiteralPath $rootPath) -or (Test-Path -LiteralPath $myPath)) { throw 'Certificate cleanup postcondition failed' }
  }
}`

interface SafeStorageApi {
  decryptString(value: Buffer): string
  encryptString(value: string): Buffer
  isEncryptionAvailable(): boolean
}

export interface WindowsPeepsVoiceAuthDeps {
  createSecureContext?: typeof tls.createSecureContext
  existsSync?: (filePath: string) => boolean
  installTrustedCertificate?: (certificatePath: string) => void
  lstatSync?: (filePath: string) => fs.Stats
  mkdirSync?: (filePath: string, options: { mode: number; recursive: boolean }) => unknown
  now?: () => Date
  platform?: NodeJS.Platform
  randomBytes?: typeof nodeRandomBytes
  readFileSync?: (filePath: string) => Buffer
  realpathSync?: (filePath: string) => string
  removeTrustedCertificate?: (thumbprint: string) => void
  safeStorage: SafeStorageApi
  spawn?: (
    command: string,
    args: readonly string[],
    options: SpawnOptionsWithoutStdio
  ) => ChildProcessWithoutNullStreams
  spawnSync?: typeof nodeSpawnSync
  unlinkSync?: (filePath: string) => unknown
  userDataPath: () => string
  validateTrustedCertificate?: (certificatePath: string, thumbprint: string) => boolean
  writeFileSync?: (filePath: string, data: Uint8Array, options: { flag: string; mode: number }) => unknown
}

export interface WindowsPeepsVoiceAuthPaths {
  certificatePath: string
  passwordPath: string
  pfxPath: string
  root: string
}

export interface WindowsPeepsVoiceAuthTlsMaterial {
  kind: 'pfx'
  passphrase: string
  pfx: Buffer
}

function setupError(): Error {
  return new Error('Peeps voice authorization Windows Current User certificate setup failed')
}

type WindowsPeepsBundleValidationCode =
  | 'bundle-path-policy'
  | 'certificate-corrupt'
  | 'certificate-policy-corrupt'
  | 'pfx-corrupt'
  | 'trust-missing'
  | 'validation-policy-unavailable'
  | 'validation-unavailable'

class WindowsPeepsBundleValidationError extends Error {
  constructor(
    readonly code: WindowsPeepsBundleValidationCode,
    readonly permitsRotation: boolean
  ) {
    super(code)
    this.name = 'WindowsPeepsBundleValidationError'
  }
}

function bundleValidationError(code: WindowsPeepsBundleValidationCode, permitsRotation = false): Error {
  return new WindowsPeepsBundleValidationError(code, permitsRotation)
}

function isProvenRotatableBundleError(error: unknown): boolean {
  return error instanceof WindowsPeepsBundleValidationError && error.permitsRotation
}

function hasSha256RsaSignature(certificate: X509Certificate): boolean {
  const raw = certificate.raw

  function element(offset: number): { content: number; end: number; tag: number } | undefined {
    if (offset + 2 > raw.length) {
      return undefined
    }
    const tag = raw[offset]
    const firstLength = raw[offset + 1]

    if (tag === undefined || firstLength === undefined) {
      return undefined
    }
    let content = offset + 2
    let length = firstLength

    if ((firstLength & 0x80) !== 0) {
      const bytes = firstLength & 0x7f

      if (bytes === 0 || bytes > 4 || content + bytes > raw.length) {
        return undefined
      }
      length = 0

      for (let index = 0; index < bytes; index += 1) {
        length = length * 256 + (raw[content + index] ?? 0)
      }
      content += bytes
    }

    const end = content + length

    return end <= raw.length ? { content, end, tag } : undefined
  }

  const certificateSequence = element(0)

  if (!certificateSequence || certificateSequence.tag !== 0x30 || certificateSequence.end !== raw.length) {
    return false
  }
  const tbsCertificate = element(certificateSequence.content)

  if (!tbsCertificate || tbsCertificate.tag !== 0x30) {
    return false
  }
  const signatureAlgorithm = element(tbsCertificate.end)

  if (!signatureAlgorithm || signatureAlgorithm.tag !== 0x30) {
    return false
  }
  const oid = element(signatureAlgorithm.content)

  return Boolean(
    oid && oid.tag === 0x06 && raw.subarray(oid.content, oid.end).equals(Buffer.from('2a864886f70d01010b', 'hex'))
  )
}

function encodedPowerShell(script: string): string[] {
  return [...POWERSHELL_PREFIX, Buffer.from(script, 'utf16le').toString('base64')]
}

function envValue(value: string | Buffer): string {
  return Buffer.from(value).toString('base64')
}

function normalizeThumbprint(value: string): string {
  return value.replaceAll(':', '').trim().toUpperCase()
}

export function resolveWindowsPeepsVoiceAuthPaths(userDataPath: string): WindowsPeepsVoiceAuthPaths {
  const root = path.win32.join(userDataPath, 'peeps-voice-auth')

  return {
    certificatePath: path.win32.join(root, 'localhost.cer'),
    passwordPath: path.win32.join(root, 'localhost-pfx-password.dpapi'),
    pfxPath: path.win32.join(root, 'localhost.pfx'),
    root
  }
}

export function validateWindowsPeepsVoiceAuthLeaf(certificate: X509Certificate, now: Date): void {
  const sans = String(certificate.subjectAltName)
    .split(/,\s*/)
    .map(value => value.trim())
    .sort()

  const expectedSans = ['DNS:localhost', 'IP Address:127.0.0.1'].sort()
  const details = certificate.publicKey.asymmetricKeyDetails
  const validFrom = certificate.validFromDate.getTime()
  const validTo = certificate.validToDate.getTime()
  const maximumLifetimeMs = 397 * 24 * 60 * 60 * 1000

  if (
    certificate.ca ||
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    validTo <= validFrom ||
    validTo - validFrom > maximumLifetimeMs ||
    now.getTime() < validFrom ||
    now.getTime() > validTo ||
    !hasSha256RsaSignature(certificate) ||
    sans.length !== expectedSans.length ||
    sans.some((value, index) => value !== expectedSans[index]) ||
    certificate.checkHost('localhost') !== 'localhost' ||
    certificate.checkIP('127.0.0.1') !== '127.0.0.1' ||
    certificate.keyUsage?.length !== 1 ||
    certificate.keyUsage[0] !== SERVER_AUTH_OID ||
    certificate.publicKey.asymmetricKeyType !== 'rsa' ||
    !details ||
    typeof details.modulusLength !== 'number' ||
    details.modulusLength < 2048
  ) {
    throw bundleValidationError('certificate-policy-corrupt', true)
  }
}

function assertSafeWindowsRoot(
  userData: string,
  paths: WindowsPeepsVoiceAuthPaths,
  deps: WindowsPeepsVoiceAuthDeps
): void {
  if (
    !path.win32.isAbsolute(userData) ||
    path.win32.normalize(userData) !== userData ||
    path.win32.dirname(paths.root) !== userData
  ) {
    throw setupError()
  }

  const lstatSync = deps.lstatSync ?? fs.lstatSync

  for (const candidate of [userData, paths.root]) {
    if (!(deps.existsSync ?? fs.existsSync)(candidate)) {
      continue
    }

    const stat = lstatSync(candidate)

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw setupError()
    }

    const real = (deps.realpathSync ?? fs.realpathSync)(candidate)

    if (path.win32.normalize(real).toLowerCase() !== path.win32.normalize(candidate).toLowerCase()) {
      throw setupError()
    }
  }
}

function assertBundleFilePaths(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): void {
  const lstatSync = deps.lstatSync ?? fs.lstatSync

  for (const filePath of [paths.pfxPath, paths.passwordPath, paths.certificatePath]) {
    const stat = lstatSync(filePath)

    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw bundleValidationError('bundle-path-policy')
    }

    const real = (deps.realpathSync ?? fs.realpathSync)(filePath)

    if (path.win32.normalize(real).toLowerCase() !== path.win32.normalize(filePath).toLowerCase()) {
      throw bundleValidationError('bundle-path-policy')
    }
  }
}

function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  deps: WindowsPeepsVoiceAuthDeps,
  visible = false
): SpawnSyncReturns<string> {
  const argv = visible
    ? encodedPowerShell(script).filter(argument => argument !== '-NonInteractive')
    : encodedPowerShell(script)

  return (deps.spawnSync ?? nodeSpawnSync)(POWERSHELL, argv, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: !visible
  }) as SpawnSyncReturns<string>
}

function runCheckedPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  deps: WindowsPeepsVoiceAuthDeps,
  visible = false
): string {
  const result = runPowerShell(script, env, deps, visible)

  if (result.error || result.status !== 0) {
    throw setupError()
  }

  return result.stdout
}

async function runVisibleCheckedPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  deps: WindowsPeepsVoiceAuthDeps,
  signal?: AbortSignal
): Promise<void> {
  const argv = encodedPowerShell(script).filter(argument => argument !== '-NonInteractive')

  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams | undefined
    let outputBytes = 0
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) {
        try {
          child?.kill()
        } catch {
          // The process may already have exited.
        }
        reject(setupError())
      } else {
        resolve()
      }
    }
    const abort = () => finish(setupError())

    if (signal?.aborted) {
      finish(setupError())
      return
    }

    try {
      child = (deps.spawn ?? nodeSpawn)(POWERSHELL, argv, {
        env: { ...process.env, ...env },
        shell: false,
        windowsHide: false
      })
    } catch {
      finish(setupError())
      return
    }

    timer = setTimeout(() => finish(setupError()), VISIBLE_POWERSHELL_TIMEOUT_MS)
    const collect = (chunk: Buffer | string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > VISIBLE_POWERSHELL_MAX_OUTPUT_BYTES) {
        finish(setupError())
      }
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.once('error', () => finish(setupError()))
    child.once('close', code => finish(code === 0 ? undefined : setupError()))
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
    }
  })
}

async function installTrustedCertificate(
  certificatePath: string,
  deps: WindowsPeepsVoiceAuthDeps,
  signal?: AbortSignal
): Promise<void> {
  if (deps.installTrustedCertificate) {
    await deps.installTrustedCertificate(certificatePath)

    return
  }

  await runVisibleCheckedPowerShell(
    WINDOWS_TRUST_SCRIPT,
    { HERMES_PEEPS_CERT_PATH_B64: envValue(certificatePath) },
    deps,
    signal
  )
}

function validateTrustedCertificate(
  certificatePath: string,
  thumbprint: string,
  deps: WindowsPeepsVoiceAuthDeps
): 'invalid' | 'missing' | 'trusted' {
  if (deps.validateTrustedCertificate) {
    return deps.validateTrustedCertificate(certificatePath, thumbprint) ? 'trusted' : 'missing'
  }

  const output = runCheckedPowerShell(
    WINDOWS_TRUST_VALIDATE_SCRIPT,
    {
      HERMES_PEEPS_CERT_PATH_B64: envValue(certificatePath),
      HERMES_PEEPS_THUMBPRINT_B64: envValue(thumbprint)
    },
    deps
  )

  try {
    const validation = JSON.parse(output) as { rootPresent?: unknown; trusted?: unknown }
    if (validation.trusted === true) {
      return 'trusted'
    }
    return validation.rootPresent === false ? 'missing' : 'invalid'
  } catch {
    return 'invalid'
  }
}

async function removeTrustedCertificate(thumbprint: string, deps: WindowsPeepsVoiceAuthDeps): Promise<void> {
  if (deps.removeTrustedCertificate) {
    await deps.removeTrustedCertificate(thumbprint)

    return
  }

  await runVisibleCheckedPowerShell(WINDOWS_CLEANUP_SCRIPT, { HERMES_PEEPS_THUMBPRINT_B64: envValue(thumbprint) }, deps)
}

function removeLocalFiles(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): void {
  const existsSync = deps.existsSync ?? fs.existsSync
  const unlinkSync = deps.unlinkSync ?? fs.unlinkSync

  for (const filePath of [paths.pfxPath, paths.passwordPath, paths.certificatePath]) {
    try {
      if (existsSync(filePath)) {
        unlinkSync(filePath)
      }
    } catch {
      throw setupError()
    }
  }
}

async function cleanupInvalidBundle(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): Promise<void> {
  let thumbprint = ''

  try {
    const raw = (deps.readFileSync ?? fs.readFileSync)(paths.certificatePath)
    thumbprint = normalizeThumbprint(new X509Certificate(raw).fingerprint)
  } catch {
    // An unreadable public certificate has no safe store identity to remove.
  }

  if (thumbprint) {
    await removeTrustedCertificate(thumbprint, deps)
  }

  removeLocalFiles(paths, deps)
}

function validateExistingBundle(
  paths: WindowsPeepsVoiceAuthPaths,
  deps: WindowsPeepsVoiceAuthDeps
): WindowsPeepsVoiceAuthTlsMaterial {
  try {
    assertBundleFilePaths(paths, deps)
  } catch (error) {
    if (error instanceof WindowsPeepsBundleValidationError) {
      throw error
    }
    throw bundleValidationError('validation-unavailable')
  }

  const readFileSync = deps.readFileSync ?? fs.readFileSync
  let pfx: Buffer
  let encryptedPassword: Buffer
  let publicDer: Buffer
  let passphrase: string

  try {
    pfx = Buffer.from(readFileSync(paths.pfxPath))
    encryptedPassword = Buffer.from(readFileSync(paths.passwordPath))
    publicDer = Buffer.from(readFileSync(paths.certificatePath))
    passphrase = deps.safeStorage.decryptString(encryptedPassword)
  } catch {
    throw bundleValidationError('validation-unavailable')
  }

  if (!passphrase) {
    throw bundleValidationError('certificate-corrupt', true)
  }

  let publicCertificate: X509Certificate

  try {
    publicCertificate = new X509Certificate(publicDer)
  } catch {
    throw bundleValidationError('certificate-corrupt', true)
  }

  validateWindowsPeepsVoiceAuthLeaf(publicCertificate, deps.now?.() ?? new Date())
  const expectedThumbprint = normalizeThumbprint(publicCertificate.fingerprint)
  const aclPaths = JSON.stringify([paths.root, paths.pfxPath, paths.passwordPath, paths.certificatePath])

  let output: string

  try {
    output = runCheckedPowerShell(
      WINDOWS_VALIDATE_SCRIPT,
      {
        HERMES_PEEPS_ACL_PATHS_B64: envValue(aclPaths),
        HERMES_PEEPS_CERT_PATH_B64: envValue(paths.certificatePath),
        HERMES_PEEPS_PFX_PASSWORD_B64: envValue(passphrase),
        HERMES_PEEPS_PFX_PATH_B64: envValue(paths.pfxPath),
        HERMES_PEEPS_THUMBPRINT_B64: envValue(expectedThumbprint)
      },
      deps
    )
  } catch {
    throw bundleValidationError('validation-unavailable')
  }

  let validation: {
    aclValid?: unknown
    certificateDerBase64?: unknown
    pfxMatchesPublic?: unknown
    pfxValid?: unknown
    thumbprint?: unknown
  }

  try {
    validation = JSON.parse(output)
  } catch {
    throw bundleValidationError('validation-unavailable')
  }

  if (validation.pfxValid === false) {
    throw bundleValidationError('pfx-corrupt', true)
  }

  if (validation.pfxValid !== true) {
    throw bundleValidationError('validation-unavailable')
  }

  if (validation.pfxMatchesPublic !== true) {
    throw bundleValidationError('certificate-corrupt', true)
  }

  if (validation.aclValid !== true) {
    throw bundleValidationError('validation-policy-unavailable')
  }

  const trust = validateTrustedCertificate(paths.certificatePath, expectedThumbprint, deps)

  if (trust === 'missing') {
    throw bundleValidationError('trust-missing')
  }

  if (trust !== 'trusted') {
    throw bundleValidationError('validation-policy-unavailable')
  }

  const validatedDer = Buffer.from(String(validation.certificateDerBase64 || ''), 'base64')

  if (
    normalizeThumbprint(String(validation.thumbprint || '')) !== expectedThumbprint ||
    !validatedDer.equals(publicDer)
  ) {
    throw bundleValidationError('certificate-corrupt', true)
  }

  try {
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(validatedDer), deps.now?.() ?? new Date())
  } catch (error) {
    if (error instanceof WindowsPeepsBundleValidationError) {
      throw error
    }
    throw bundleValidationError('certificate-corrupt', true)
  }

  try {
    ;(deps.createSecureContext ?? tls.createSecureContext)({ passphrase, pfx })
  } catch {
    throw bundleValidationError('pfx-corrupt', true)
  }

  return { kind: 'pfx', passphrase, pfx }
}

function provisionBundle(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): void {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  mkdirSync(paths.root, { mode: 0o700, recursive: true })
  assertSafeWindowsRoot(path.win32.dirname(paths.root), paths, deps)
  runCheckedPowerShell(WINDOWS_ACL_SCRIPT, { HERMES_PEEPS_ACL_PATHS_B64: envValue(JSON.stringify([paths.root])) }, deps)
  const passwordBytes = (deps.randomBytes ?? nodeRandomBytes)(48)
  const passphrase = passwordBytes.toString('base64url')

  try {
    runCheckedPowerShell(
      WINDOWS_PROVISION_SCRIPT,
      {
        HERMES_PEEPS_CERT_PATH_B64: envValue(paths.certificatePath),
        HERMES_PEEPS_PFX_PASSWORD_B64: envValue(passphrase),
        HERMES_PEEPS_PFX_PATH_B64: envValue(paths.pfxPath)
      },
      deps
    )

    const encrypted = deps.safeStorage.encryptString(passphrase)

    ;(deps.writeFileSync ?? fs.writeFileSync)(paths.passwordPath, encrypted, { flag: 'wx', mode: 0o600 })
    runCheckedPowerShell(
      WINDOWS_ACL_SCRIPT,
      {
        HERMES_PEEPS_ACL_PATHS_B64: envValue(
          JSON.stringify([paths.root, paths.pfxPath, paths.passwordPath, paths.certificatePath])
        )
      },
      deps
    )
  } finally {
    passwordBytes.fill(0)
  }
}

export async function loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(
  deps: WindowsPeepsVoiceAuthDeps,
  signal?: AbortSignal
): Promise<WindowsPeepsVoiceAuthTlsMaterial> {
  if ((deps.platform ?? process.platform) !== 'win32') {
    throw setupError()
  }

  if (!deps.safeStorage.isEncryptionAvailable()) {
    throw setupError()
  }

  const userData = deps.userDataPath()
  const paths = resolveWindowsPeepsVoiceAuthPaths(userData)

  try {
    assertSafeWindowsRoot(userData, paths, deps)
    const existsSync = deps.existsSync ?? fs.existsSync
    const bundleFiles = [paths.pfxPath, paths.passwordPath, paths.certificatePath]
    const hasAny = bundleFiles.some(filePath => existsSync(filePath))
    const hasAll = bundleFiles.every(filePath => existsSync(filePath))

    if (hasAll) {
      try {
        return validateExistingBundle(paths, deps)
      } catch (error) {
        if (error instanceof WindowsPeepsBundleValidationError && error.code === 'trust-missing') {
          await installTrustedCertificate(paths.certificatePath, deps, signal)
          return validateExistingBundle(paths, deps)
        }
        if (!isProvenRotatableBundleError(error)) {
          throw error
        }
        await cleanupInvalidBundle(paths, deps)
      }
    } else if (hasAny) {
      await cleanupInvalidBundle(paths, deps)
    }

    provisionBundle(paths, deps)

    try {
      return validateExistingBundle(paths, deps)
    } catch (error) {
      if (error instanceof WindowsPeepsBundleValidationError && error.code === 'trust-missing') {
        await installTrustedCertificate(paths.certificatePath, deps, signal)
        return validateExistingBundle(paths, deps)
      }
      throw error
    }
  } catch {
    throw setupError()
  }
}
