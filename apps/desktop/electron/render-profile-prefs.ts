import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const STORE_SCHEMA = 'hermes-render-profile-store/1' as const
const RESULT_SCHEMA = 'hermes-render-profile-commit/1' as const
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/
const MAX_STORE_BYTES = 64 * 1024

interface Store {
  schema: typeof STORE_SCHEMA
  revision: number
  profiles: Record<string, string>
  idempotency: Record<string, CommitResult>
}

export interface ProfilePreference {
  schema: 'hermes-render-profile-preference/1'
  revision: number
  profile: string
  profile_id: string
}

export interface CommitResult {
  schema: typeof RESULT_SCHEMA
  revision: number
  profile: string
  profile_id: string
  receipt_sha256: `sha256:${string}`
  idempotent: boolean
}

export interface CommitRequest {
  profile: string
  profile_id: string
  expected_revision: number
  idempotency_key: string
}

const initial = (): Store => ({ schema: STORE_SCHEMA, revision: 0, profiles: {}, idempotency: {} })

const sha256 = (value: string): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(value).digest('hex')}`

function safe(value: string): boolean {
  return SAFE_ID_RE.test(value)
}

function parseStore(value: unknown): Store {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {throw new Error('render-profile-store-invalid')}
  const row = value as Record<string, unknown>

  if (
    row.schema !== STORE_SCHEMA ||
    !Number.isSafeInteger(row.revision) ||
    Number(row.revision) < 0 ||
    !row.profiles ||
    typeof row.profiles !== 'object' ||
    Array.isArray(row.profiles) ||
    !row.idempotency ||
    typeof row.idempotency !== 'object' ||
    Array.isArray(row.idempotency)
  ) {throw new Error('render-profile-store-invalid')}

  const profiles = row.profiles as Record<string, unknown>

  if (Object.keys(profiles).length > 128 || Object.entries(profiles).some(([key, id]) => !safe(key) || typeof id !== 'string' || !safe(id))) {
    throw new Error('render-profile-store-invalid')
  }

  const idempotency = row.idempotency as Record<string, unknown>

  if (Object.keys(idempotency).length > 256) {throw new Error('render-profile-store-invalid')}

  return row as unknown as Store
}

export class RenderProfilePreferenceStore {
  constructor(private readonly file: string) {}

  private readStore(): Store {
    try {
      const bytes = fs.readFileSync(this.file)

      if (bytes.length > MAX_STORE_BYTES) {throw new Error('render-profile-store-bound')}

      return parseStore(JSON.parse(bytes.toString('utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return initial()}
      throw error
    }
  }

  private writeStore(store: Store): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const temp = `${this.file}.${process.pid}.${Date.now()}.tmp`
    const body = `${JSON.stringify(store, null, 2)}\n`

    if (Buffer.byteLength(body) > MAX_STORE_BYTES) {throw new Error('render-profile-store-bound')}
    fs.writeFileSync(temp, body, { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(temp, this.file)
  }

  get(profile: string, fallback = 'glassmorphism'): ProfilePreference {
    if (!safe(profile) || !safe(fallback)) {throw new Error('render-profile-preference-id')}
    const store = this.readStore()

    return {
      schema: 'hermes-render-profile-preference/1',
      revision: store.revision,
      profile,
      profile_id: store.profiles[profile] ?? fallback
    }
  }

  commit(request: CommitRequest): CommitResult {
    if (
      !safe(request.profile) ||
      !safe(request.profile_id) ||
      !safe(request.idempotency_key) ||
      !Number.isSafeInteger(request.expected_revision) ||
      request.expected_revision < 0
    ) {throw new Error('render-profile-commit-request')}

    const store = this.readStore()
    const prior = store.idempotency[request.idempotency_key]

    if (prior) {return { ...prior, idempotent: true }}

    if (store.revision !== request.expected_revision) {throw new Error('render-profile-revision-conflict')}

    const revision = store.revision + 1

    const unsigned = {
      schema: RESULT_SCHEMA,
      revision,
      profile: request.profile,
      profile_id: request.profile_id
    }

    const result: CommitResult = {
      ...unsigned,
      receipt_sha256: sha256(JSON.stringify(unsigned)),
      idempotent: false
    }

    const idempotency = { ...store.idempotency, [request.idempotency_key]: result }
    const entries = Object.entries(idempotency)
    const bounded = Object.fromEntries(entries.slice(Math.max(0, entries.length - 128)))
    this.writeStore({
      schema: STORE_SCHEMA,
      revision,
      profiles: { ...store.profiles, [request.profile]: request.profile_id },
      idempotency: bounded
    })

    const observed = this.get(request.profile)

    if (observed.revision !== revision || observed.profile_id !== request.profile_id) {
      throw new Error('render-profile-readback-mismatch')
    }

    return result
  }
}
