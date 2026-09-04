import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'

import { test, vi } from 'vitest'

import {
  loadOrCreateWindowsPeepsVoiceAuthTlsMaterial,
  resolveWindowsPeepsVoiceAuthPaths,
  validateWindowsPeepsVoiceAuthLeaf,
  WINDOWS_ACL_SCRIPT,
  WINDOWS_CLEANUP_SCRIPT,
  WINDOWS_PROVISION_SCRIPT,
  WINDOWS_TRUST_SCRIPT,
  WINDOWS_TRUST_VALIDATE_SCRIPT,
  WINDOWS_VALIDATE_SCRIPT,
  type WindowsPeepsVoiceAuthDeps
} from './peeps-voice-auth-windows'

const VALID_CERT_DER = Buffer.from(
  'MIIC7DCCAdSgAwIBAgIJAOTXorx+rgw/MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA5MDQxNjA3MDlaFw0yNzEwMDYxNjA3MDlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBANjQpdsUt9SKcL0yIe9MPAr/qYUgGohSlrGR08IeERf6jTOgHn+ucsoq3bB0pbR9T/EMICLnrZuW3JlKeVPwmBhripSXAyJclkby1ryul6fw2zA6N0QirLTbi2VS4fhDTw03Tc2lSR/Ce5j02caHxPE/HwyaCXeT6up1EXtO1piXYCaI2slXFYhZHbr5KY+pGORObylTR+VRtYk9p3FBXducsIJGeSq3TSwnX230PFjqlVV7TvX9zZG1nCkcYAnCdMcFjoZENsxPaKhgMPIpRFikYLBb+BsmsLNrHLgFE00+hWvUpY3QPso23ku+bSSFUimH5AQDbuqgLCCo35viTgcCAwEAAaNBMD8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBADIbN3H6rRMFfbwH2RVukk3bqvyoj+CkE28sQAkd4OxF6pZFhhpxK3iAOf1BrZWDBLPNbFmJac++LHtBP4eXpL7A9LRhBISToZooxpsC7sxbAqUhZhXw9tEN5kKSZIU4BarU+RI8Hu+HpUGIhZ8wAD5OQ92i3KrVY/3bbiFyw5vSwC9sGMgf9q4SwPjIfs24gQS3pxloypD1J0CBGvj3dYezrVXkcxmce4qyWYNcFyONVuCakKyIygpoVTO324+f6Ey3oBrVktL1HM/3ABpRc7CJrNmkET88RjLneGvDpoCA94qq4/kHALa2j82Cmi0NwSkxvrrbEmXjmiSDQBvDnEU=',
  'base64'
)

const WEAK_CERT_DER = Buffer.from(
  'MIIB5zCCAVCgAwIBAgIJANQh3UkM6/6+MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA5MDQxNjA3MDlaFw0yNzEwMDYxNjA3MDlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCBnzANBgkqhkiG9w0BAQEFAAOBjQAwgYkCgYEAwbp/8yeT2CNthfZz8ihH5KiRcah+rI3vjIGP2y1pGpjdJtTnsCllLCv4cvk2E9qeGnH4gAxsUxxz5ya6KcsIhB5Y56xEeL0Pe8z21wj8rAHEdUqaVU/dHNt8AcUXKsbBiRWzKN815rR5/6JUejhS5t2dx/3fzYTGIKumBlvAeKkCAwEAAaNBMD8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADgYEAvXe8efSzU+Jd7KCeg1FW1PNvMxXSeabEzfQU33CZaQ0INUWCGEcgplCEfFdslDhPdZgPq7XJuklHHWOutjqel3QcVY+Tp3ONFmRNGXwg9fKMln5dMN6wNrDNDidNo/kEPLG0cLEY8wfQ90y7T6oNKaFnlKF/s0jV4lYEV4Z9miM=',
  'base64'
)

