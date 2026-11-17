import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
if (process.argv[2] === 'wrapper') {
  const child = spawn(process.env.TCLAUDE_CLAUDE_PATH, ['--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: process.env.FIXTURE_GATEWAY } })], { stdio: 'inherit', env: process.env })
  child.on('exit', code => process.exit(code ?? 1))
} else {
  const args = process.argv.slice(3), get = name => args[args.indexOf(name) + 1]
  if (!args.includes('--restricted') || get('--tools') !== '' || get('--permission-mode') !== 'manual' || !args.includes('--bare')) process.exit(2)
  const lines = createInterface({ input: process.stdin })
  for await (const line of lines) {
    const input = JSON.parse(line)
    const prompt = input.message.content
    const res = await fetch(process.env.ANTHROPIC_BASE_URL + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: get('--model').replace(/\[1m\]$/, ''), tools: [], messages: [{ role: 'user', content: prompt }] }) })
    if (!res.ok) { console.log(JSON.stringify({ type: 'result', subtype: 'error', is_error: true })); continue }
    const body = await res.json()
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: body.content[0].text, usage: prompt.includes('MISSING_NATIVE_USAGE') ? undefined : prompt.includes('CONFLICT_USAGE') ? { ...body.usage, output_tokens: 999 } : body.usage }))
  }
}
