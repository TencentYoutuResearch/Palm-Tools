/** Human ! commands run on this Host through its existing workspace shell. */
import { randomUUID } from 'node:crypto'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
export async function runHumanShell(agent, command, signal) {
  if (!command.trim()) throw new Error('请输入 ! 后面的终端命令。')
  const shell = agent.ctx.get('shell')
  if (!shell) throw new Error('当前主机未安装终端执行插件。')
  const cwd = agent.session.header.cwd, callId = `kode-shell:${randomUUID()}`
  const adapter = agent.runtime.adapter
  adapter.logCall(agent, callId, 'exec_command', { cmd: command, cwd })
  let settled = false
  try {
    const sandboxPolicy = agent.ctx.get('sandboxPolicy')?.resolve({ session: agent.session })
    const execution = await shell.execute(shell.resolve({ command, workdir: cwd, signal, sandboxPolicy }))
    const result = await execution.result()
    const output = [result.stdout.text, result.stderr.text].filter(Boolean).join('\n')
    const failed = result.exitCode !== 0 || result.timedOut || result.aborted
    const text = `${output}${output ? '\n' : ''}退出码：${result.exitCode ?? '未正常退出'}${result.timedOut ? '（超时）' : result.aborted ? '（已取消）' : ''}`
    adapter.logResult(agent, callId, [{ type: 'text', text }], failed); settled = true
    // The next explicit human prompt can use this result, including after a
    // restart. Running ! never wakes the model or replays a shell command.
    appendPluginRecord(agent.session, 'plugin:kode/shell-context', { id: callId, text: `用户在工作区 ${cwd} 执行了终端命令：\n${command}\n结果：\n${text.slice(-32000)}` })
    signal.throwIfAborted()
  } catch (error) {
    if (!settled) adapter.logResult(agent, callId, [{ type: 'text', text: error.message }], true)
    throw error
  }
}
export function pendingShellContext(session) {
  const events = session.snapshotEvents?.() ?? [], consumed = new Set(events.filter(event => event.type === 'plugin:kode/shell-context-consumed').flatMap(event => event.data.ids))
  return events.filter(event => event.type === 'plugin:kode/shell-context' && !consumed.has(event.data.id)).slice(-8).map(event => ({ id: event.data.id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: event.data.text }] }))
}