const WRONG_EKU_CERT_DER = Buffer.from(
  'MIIC7DCCAdSgAwIBAgIJAPqbbvMAdB5rMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA5MDQxNjA3MDlaFw0yNzEwMDYxNjA3MDlaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAK+dcntleqX7vYmXNdEcnWl22q1+U0MZQzUFsTsJ+dQK2bgJQjYNO/Z4bFxAZr+tbaS6fFD0qvjGb8uKtSjUOuxrPc+Wle1VWD29+g6LW3TbqOjj2aeP/4yE9MgcnTJOqvmweWecRvg5eU6AyHE266tdhyVzxwpOVHx9vhqii4Vx0VmR0EQUbdqCVcJRm62VHqOutiYWwCZf0OU4ousRfGNan33ZG8RBYUn0wmmGbcUg4iVMdOjqQ5upXM8mPFbYA9q67S2MFhkgeEJV2JEbQcQ9ib3SsBVpr97Eb9Ob/UzvdY0UHywDARLjSTs9g8Z0PFBtikn/kXdE3ZVzEEzTNPECAwEAAaNBMD8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwIwDQYJKoZIhvcNAQELBQADggEBAEgiPHQBIRGmBEvJhcaSXIObYf920K7SvrMdartaLV4j8Sztyc/zkNS0EO0q1Mb4V4aotFbZ7CBZFk4JwP63rTmlBsuAhWpeI+CQtHiaSOcIeGlpeqvx5CEZDmm+lGKAgWUIbijiJCAAIyBwwQhr1MchfqmyTNJK5ezc6RBhHSfV9XEROEBwAEyeAAh2ZvLx3S+daOtXIIfUBada0Gypko9VvguXCcqJ8/M6H7W//ZZeLqTWHTRMFuhRKevBMOd/MgjPGmgxeNdZESlOzeaGqD4gd2GFvzJmOHTG5s/DrpNIMfU/IlcVVYdWbse6LI+Un7v5kvycCau37H/yxL6HZhs=',
  'base64'
)

const WRONG_SAN_CERT_DER = Buffer.from(
  'MIIC8jCCAdqgAwIBAgIJAOWVJubFGKd0MA0GCSqGSIb3DQEBCwUAMBYxFDASBgNVBAMMC2V4YW1wbGUuY29tMB4XDTI2MDkwNDE2MTMzMloXDTI3MTAwNjE2MTMzMlowFjEUMBIGA1UEAwwLZXhhbXBsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCQ3s07i2uL7sD8+338rvQGk4ob3++G1X974RK4Nwk1Z6Yy+19tcPPDLVaJ0grtrYjN9BXwqKCw+GiJar8NavPETtsXW3WbQQkfQqMfpFy1n/QKn3fIvNREA3AoaesTKDfVurrRXfACkm3pVyUaSm44RLdYZZPKkm1OnY2LKOjuvkPClD9pbL5PX/PvOuQKcuElKJkrCsGtGqi3n1ope0Yz45ddiNoi/F7fiVR2RiwtZzqsO9xZxWiinuVjJfnP7v8CRWekbIkZo3kSt6SEg6Vc8tfUozVtYQQgCfnC9YAEM98Ox/H8rSzTd+5842Z3dwVx8VPAuemU1BLzv5KBCI5PAgMBAAGjQzBBMBwGA1UdEQQVMBOCC2V4YW1wbGUuY29thwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBAEb0PtFvF/I9YI/sHZOOH+jog7jQx2nPjRatOc2Q0DJI6mKXYUlz16Oi8E9PjscSsNKmV8M0yO5eiVtVSCUEbRR1I5M1WRfXG1xDmC8iNgtByP7NgeFfixNss4Vaioe7SDMD9xs0HrCIWQsiXBT1v7gqkqrRg4QCf0lUbl84ijzGKlbHdosCdbIB0zNBjE2x4rvYmfqLELxcvtS+5977kBhXftkfACIFGQMugoPKTG4VIEtsdzJzYVkSJgJCCrPIHD+9cB3pzjIiOxNtvxFP3yy3jXmyLKAM9+aqDsHSTglvmnN1213XbRLDaL/QUh68rAscYiKQ+ONZ/DUtTEkZqC0=',
  'base64'
)

