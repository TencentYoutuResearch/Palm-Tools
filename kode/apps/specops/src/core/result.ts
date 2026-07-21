export interface Diagnostic {
  code: string
  message: string
  path?: string
  severity: 'error' | 'warning'
}

export interface CommandResult<T = unknown> {
  ok: boolean
  command: string
  data?: T
  diagnostics: Diagnostic[]
}
