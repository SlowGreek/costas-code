import { describe, expect, it } from 'vitest'

import { ar } from './ar'
import { en } from './en'
import { ja } from './ja'
import { zh } from './zh'
import { zhHant } from './zh-hant'

/**
 * Catalyst is a downstream fork of Hermes Agent. Every upstream sync drags in
 * new user-facing copy that says "Hermes", and it is invisible in review — the
 * strings typecheck, the tests pass, and the wrong brand ships. One sync left
 * 422 such strings across five locale catalogs, including the setup screens
 * ("Set up Hermes Desktop", "Connect to existing Hermes").
 *
 * These are invariants about the brand, not snapshots of the copy: they assert
 * that no user-visible VALUE names the upstream product, so rewording a string
 * never breaks them but reintroducing the brand always does.
 */

/** Real external things that legitimately keep the Hermes name. */
const ALLOWED = [
  // Nous Research's hosted service — a real product, not our app.
  /Hermes Cloud/,
  // Install URL, package name, env vars, and the on-disk binary.
  /hermes-agent\.nousresearch\.com/,
  /hermes-agent/,
  /hermes_agent/,
  /HERMES_[A-Z_]+/,
  /\bhermes\b/, // lowercase = the CLI binary / command, not the brand
]

function stripAllowed(value: string): string {
  return ALLOWED.reduce((acc, re) => acc.replace(new RegExp(re, 'g'), ''), value)
}

/** Walk a catalog and yield every [path, string] leaf. */
function* strings(node: unknown, path = ''): Generator<[string, string]> {
  if (typeof node === 'string') {
    yield [path, node]

    return
  }

  if (typeof node === 'function') {
    // Template functions (e.g. `(host, platform) => \`...\``) hide their copy
    // behind a call. Invoke with placeholders so the brand check sees it.
    let rendered: unknown

    try {
      rendered = (node as (...a: unknown[]) => unknown)('«a»', '«b»', '«c»', '«d»')
    } catch {
      return // needs richer args than we can synthesise; skip rather than fail
    }

    if (typeof rendered === 'string') {
      yield [path, rendered]
    }

    return
  }

  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      yield* strings(child, path ? `${path}.${key}` : key)
    }
  }
}

const CATALOGS = { en, zh, 'zh-hant': zhHant, ja, ar } as const

describe('brand: user-facing copy says Catalyst, never Hermes', () => {
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    it(`${locale}: no translated value names the upstream product`, () => {
      const offenders: string[] = []

      for (const [path, value] of strings(catalog)) {
        if (!/Hermes/i.test(value)) {continue}

        // Key names may still say Hermes (updateHermes, sshHermesPathTitle) —
        // only the VALUE is user-visible, and that is what we check here.
        if (/Hermes/.test(stripAllowed(value))) {
          offenders.push(`${path}: ${JSON.stringify(value.slice(0, 120))}`)
        }
      }

      expect(
        offenders,
        `${offenders.length} string(s) still say "Hermes". Rebrand the value ` +
          `to Catalyst, or add a genuinely-external term to ALLOWED:\n` +
          offenders.slice(0, 20).join('\n')
      ).toEqual([])
    })
  }

  it('the upstream product name never appears in any locale', () => {
    for (const [locale, catalog] of Object.entries(CATALOGS)) {
      for (const [path, value] of strings(catalog)) {
        expect(
          value,
          `${locale}.${path} contains the upstream product name`
        ).not.toMatch(/Hermes (Agent|Desktop)\b/)
      }
    }
  })

  it('still allows the genuinely-external Hermes names through', () => {
    // Guards the guard: if ALLOWED is ever tightened into uselessness, or the
    // stripper starts eating everything, these must still be reachable.
    expect(stripAllowed('Managed by Hermes Cloud')).not.toMatch(/Hermes/)
    expect(stripAllowed('run `hermes serve` first')).not.toMatch(/Hermes/i)
    // ...but a real regression is still caught.
    expect(stripAllowed('Set up Hermes Desktop')).toMatch(/Hermes/)
  })
})