const SHA1_CERT_DER = Buffer.from(
  'MIIC7DCCAdSgAwIBAgIJAI3KZtp01+COMA0GCSqGSIb3DQEBBQUAMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA5MDQxNjM5MjVaFw0yNzEwMDYxNjM5MjVaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALNBa6CRZqq9HlOCVXzCgr/m5RFQFmF/9k8OC41CW2Oc/z0sDcE62jTzQ4Xqe7KCxw3AWuD8UXbIkHgF/6gmFrJRIpjqh2ErOJHApg/qBFd22pVRj0KqVmYt+M3XNcaiCrD9YGHdszXosTM2nToO8ssjjgMKaB7Ml7jEpwZTQDAnTL9onIElb0RFctUykk4bIWUYtmmiK0RDc5N2HnhDclJY878qtrLJPRbOkzW2DSLXO6RtXrhCzmAWobLGg0wF7r3z+digeU8SeDddyvxtU/r3t3wEn4/beHgB2KqI2bP1IjpInd1Q6OorUPvuLcNyrCEiTockhO5k68bSfXC/2XcCAwEAAaNBMD8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQEFBQADggEBAKY8eHKq8DdTWsyuUVqHsZTDMP7dwN566K1LlZ3r1N7SZ20fE/1CpW06BVyyOeDoelaK3eUALiWzF7NHANQY/nzkvar1dajt2FIeI+uZHQsbiLfWW6j5HmzBPawBaOI7JCWNP/vRIx6jh/H4JRhufuljMslTBgzdeaQVY+DIXikvTm3CZUpnzUvtrWd/bbo9mq7ehIbMAsS+YA+WSiHY7UgKZhymbBanBFHqN0E6qlhSuWvYCDaTL8LoFN+bBqS4kWYnu8p2FLl4+HzxeB0n+vdMMTk9LpGuRqjO0eZUpTBAPFgl14IM4rpQnGGDb97Sk+5UKi72vP15AeNrn4z781M=',
  'base64'
)

const LONG_LIVED_CERT_DER = Buffer.from(
  'MIIC7DCCAdSgAwIBAgIJAOGs9wTylNojMA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDAeFw0yNjA5MDQxNjM5MjVaFw0yNzEwMDcxNjM5MjVaMBQxEjAQBgNVBAMMCWxvY2FsaG9zdDCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMvx3Q9ns7QAoIDpTPGQYkjwKmoDzpLEpeXivYyiOSEOQsn5UVYZgR1mtIpUfbVttdCQv8IQx3sSanPwEcZxJvCwCqVgzXUmkvA5LfT8LCINtRG2p8n8k49r3/NcyyGyhy7ckKUralEX75adN46ounZVRbFRvEQRvrEMYfusUvdpu1Ze/9vjAOM44zGx/pYmGMDJIUEMMZveUK78tgCy3uqTy3x0eSAhkVDg+s8ZCNiQdQatRCtqliymKf8ycI2AtG7xFj5IMwJuFX0vnAMBLanh+L3vbAyDcFQZgzOaA7ZNNREkTZUYEblXfAAsSS3Kl1QfiE2S+cmLsT5cSmvusP0CAwEAAaNBMD8wGgYDVR0RBBMwEYIJbG9jYWxob3N0hwR/AAABMAwGA1UdEwEB/wQCMAAwEwYDVR0lBAwwCgYIKwYBBQUHAwEwDQYJKoZIhvcNAQELBQADggEBAFMlWcWMG/cWDLJb28sDR88D1F4Uu0/FbD2xDPro2kGu8FC1SWBMY++uJ/cbLB+jxeRfyAHgIM4iNV0E3vQTGSFTdoWTK8hqenrXjnmP89fuoqFZlX1YJI41PlzO6TY7PM0OObRQa4rKRyTobCw14Nq+coq+xKfT1vHq8wzkUkiycY5EZ/J5TBXrIzMtIm6LBPBZ1e6BZ1HOpSNHben5PmN+4Q9a4nuR/V2f7M/zPYICHp5WHQDMyB2g34dHiAOZSQAeljDiy9+VLwJdtLY1yfw3pbZUx3eMGnBllhPbB80882To+Pwd9ISEIT3u0cICspNKztNT5Sl1bMcJ3m2Y2yI=',
  'base64'
)

const USER_DATA = 'C:\\Users\\alice\\AppData\\Roaming\\Catalyst'
const PASSWORD = Buffer.from('unit-test-password-with-entropy-0123456789')

