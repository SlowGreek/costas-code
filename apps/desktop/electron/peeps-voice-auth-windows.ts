import { spawnSync as nodeSpawnSync, type SpawnSyncReturns } from 'node:child_process'
import { randomBytes as nodeRandomBytes, X509Certificate } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'

const SERVER_AUTH_OID = '1.3.6.1.5.5.7.3.1'
const POWERSHELL = 'powershell.exe'

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
$trusted = $null
try {
  $certificate = New-SelfSignedCertificate -Subject 'CN=localhost' -FriendlyName ('Catalyst Peeps localhost ' + [Guid]::NewGuid().ToString('N')) -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyExportPolicy Exportable -KeyUsage DigitalSignature,KeyEncipherment -HashAlgorithm SHA256 -NotAfter ([DateTimeOffset]::Now.AddDays(397).DateTime) -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1','2.5.29.19={critical}{text}ca=false','2.5.29.37={text}1.3.6.1.5.5.7.3.1')
  Export-PfxCertificate -Cert $certificate -FilePath $pfxPath -Password $password -Force | Out-Null
  Export-Certificate -Cert $certificate -FilePath $certificatePath -Type CERT -Force | Out-Null
  $trusted = Import-Certificate -FilePath $certificatePath -CertStoreLocation 'Cert:\CurrentUser\Root'
  if ($trusted.Thumbprint -ne $certificate.Thumbprint) { throw 'Trusted certificate thumbprint mismatch' }
  [Console]::Out.Write((@{ thumbprint = $certificate.Thumbprint } | ConvertTo-Json -Compress))
} catch {
  if ($trusted) { Remove-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $trusted.Thumbprint) -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $pfxPath,$certificatePath -Force -ErrorAction SilentlyContinue
  throw
} finally {
  $passwordText = $null
  if ($certificate) { Remove-Item -LiteralPath ('Cert:\CurrentUser\My\' + $certificate.Thumbprint) -Force -ErrorAction SilentlyContinue }
}`

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
$certificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($pfxPath, $password, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
$publicCertificate = New-Object Security.Cryptography.X509Certificates.X509Certificate2($certificatePath)
if ($certificate.Thumbprint -ne $publicCertificate.Thumbprint -or $certificate.Thumbprint -ne $expectedThumbprint) { throw 'Certificate thumbprint mismatch' }
$root = Get-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $expectedThumbprint) -ErrorAction Stop
$chain = New-Object Security.Cryptography.X509Certificates.X509Chain
$chain.ChainPolicy.RevocationMode = [Security.Cryptography.X509Certificates.X509RevocationMode]::Offline
$chain.ChainPolicy.RevocationFlag = [Security.Cryptography.X509Certificates.X509RevocationFlag]::ExcludeRoot
$chain.ChainPolicy.UrlRetrievalTimeout = [TimeSpan]::Zero
$trusted = $chain.Build($publicCertificate) -and $chain.ChainElements.Count -gt 0 -and $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint -eq $root.Thumbprint -and $root.Thumbprint -eq $expectedThumbprint
[Console]::Out.Write((@{ aclValid = $aclValid; certificateDerBase64 = [Convert]::ToBase64String($publicCertificate.RawData); thumbprint = $publicCertificate.Thumbprint; trusted = $trusted } | ConvertTo-Json -Compress))
$passwordText = $null`

const WINDOWS_CLEANUP_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$value = [Environment]::GetEnvironmentVariable('HERMES_PEEPS_THUMBPRINT_B64', 'Process')
if (-not [string]::IsNullOrWhiteSpace($value)) {
  $thumbprint = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($value))
  if ($thumbprint -match '^[0-9A-Fa-f]{40,64}$') { Remove-Item -LiteralPath ('Cert:\CurrentUser\Root\' + $thumbprint) -Force -ErrorAction SilentlyContinue }
}`

interface SafeStorageApi {
  decryptString(value: Buffer): string
  encryptString(value: string): Buffer
  isEncryptionAvailable(): boolean
}

export interface WindowsPeepsVoiceAuthDeps {
  createSecureContext?: typeof tls.createSecureContext
  existsSync?: (filePath: string) => boolean
  lstatSync?: (filePath: string) => fs.Stats
  mkdirSync?: (filePath: string, options: { mode: number; recursive: boolean }) => unknown
  now?: () => Date
  platform?: NodeJS.Platform
  randomBytes?: typeof nodeRandomBytes
  readFileSync?: (filePath: string) => Buffer
  realpathSync?: (filePath: string) => string
  safeStorage: SafeStorageApi
  spawnSync?: typeof nodeSpawnSync
  unlinkSync?: (filePath: string) => unknown
  userDataPath: () => string
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

  if (
    certificate.ca ||
    now.getTime() < Date.parse(certificate.validFrom) ||
    now.getTime() > Date.parse(certificate.validTo) ||
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
    throw setupError()
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
      throw setupError()
    }

    const real = (deps.realpathSync ?? fs.realpathSync)(filePath)

    if (path.win32.normalize(real).toLowerCase() !== path.win32.normalize(filePath).toLowerCase()) {
      throw setupError()
    }
  }
}

function runPowerShell(
  script: string,
  env: NodeJS.ProcessEnv,
  deps: WindowsPeepsVoiceAuthDeps
): SpawnSyncReturns<string> {
  return (deps.spawnSync ?? nodeSpawnSync)(POWERSHELL, encodedPowerShell(script), {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 1024 * 1024,
    shell: false,
    windowsHide: true
  }) as SpawnSyncReturns<string>
}

function runCheckedPowerShell(script: string, env: NodeJS.ProcessEnv, deps: WindowsPeepsVoiceAuthDeps): string {
  const result = runPowerShell(script, env, deps)

  if (result.error || result.status !== 0) {
    throw setupError()
  }

  return result.stdout
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

function cleanupInvalidBundle(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): void {
  let thumbprint = ''

  try {
    const raw = (deps.readFileSync ?? fs.readFileSync)(paths.certificatePath)
    thumbprint = normalizeThumbprint(new X509Certificate(raw).fingerprint)
  } catch {
    // An unreadable public certificate has no safe store identity to remove.
  }

  if (thumbprint) {
    const result = runPowerShell(WINDOWS_CLEANUP_SCRIPT, { HERMES_PEEPS_THUMBPRINT_B64: envValue(thumbprint) }, deps)

    if (result.error || result.status !== 0) {
      throw setupError()
    }
  }

  removeLocalFiles(paths, deps)
}

function validateExistingBundle(
  paths: WindowsPeepsVoiceAuthPaths,
  deps: WindowsPeepsVoiceAuthDeps
): WindowsPeepsVoiceAuthTlsMaterial {
  assertBundleFilePaths(paths, deps)
  const readFileSync = deps.readFileSync ?? fs.readFileSync
  const pfx = Buffer.from(readFileSync(paths.pfxPath))
  const encryptedPassword = Buffer.from(readFileSync(paths.passwordPath))
  const publicDer = Buffer.from(readFileSync(paths.certificatePath))
  const passphrase = deps.safeStorage.decryptString(encryptedPassword)

  if (!passphrase) {
    throw setupError()
  }

  const publicCertificate = new X509Certificate(publicDer)
  validateWindowsPeepsVoiceAuthLeaf(publicCertificate, deps.now?.() ?? new Date())
  const expectedThumbprint = normalizeThumbprint(publicCertificate.fingerprint)
  const aclPaths = JSON.stringify([paths.root, paths.pfxPath, paths.passwordPath, paths.certificatePath])

  const output = runCheckedPowerShell(
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

  let validation: { aclValid?: unknown; certificateDerBase64?: unknown; thumbprint?: unknown; trusted?: unknown }

  try {
    validation = JSON.parse(output)
  } catch {
    throw setupError()
  }

  const validatedDer = Buffer.from(String(validation.certificateDerBase64 || ''), 'base64')

  if (
    validation.aclValid !== true ||
    validation.trusted !== true ||
    normalizeThumbprint(String(validation.thumbprint || '')) !== expectedThumbprint ||
    !validatedDer.equals(publicDer)
  ) {
    throw setupError()
  }

  validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(validatedDer), deps.now?.() ?? new Date())

  try {
    ;(deps.createSecureContext ?? tls.createSecureContext)({ passphrase, pfx })
  } catch {
    throw setupError()
  }

  return { kind: 'pfx', passphrase, pfx }
}

function provisionBundle(paths: WindowsPeepsVoiceAuthPaths, deps: WindowsPeepsVoiceAuthDeps): void {
  const mkdirSync = deps.mkdirSync ?? fs.mkdirSync
  mkdirSync(paths.root, { mode: 0o700, recursive: true })
  assertSafeWindowsRoot(path.win32.dirname(paths.root), paths, deps)
  runCheckedPowerShell(
    WINDOWS_ACL_SCRIPT,
    { HERMES_PEEPS_ACL_PATHS_B64: envValue(JSON.stringify([paths.root])) },
    deps
  )
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

export function loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(
  deps: WindowsPeepsVoiceAuthDeps
): WindowsPeepsVoiceAuthTlsMaterial {
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
    const hasAny = [paths.pfxPath, paths.passwordPath, paths.certificatePath].some(filePath => existsSync(filePath))
    const hasAll = [paths.pfxPath, paths.passwordPath, paths.certificatePath].every(filePath => existsSync(filePath))

    if (hasAll) {
      try {
        return validateExistingBundle(paths, deps)
      } catch {
        cleanupInvalidBundle(paths, deps)
      }
    } else if (hasAny) {
      cleanupInvalidBundle(paths, deps)
    }

    provisionBundle(paths, deps)

    return validateExistingBundle(paths, deps)
  } catch {
    try {
      cleanupInvalidBundle(paths, deps)
    } catch {
      // Keep the public error coarse and never include PowerShell or secret output.
    }

    throw setupError()
  }
}
