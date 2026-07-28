#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
  assertCheckFlag,
  DESKTOP,
  localPackage,
  publishReport,
  receiptLine,
  requireSuccess,
  runNode,
  sourceReceipt,
  temporaryDirectory
} from './common.mjs'

assertCheckFlag()
const source = sourceReceipt()
const vitest = localPackage('vitest')
const coverage = localPackage('@vitest/coverage-v8')
if (coverage.version !== vitest.version) {
  throw new Error(`quality-coverage-provider-version:vitest@${vitest.version}:coverage-v8@${coverage.version}`)
}
const cli = path.join(vitest.root, 'vitest.mjs')
const temporary = temporaryDirectory('coverage')
const report = path.join(temporary, 'coverage-summary.json')

try {
  const result = runNode(
    cli,
    [
      'run',
      '--project',
      'ui',
      '--project',
      'electron',
      '--coverage.enabled',
      '--coverage.provider=v8',
      '--coverage.reporter=json-summary',
      `--coverage.reportsDirectory=${temporary}`,
      '--coverage.clean=true',
      '--coverage.cleanOnRerun=true',
      '--reporter=dot'
    ],
    DESKTOP
  )
  if (!requireSuccess('desktop UI and Electron Vitest coverage', result)) process.exit(1)
  if (!fs.existsSync(report)) throw new Error('quality-coverage-report-missing')
  const value = JSON.parse(fs.readFileSync(report, 'utf8'))
  const totals = value.total
  const readCounts = kind => {
    const total = totals?.[kind]?.total
    const covered = totals?.[kind]?.covered
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(covered) || total <= 0 || covered < 0 || covered > total) {
      throw new Error(`quality-coverage-counts:${kind}`)
    }
    return { count: total, covered }
  }
  const lines = readCounts('lines')
  const branches = readCounts('branches')
  const shaped = {
    schema: 'coverage/1',
    command: 'node scripts/quality/coverage.mjs',
    data: [{ totals: { branches, lines } }],
    provenance: {
      source,
      tools: { '@vitest/coverage-v8': coverage.version, node: process.versions.node, vitest: vitest.version }
    }
  }
  publishReport('coverage-report.json', shaped)
  process.stdout.write(`${JSON.stringify(shaped)}\n`)
  process.stdout.write(`${receiptLine(source)}\n`)
  process.stdout.write(
    `tool receipt: vitest@${vitest.version}; @vitest/coverage-v8@${coverage.version}; node@${process.versions.node}\n`
  )
} finally {
  fs.rmSync(temporary, { force: true, recursive: true })
}