function createWindowsHarness(
  options: {
    existing?: boolean
    decryptThrows?: boolean
    encryptionAvailable?: boolean
    validation?: Partial<{
      aclValid: boolean
      certificateDer: Buffer
      pfxMatchesPublic: boolean
      pfxValid: boolean
      trusted: boolean
      thumbprint: string
    }>
    failScript?: 'acl' | 'provision' | 'validate'
    failTrust?: boolean
    invalidPfx?: boolean
    malformedValidationJson?: boolean
    stallTrust?: boolean
  } = {}
) {
  const paths = resolveWindowsPeepsVoiceAuthPaths(USER_DATA)
  const files = new Map<string, Buffer>()

  if (options.existing) {
    files.set(paths.pfxPath, Buffer.from('existing-pfx'))
    files.set(paths.passwordPath, Buffer.from('ciphertext'))
    files.set(paths.certificatePath, VALID_CERT_DER)
  }

  const spawnCalls: Array<{
    argv: readonly string[]
    env: NodeJS.ProcessEnv
    windowsHide?: boolean
  }> = []
  const provisionScript = Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
  const trustScript = Buffer.from(WINDOWS_TRUST_SCRIPT, 'utf16le').toString('base64')
  const trustValidateScript = Buffer.from(WINDOWS_TRUST_VALIDATE_SCRIPT, 'utf16le').toString('base64')
  const validateScript = Buffer.from(WINDOWS_VALIDATE_SCRIPT, 'utf16le').toString('base64')
  const aclScript = Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64')

  const validation = {
    aclValid: true,
    certificateDer: VALID_CERT_DER,
    pfxMatchesPublic: true,
    pfxValid: true,
    trusted: true,
    thumbprint: new X509Certificate(VALID_CERT_DER).fingerprint.replaceAll(':', ''),
    ...options.validation
  }
  let trusted = options.existing ? validation.trusted : false

  const spawnSync = vi.fn(
    (_command: string, argv: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
      const env = spawnOptions.env ?? {}
      spawnCalls.push({ argv, env, windowsHide: spawnOptions.windowsHide })
      const encoded = argv.at(-1)
      const name =
        encoded === provisionScript
          ? 'provision'
          : encoded === trustScript
            ? 'trust'
            : encoded === trustValidateScript
              ? 'trust-validate'
              : encoded === validateScript
                ? 'validate'
                : 'acl'

      if (options.failScript === name) {
        return { status: 1, stdout: '', stderr: 'sensitive failure output' }
      }

      if (name === 'provision') {
        files.set(paths.pfxPath, Buffer.from('new-pfx'))
        files.set(paths.certificatePath, VALID_CERT_DER)

        return { status: 0, stdout: JSON.stringify({ thumbprint: validation.thumbprint }), stderr: '' }
      }

      if (name === 'acl') {
        return { status: 0, stdout: '', stderr: '' }
      }

      if (name === 'trust') {
        return { status: 0, stdout: '', stderr: '' }
      }

      if (name === 'trust-validate') {
        return { status: 0, stdout: JSON.stringify({ rootPresent: trusted, trusted }), stderr: '' }
      }

      const provisioned = files.get(paths.pfxPath)?.toString() === 'new-pfx'

      return {
        status: 0,
        stdout: options.malformedValidationJson
          ? '{'
          : JSON.stringify({
              aclValid: validation.aclValid,
              certificateDerBase64: validation.certificateDer.toString('base64'),
              pfxMatchesPublic: provisioned ? true : validation.pfxMatchesPublic,
              pfxValid: provisioned ? true : validation.pfxValid,
              trusted: validation.trusted,
              thumbprint: validation.thumbprint
            }),
        stderr: ''
      }
    }
  )

  const spawn = vi.fn(
    (_command: string, argv: readonly string[], spawnOptions: { env?: NodeJS.ProcessEnv; windowsHide?: boolean }) => {
      const child = new EventEmitter() as EventEmitter & {
        kill: ReturnType<typeof vi.fn>
        stderr: EventEmitter
        stdout: EventEmitter
      }
      child.kill = vi.fn(() => true)
      child.stderr = new EventEmitter()
      child.stdout = new EventEmitter()
      const env = spawnOptions.env ?? {}
      spawnCalls.push({ argv, env, windowsHide: spawnOptions.windowsHide })
      if (!options.stallTrust) {
        queueMicrotask(() => {
          if (!options.failTrust) {
            trusted = true
          }
          child.emit('close', options.failTrust ? 1 : 0, null)
        })
      }

      return child
    }
  )

  const deps: WindowsPeepsVoiceAuthDeps = {
    createSecureContext: vi.fn(
      (secureContextOptions?: Parameters<NonNullable<WindowsPeepsVoiceAuthDeps['createSecureContext']>>[0]) => {
        if (
          options.invalidPfx &&
          Buffer.isBuffer(secureContextOptions?.pfx) &&
          secureContextOptions.pfx.toString() === 'existing-pfx'
        ) {
          throw new Error('bad pfx')
        }

        return {} as never
      }
    ),
    existsSync: filePath => filePath === USER_DATA || filePath === paths.root || files.has(filePath),
    lstatSync: filePath =>
      ({
        isDirectory: () => filePath === USER_DATA || filePath === paths.root,
        isFile: () => files.has(filePath),
        isSymbolicLink: () => false
      }) as never,
    mkdirSync: vi.fn(),
    now: () => new Date('2026-09-05T00:00:00.000Z'),
    platform: 'win32',
    randomBytes: () => Buffer.from(PASSWORD),
    readFileSync: filePath => {
      const value = files.get(filePath)

      if (!value) {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }

      return Buffer.from(value)
    },
    realpathSync: filePath => filePath,
    safeStorage: {
      decryptString: vi.fn(value => {
        if (options.decryptThrows && value.toString() === 'ciphertext') {
          throw new Error('DPAPI corrupt')
        }

        return PASSWORD.toString('base64url')
      }),
      encryptString: vi.fn(() => Buffer.from('new-ciphertext')),
      isEncryptionAvailable: vi.fn(() => options.encryptionAvailable ?? true)
    },
    spawn: spawn as never,
    spawnSync: spawnSync as never,
    unlinkSync: filePath => files.delete(filePath),
    userDataPath: () => USER_DATA,
    writeFileSync: (filePath, value) => files.set(filePath, Buffer.from(value))
  }

  return { deps, files, paths, spawn, spawnCalls, spawnSync }
}

