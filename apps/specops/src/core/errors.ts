export type ExitCode = 0 | 1 | 2

export class SpecOpsError extends Error {
  readonly exitCode: ExitCode
  readonly code: string

  constructor(code: string, message: string, exitCode: ExitCode = 2) {
    super(message)
    this.name = 'SpecOpsError'
    this.code = code
    this.exitCode = exitCode
  }
}
