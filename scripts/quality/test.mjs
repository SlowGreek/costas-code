#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'

import {
  assertCheckFlag,
  DESKTOP,
  localPackage,
  normalizeDiagnostic,
  publishReport,
  receiptLine,
  repositoryPath,
  runNode,
  sourceReceipt,
  temporaryDirectory
} from './common.mjs'

assertCheckFlag()
const source = sourceReceipt()
const vitest = localPackage('vitest')
const cli = path.join(vitest.root, 'vitest.mjs')
const temporary = temporaryDirectory('test')
const report = path.join(temporary, 'vitest.json')

try {
  const result = runNode(cli, ['run', '--project', 'ui', '--project', 'electron', '--reporter=json', `--outputFile=${report}`], DESKTOP)
  if (!fs.existsSync(report)) {
    throw new Error('quality-test-report-missing')
  }
  const value = JSON.parse(fs.readFileSync(report, 'utf8'))
  const passed = value.numPassedTests
  const failed = value.numFailedTests
  const skipped = value.numPendingTests
  const todo = value.numTodoTests
  const total = value.numTotalTests
  if (
    ![passed, failed, skipped, todo, total].every(Number.isSafeInteger) ||
    [passed, failed, skipped, todo, total].some(count => count < 0) ||
    passed + failed + skipped + todo !== total ||
    total === 0
  ) {
    throw new Error('quality-test-counts')
  }
  const suites = value.testResults.map(suite => {
    const assertions = suite.assertionResults ?? []
    const statusCount = status => assertions.filter(assertion => assertion.status === status).length
    const suitePassed = statusCount('passed')
    const suiteFailed = statusCount('failed')
    const suiteSkipped = statusCount('skipped') + statusCount('pending') + statusCount('disabled')
    const suiteTodo = statusCount('todo')
    const failures = assertions
      .filter(assertion => assertion.status === 'failed')
      .map((assertion, index) => ({
        id: assertion.fullName || assertion.title || `failure-${index + 1}`,
        message: normalizeDiagnostic((assertion.failureMessages ?? []).join('\n') || 'test failed')
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.message.localeCompare(right.message))
    return {
      id: repositoryPath(suite.name),
      name: repositoryPath(suite.name),
      passed: suitePassed,
      failed: suiteFailed,
      skipped: suiteSkipped,
      todo: suiteTodo,
      filtered_out: suiteSkipped + suiteTodo,
      total: assertions.length,
      failures
    }
  }).sort((left, right) => left.name.localeCompare(right.name))
  const shaped = {
    schema: 'test/1',
    status: failed === 0 && result.ok ? 'GREEN' : 'RED',
    command: 'node scripts/quality/test.mjs',
    summary: { passed, failed, skipped, todo, filtered_out: skipped + todo, total },
    suites,
    provenance: { source, tools: { node: process.versions.node, vitest: vitest.version } }
  }
  publishReport('test-report.json', shaped)
  process.stdout.write(
    `test result: ${failed === 0 && result.ok ? 'ok' : 'FAILED'}. ${passed} passed; ${failed} failed; 0 ignored; 0 measured; ${skipped + todo} filtered out\n`
  )
  process.stdout.write(`${receiptLine(source)}\n`)
  if (!result.ok || failed !== 0) {
    process.stderr.write(normalizeDiagnostic(result.stderr || result.error || 'desktop UI and Electron Vitest failed') + '\n')
    process.exitCode = 1
  }
  process.stdout.write(`tool receipt: vitest@${vitest.version}; node@${process.versions.node}\n`)
} finally {
  fs.rmSync(temporary, { force: true, recursive: true })
}