test('Windows visible trust is asynchronous and does not block the caller', async () => {
  const harness = createWindowsHarness()
  const pending = loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  assert.ok(pending instanceof Promise)
  assert.equal(harness.spawn.mock.calls.length, 1)
  assert.equal((await pending).pfx.toString(), 'new-pfx')
})

test('Windows retries missing exact CurrentUser Root trust without regenerating a complete PFX', async () => {
  const harness = createWindowsHarness({ existing: true, validation: { trusted: false } })
  let validationCalls = 0
  harness.deps.validateTrustedCertificate = () => {
    validationCalls += 1
    return validationCalls > 1
  }

  const material = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  assert.equal(material.pfx.toString(), 'existing-pfx')
  assert.equal(validationCalls, 2)
  assert.equal(harness.spawn.mock.calls.length, 1)
  assert.equal(
    harness.spawnCalls.filter(
      call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
    ).length,
    0
  )
})

test('Windows declined trust preserves a complete newly provisioned bundle for retry', async () => {
  const harness = createWindowsHarness({ failTrust: true })

  await assert.rejects(() => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps), /setup failed/)

  assert.equal(harness.files.has(harness.paths.pfxPath), true)
  assert.equal(harness.files.has(harness.paths.passwordPath), true)
  assert.equal(harness.files.has(harness.paths.certificatePath), true)
})

test('Windows trust consent times out at 120 seconds and kills the child', async () => {
  vi.useFakeTimers()
  try {
    const harness = createWindowsHarness({ stallTrust: true })
    const pending = loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)
    const rejection = assert.rejects(() => pending, /setup failed/)
    const child = harness.spawn.mock.results[0]?.value

    await vi.advanceTimersByTimeAsync(119_999)
    assert.equal(child.kill.mock.calls.length, 0)
    await vi.advanceTimersByTimeAsync(1)
    await rejection
    assert.equal(child.kill.mock.calls.length, 1)
  } finally {
    vi.useRealTimers()
  }
})

test('Windows trust consent cancellation and output overflow kill the child', async () => {
  const cancelled = createWindowsHarness({ stallTrust: true })
  const controller = new AbortController()
  const cancelledPending = loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(cancelled.deps, controller.signal)
  const cancelledChild = cancelled.spawn.mock.results[0]?.value
  controller.abort()
  await assert.rejects(() => cancelledPending, /setup failed/)
  assert.equal(cancelledChild.kill.mock.calls.length, 1)

  const overflow = createWindowsHarness({ stallTrust: true })
  const overflowPending = loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(overflow.deps)
  const overflowChild = overflow.spawn.mock.results[0]?.value
  overflowChild.stdout.emit('data', Buffer.alloc(64 * 1024 + 1))
  await assert.rejects(() => overflowPending, /setup failed/)
  assert.equal(overflowChild.kill.mock.calls.length, 1)
})

