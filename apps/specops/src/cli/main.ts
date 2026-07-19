#!/usr/bin/env node
import process from 'node:process'

import { SpecOpsError, type ExitCode } from '../core/errors.js'
import { initWorkspace, scanWorkspace, archiveChange } from '../domain/commands.js'
import { driftWorkspace, gateWorkspace, analyzeWorkspace } from '../domain/gate.js'
import { serve } from '../server/index.js'
import { applyCompletedRun, decideRun, verifyRun } from '../domain/run-loop.js'
import { cleanupRun, readRun } from '../domain/run.js'

const VERSION = '0.1.0-dev'

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
}

function option(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`))
  if (equals !== undefined) return equals.slice(name.length + 1)
  const index = args.indexOf(name)
  return index < 0 ? undefined : args[index + 1]
}

function options(args: string[], name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name && args[index + 1] !== undefined) values.push(args[index + 1] as string)
    else if (arg?.startsWith(`${name}=`)) values.push(arg.slice(name.length + 1))
  }
  return values
}

const HELP = `SpecOps - spec-driven execution console

Usage:
  specops <command> [options]

Commands:
  init       Initialize SpecOps in a Git workspace
  scan       Rebuild generated state from canonical specs
  gate       Validate commit references and configured checks
  drift      Report spec and implementation drift
  analyze    Check cross-artifact consistency (scope→tasks, design→tasks)
  serve      Start the local review console
  run        Execute a task through an agent backend
  archive    Archive a completed change to changes/archive/

Global options:
  -h, --help       Show this help
  -v, --version    Show the version
`

export async function runCli(args: string[], io: CliIo): Promise<ExitCode> {
  const [command, ...rest] = args
  if (command === undefined || command === '-h' || command === '--help') {
    io.stdout(HELP)
    return 0
  }
  if (command === '-v' || command === '--version') {
    io.stdout(`${VERSION}\n`)
    return 0
  }
  const workspace = option(rest, '--workspace') ?? option(rest, '-C') ?? process.cwd()
  if (workspace === undefined) {
    throw new SpecOpsError('missing_option', '--workspace requires a path')
  }
  const json = rest.includes('--json') || rest.includes('--format=json')
  if (command === 'init' || command === 'scan') {
    const result = command === 'init'
      ? await initWorkspace(workspace)
      : await scanWorkspace(workspace)
    if (json) io.stdout(`${JSON.stringify(result)}\n`)
    else {
      io.stdout(`${command}: ${result.ok ? 'ok' : 'failed'}\n`)
      for (const diagnostic of result.diagnostics) {
        io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
      }
    }
    return result.ok ? 0 : 1
  }
  if (command === 'gate') {
    const base = option(rest, '--base')
    if (base === undefined) throw new SpecOpsError('missing_option', 'gate requires --base <git-ref>')
    const result = await gateWorkspace(workspace, base, option(rest, '--head') ?? 'HEAD', options(rest, '--verify'))
    if (json) io.stdout(`${JSON.stringify(result)}\n`)
    else {
      io.stdout(`gate: ${result.ok ? 'pass' : 'fail'}\n`)
      for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
    }
    return result.ok ? 0 : 1
  }
  if (command === 'drift') {
    const result = await driftWorkspace(workspace)
    if (json) io.stdout(`${JSON.stringify(result)}\n`)
    else {
      io.stdout(`drift: ${result.ok ? 'ok' : 'failed'}\n`)
      for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
    }
    return result.ok ? 0 : 1
  }
  if (command === 'analyze') {
    const result = await analyzeWorkspace(workspace)
    if (json) io.stdout(`${JSON.stringify(result)}\n`)
    else {
      io.stdout(`analyze: ${result.ok ? 'ok' : 'failed'}\n`)
      for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
    }
    return result.ok ? 0 : 1
  }
  if (command === 'serve') {
    const portValue = option(rest, '--port')
    const port = portValue === undefined ? 0 : Number(portValue)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new SpecOpsError('invalid_option', '--port must be 0..65535')
    await serve({ workspace, port })
  }
  if (command === 'archive') {
    const changeId = rest[0]
    if (changeId === undefined) throw new SpecOpsError('missing_option', 'archive requires a change id')
    const result = await archiveChange(workspace, changeId)
    if (json) io.stdout(`${JSON.stringify(result)}\n`)
    else {
      io.stdout(`archive: ${result.ok ? 'ok' : 'failed'}\n`)
      for (const diagnostic of result.diagnostics) io.stderr(`${diagnostic.severity}: ${diagnostic.message}\n`)
      if (result.ok && result.data) {
        io.stdout(`  ${result.data.from} → ${result.data.to}\n`)
      }
    }
    return result.ok ? 0 : 1
  }
  if (command === 'run') {
    const [action] = rest
    if (action === 'create') {
      throw new SpecOpsError(
        'unsupported_cli_execution',
        'run create requires the long-lived structured execution runtime; use `specops serve` and the Runs API',
      )
    }
    const runId = option(rest, '--id')
    if (runId === undefined) throw new SpecOpsError('missing_option', `run ${action ?? ''} requires --id <run-id>`)
    const run = await readRun(workspace, runId)
    if (action === 'status') {
      io.stdout(`${JSON.stringify({ run })}\n`)
      return 0
    }
    if (action === 'verify') {
      io.stdout(`${JSON.stringify(await verifyRun(run))}\n`)
      return 0
    }
    if (action === 'decide') {
      const verdict = option(rest, '--verdict')
      if (verdict !== 'accept' && verdict !== 'reject' && verdict !== 'feedback') {
        throw new SpecOpsError('invalid_option', '--verdict must be accept, reject, or feedback')
      }
      if (verdict === 'feedback' || (verdict === 'accept' && run.current_task + 1 < run.tasks.length)) {
        throw new SpecOpsError(
          'unsupported_cli_execution',
          'feedback and multi-task continuation require the long-lived structured execution runtime; use `specops serve`',
        )
      }
      const decision = await decideRun(run, verdict, option(rest, '--note') ?? '')
      io.stdout(`${JSON.stringify({ run: decision.run })}\n`)
      return 0
    }
    if (action === 'apply') {
      const outcome = await applyCompletedRun(run)
      io.stdout(`${JSON.stringify({ ok: true, ...outcome })}\n`)
      return 0
    }
    if (action === 'cleanup') {
      await cleanupRun(run)
      io.stdout(`${JSON.stringify({ ok: true })}\n`)
      return 0
    }
    throw new SpecOpsError('unknown_command', `unknown run action: ${action ?? ''}`)
  }
  throw new SpecOpsError('unknown_command', `unknown command: ${command}`)
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2), {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    })
  } catch (error) {
    const known = error instanceof SpecOpsError
      ? error
      : new SpecOpsError('internal', error instanceof Error ? error.message : String(error))
    process.stderr.write(`${known.code}: ${known.message}\n`)
    process.exitCode = known.exitCode
  }
}

if (import.meta.url === new URL(process.argv[1] ?? '', 'file:').href) {
  await main()
}
