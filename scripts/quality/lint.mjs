#!/usr/bin/env node

import path from 'node:path'

import {
  assertCheckFlag,
  DESKTOP,
  localPackage,
  normalizeDiagnostic,
  publishReport,
  receiptLine,
  repositoryPath,
  ROOT,
  runNode,
  sourceReceipt
} from './common.mjs'

assertCheckFlag()
const source = sourceReceipt()
process.stdout.write(`${receiptLine(source)}\n`)
const typescript = localPackage('typescript')
const eslint = localPackage('eslint')
const tsc = path.join(typescript.root, 'bin', 'tsc')
const eslintCli = path.join(eslint.root, 'bin', 'eslint.js')
const stages = [
  ['typecheck-renderer', 'desktop renderer typecheck', tsc, ['-p', 'apps/desktop/tsconfig.json', '--noEmit', '--pretty', 'false'], ROOT],
  ['typecheck-electron', 'desktop Electron typecheck', tsc, ['-p', 'apps/desktop/tsconfig.electron.json', '--noEmit', '--pretty', 'false'], ROOT],
  ['typecheck-e2e', 'desktop E2E typecheck', tsc, ['-p', 'apps/desktop/tsconfig.e2e.json', '--noEmit', '--pretty', 'false'], ROOT]
]

const checks = []
for (const [id, label, entry, args, cwd] of stages) {
  const result = runNode(entry, args, cwd)
  const diagnostic = normalizeDiagnostic([result.stdout, result.stderr, result.error].filter(Boolean).join('\n'))
  const findings = diagnostic
    ? diagnostic.split('\n').filter(Boolean).map((message, index) => {
        const match = message.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.*)$/)
        return match
          ? {
              id: `${id}:${String(index + 1).padStart(4, '0')}`,
              severity: match[4],
              file: repositoryPath(path.resolve(ROOT, match[1])),
              line: Number(match[2]),
              column: Number(match[3]),
              rule: match[5],
              message: match[6]
            }
          : {
              id: `${id}:${String(index + 1).padStart(4, '0')}`,
              severity: 'error',
              file: 'scripts/quality/lint.mjs',
              line: 1,
              rule: result.error ? 'typescript-execution' : 'typescript-diagnostic',
              message
            }
      })
    : []
  if (!result.ok && findings.length === 0) {
    findings.push({
      id: `${id}:execution`,
      severity: 'error',
      file: 'scripts/quality/lint.mjs',
      line: 1,
      rule: 'typescript-execution',
      message: `${label} exited ${result.status ?? 'without status'}${result.signal ? ` (${result.signal})` : ''}`
    })
  }
  checks.push({ id, name: label, level: 'error', findings })
}

const eslintResult = runNode(eslintCli, ['src/', 'electron/', '--format=json'], DESKTOP)
let eslintFindings = []
try {
  const files = JSON.parse(eslintResult.stdout || '[]')
  eslintFindings = files.flatMap(file =>
    file.messages.map((message, index) => ({
      id: `eslint:${repositoryPath(file.filePath)}:${message.line}:${message.column}:${message.ruleId ?? 'fatal'}:${index}`,
      severity: message.severity === 2 ? 'error' : 'warning',
      file: repositoryPath(file.filePath),
      line: message.line,
      column: message.column,
      end_line: message.endLine ?? message.line,
      end_column: message.endColumn ?? message.column,
      rule: message.ruleId ?? 'eslint-fatal',
      message: message.message,
      fixable: Boolean(message.fix)
    }))
  )
} catch (error) {
  eslintFindings = [{
    id: 'eslint:report',
    severity: 'error',
    file: 'scripts/quality/lint.mjs',
    line: 1,
    rule: 'eslint-report',
    message: normalizeDiagnostic(`${error.message}: ${eslintResult.stderr || eslintResult.stdout || eslintResult.error}`)
  }]
}
eslintFindings.sort((left, right) =>
  left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column || left.rule.localeCompare(right.rule)
)
checks.push({ id: 'eslint', name: 'desktop ESLint', level: 'error', findings: eslintFindings })

const violations = checks.reduce((total, check) => total + check.findings.length, 0)
const report = {
  schema: 'lint/1',
  status: violations === 0 ? 'GREEN' : 'RED',
  command: 'node scripts/quality/lint.mjs',
  checks,
  provenance: {
    source,
    tools: { eslint: eslint.version, node: process.versions.node, typescript: typescript.version }
  }
}
publishReport('lint-report.json', report)
process.stdout.write(`lint result: ${violations === 0 ? 'ok' : 'FAILED'}. ${checks.length} checks; ${violations} violations\n`)
process.stdout.write(`${receiptLine(source)}\n`)
process.stdout.write(`tool receipt: typescript@${typescript.version}; eslint@${eslint.version}; node@${process.versions.node}\n`)
if (violations > 0 || !eslintResult.ok) process.exitCode = 1