test('Windows first use provisions CurrentUser certificate files and returns PFX TLS material', async () => {
  const harness = createWindowsHarness()
  const material = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  assert.equal(material.kind, 'pfx')
  assert.equal(material.pfx.toString(), 'new-pfx')
  assert.equal(material.passphrase, PASSWORD.toString('base64url'))
  assert.equal(harness.files.get(harness.paths.passwordPath)?.toString(), 'new-ciphertext')
  assert.equal(vi.mocked(harness.deps.safeStorage.encryptString).mock.calls.length, 1)
  assert.equal(vi.mocked(harness.deps.createSecureContext).mock.calls.length, 1)

  const provisionIndex = harness.spawnCalls.findIndex(
    call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
  )

  const firstAclIndex = harness.spawnCalls.findIndex(
    call => call.argv.at(-1) === Buffer.from(WINDOWS_ACL_SCRIPT, 'utf16le').toString('base64')
  )

  assert.ok(firstAclIndex >= 0 && firstAclIndex < provisionIndex)

  const provision = harness.spawnCalls[provisionIndex]

  assert.ok(provision)
  assert.equal(
    provision.env.HERMES_PEEPS_PFX_PASSWORD_B64,
    Buffer.from(PASSWORD.toString('base64url')).toString('base64')
  )
  assert.equal(provision.env.HERMES_PEEPS_PFX_PATH_B64, Buffer.from(harness.paths.pfxPath).toString('base64'))
  assert.ok(harness.spawnCalls.every(call => !call.argv.join(' ').includes(PASSWORD.toString())))
  assert.ok(!WINDOWS_PROVISION_SCRIPT.includes(PASSWORD.toString()))
  assert.equal(
    harness.spawnCalls.filter(
      call => call.argv.at(-1) === Buffer.from(WINDOWS_TRUST_VALIDATE_SCRIPT, 'utf16le').toString('base64')
    ).length,
    2
  )
})

test('Windows provisioning and validation scripts are fixed CurrentUser-only non-elevating contracts', () => {
  assert.match(WINDOWS_PROVISION_SCRIPT, /Cert:\\CurrentUser\\My/)
  assert.doesNotMatch(WINDOWS_PROVISION_SCRIPT, /Cert:\\CurrentUser\\Root/)
  assert.match(WINDOWS_TRUST_SCRIPT, /Cert:\\CurrentUser\\Root/)
  assert.doesNotMatch(WINDOWS_TRUST_SCRIPT, /PFX_PASSWORD|PFX_PATH/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /New-SelfSignedCertificate/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /DNS=localhost&IPAddress=127\.0\.0\.1/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /1\.3\.6\.1\.5\.5\.7\.3\.1/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /ca=false/i)
  assert.match(WINDOWS_PROVISION_SCRIPT, /KeyLength 2048/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /SHA256/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /AddDays\(397\)/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /Export-PfxCertificate/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /Remove-Item -Path .*Cert:\\CurrentUser\\My.*-DeleteKey/)
  assert.match(WINDOWS_PROVISION_SCRIPT, /Test-Path.*Cert:\\CurrentUser\\My/s)
  assert.match(WINDOWS_PROVISION_SCRIPT, /keyContainerPath.*Test-Path/s)
  assert.match(WINDOWS_CLEANUP_SCRIPT, /Remove-Item -Path \$myPath -DeleteKey/)
  assert.match(WINDOWS_CLEANUP_SCRIPT, /Certificate cleanup postcondition failed/)
  assert.match(WINDOWS_ACL_SCRIPT, /SetAccessRuleProtection\(\$true, \$false\)/)
  assert.match(WINDOWS_ACL_SCRIPT, /SetOwner\(\$currentSid\)/)
  assert.match(WINDOWS_VALIDATE_SCRIPT, /\.Owner.*currentSid|currentSid.*\.Owner/s)
  assert.match(WINDOWS_ACL_SCRIPT, /S-1-5-18/)
  assert.match(WINDOWS_ACL_SCRIPT, /S-1-5-32-544/)
  assert.match(WINDOWS_TRUST_VALIDATE_SCRIPT, /X509Chain/)
  assert.match(WINDOWS_TRUST_VALIDATE_SCRIPT, /RevocationMode.*Offline/)
  assert.doesNotMatch(
    [
      WINDOWS_PROVISION_SCRIPT,
      WINDOWS_TRUST_SCRIPT,
      WINDOWS_TRUST_VALIDATE_SCRIPT,
      WINDOWS_ACL_SCRIPT,
      WINDOWS_VALIDATE_SCRIPT
    ].join('\n'),
    /LocalMachine|Start-Process|RunAs|Verb/
  )
})

test('Windows valid bundle is reused without provisioning or replacement', async () => {
  const harness = createWindowsHarness({ existing: true })
  const material = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  assert.equal(material.pfx.toString(), 'existing-pfx')
  assert.equal(
    harness.spawnCalls.filter(
      call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
    ).length,
    0
  )
  assert.equal(vi.mocked(harness.deps.safeStorage.encryptString).mock.calls.length, 0)
})

test('Windows missing secure storage or failed PowerShell setup fails closed with a coarse setup error and cleans partial files', async () => {
  const unavailable = createWindowsHarness({ encryptionAvailable: false })
  await assert.rejects(
    () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(unavailable.deps),
    /Windows Current User certificate setup failed/
  )

  const failed = createWindowsHarness({ failScript: 'provision' })
  await assert.rejects(
    () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(failed.deps),
    /Windows Current User certificate setup failed/
  )
  assert.equal(failed.files.has(failed.paths.pfxPath), false)
  assert.equal(failed.files.has(failed.paths.passwordPath), false)
})

test('Windows missing DPAPI password blob regenerates the incomplete bundle', async () => {
  const harness = createWindowsHarness({ existing: true })
  harness.files.delete(harness.paths.passwordPath)

  const material = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  assert.equal(material.pfx.toString(), 'new-pfx')
  assert.equal(harness.files.has(harness.paths.passwordPath), true)
})

test('Windows DPAPI decrypt failure preserves a complete bundle and fails closed', async () => {
  const harness = createWindowsHarness({ decryptThrows: true, existing: true })
  const unlink = vi.spyOn(harness.deps, 'unlinkSync')
  await assert.rejects(() => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps), /setup failed/)
  assert.equal(unlink.mock.calls.length, 0)
  assert.equal(harness.spawnCalls.length, 0)
  assert.equal(harness.files.size, 3)
})

test('Windows transient validator failures preserve every complete-bundle artifact without cleanup or provisioning', async () => {
  for (const options of [{ failScript: 'validate' as const }, { malformedValidationJson: true }]) {
    const harness = createWindowsHarness({ existing: true, ...options })
    const unlink = vi.spyOn(harness.deps, 'unlinkSync')
    await assert.rejects(() => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps), /setup failed/)
    assert.equal(unlink.mock.calls.length, 0)
    assert.equal(
      harness.spawnCalls.filter(
        call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
      ).length,
      0
    )
    assert.equal(harness.spawnCalls.length, 1)
    assert.equal(harness.files.size, 3)
  }
})

test('Windows proven invalid PFX rotates a complete corrupt bundle', async () => {
  const harness = createWindowsHarness({ existing: true, validation: { pfxValid: false } })
  const material = await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)
  assert.equal(material.pfx.toString(), 'new-pfx')
  assert.ok(
    harness.spawnCalls.some(
      call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
    )
  )
  const cleanupCall = harness.spawnCalls.find(
    call => call.argv.at(-1) === Buffer.from(WINDOWS_CLEANUP_SCRIPT, 'utf16le').toString('base64')
  )
  assert.ok(cleanupCall)
  assert.equal(cleanupCall.windowsHide, false)
  assert.equal(cleanupCall.argv.includes('-NonInteractive'), false)
  assert.equal(
    harness.spawnSync.mock.calls.some(
      call => call[1].at(-1) === Buffer.from(WINDOWS_CLEANUP_SCRIPT, 'utf16le').toString('base64')
    ),
    false
  )
})

test('Windows ACL policy failure preserves a complete bundle instead of rotating it', async () => {
  for (const validation of [{ aclValid: false }]) {
    const harness = createWindowsHarness({ existing: true, validation })
    const unlink = vi.spyOn(harness.deps, 'unlinkSync')
    await assert.rejects(() => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps), /setup failed/)
    assert.equal(unlink.mock.calls.length, 0)
    assert.equal(harness.files.size, 3)
    assert.equal(
      harness.spawnCalls.filter(
        call => call.argv.at(-1) === Buffer.from(WINDOWS_PROVISION_SCRIPT, 'utf16le').toString('base64')
      ).length,
      0
    )
  }
})

test('Windows rejects ACL thumbprint and certificate policy failures', async () => {
  for (const validation of [
    { aclValid: false },
    { thumbprint: '00'.repeat(20) },
    { certificateDer: WEAK_CERT_DER },
    { certificateDer: WRONG_EKU_CERT_DER },
    { certificateDer: WRONG_SAN_CERT_DER }
  ]) {
    const harness = createWindowsHarness({ existing: true, validation })
    await assert.rejects(
      () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps),
      /Windows Current User certificate setup failed/
    )
  }

  const expired = createWindowsHarness({ existing: true })
  expired.deps.now = () => new Date('2028-01-01T00:00:00.000Z')
  await assert.rejects(
    () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(expired.deps),
    /Windows Current User certificate setup failed/
  )
})

test('Windows rejects external paths and symlink or reparse-marked bundle components', async () => {
  const outside = createWindowsHarness({ existing: true })
  outside.deps.userDataPath = () => 'C:\\Users\\alice\\AppData\\Roaming\\Catalyst\\..\\Outside'
  await assert.rejects(
    () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(outside.deps),
    /Windows Current User certificate setup failed/
  )

  const linked = createWindowsHarness({ existing: true })
  linked.deps.lstatSync = filePath =>
    ({
      isDirectory: () => filePath === USER_DATA || filePath === linked.paths.root,
      isFile: () => linked.files.has(filePath),
      isSymbolicLink: () => filePath === linked.paths.root
    }) as never
  await assert.rejects(
    () => loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(linked.deps),
    /Windows Current User certificate setup failed/
  )
})

test('Windows leaf validator requires exact localhost SANs serverAuth validity CA false SHA-256 and RSA 2048', () => {
  const valid = new X509Certificate(VALID_CERT_DER)
  assert.doesNotThrow(() => validateWindowsPeepsVoiceAuthLeaf(valid, new Date('2026-09-05T00:00:00.000Z')))
  assert.throws(() =>
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(WEAK_CERT_DER), new Date('2026-09-05T00:00:00.000Z'))
  )
  assert.throws(() =>
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(WRONG_EKU_CERT_DER), new Date('2026-09-05T00:00:00.000Z'))
  )
  assert.throws(() =>
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(WRONG_SAN_CERT_DER), new Date('2026-09-05T00:00:00.000Z'))
  )
  assert.throws(() => validateWindowsPeepsVoiceAuthLeaf(valid, new Date('2028-01-01T00:00:00.000Z')))
  assert.throws(() =>
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(SHA1_CERT_DER), new Date('2026-09-05T00:00:00.000Z'))
  )
  assert.throws(() =>
    validateWindowsPeepsVoiceAuthLeaf(new X509Certificate(LONG_LIVED_CERT_DER), new Date('2026-09-05T00:00:00.000Z'))
  )
})

test('Windows shows only the public-certificate trust mutation', async () => {
  const harness = createWindowsHarness()

  await loadOrCreateWindowsPeepsVoiceAuthTlsMaterial(harness.deps)

  const trustScript = Buffer.from(WINDOWS_TRUST_SCRIPT, 'utf16le').toString('base64')
  const trustCall = harness.spawnCalls.find(call => call.argv.at(-1) === trustScript)
  assert.ok(trustCall)
  assert.equal(trustCall.windowsHide, false)
  assert.equal(trustCall.argv.includes('-NonInteractive'), false)
  assert.equal('HERMES_PEEPS_PFX_PASSWORD_B64' in trustCall.env, false)
  assert.ok('HERMES_PEEPS_CERT_PATH_B64' in trustCall.env)

  for (const call of harness.spawnCalls.filter(candidate => candidate !== trustCall)) {
    assert.equal(call.windowsHide, true)
  }
})

test('Windows bundle paths are fixed beneath Electron userData', () => {
  assert.deepEqual(resolveWindowsPeepsVoiceAuthPaths(USER_DATA), {
    certificatePath: path.win32.join(USER_DATA, 'peeps-voice-auth', 'localhost.cer'),
    passwordPath: path.win32.join(USER_DATA, 'peeps-voice-auth', 'localhost-pfx-password.dpapi'),
    pfxPath: path.win32.join(USER_DATA, 'peeps-voice-auth', 'localhost.pfx'),
    root: path.win32.join(USER_DATA, 'peeps-voice-auth')
  })
})
