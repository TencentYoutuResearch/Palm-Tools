/** Produce platform-specific managed SSH Host artifacts; called by distribution builds and local development. */
import { spawn } from 'node:child_process'
import { mkdir, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)), '../..')
const value = process.argv.indexOf('--target'), target = value < 0 ? (process.platform === 'darwin' ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin` : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl`) : process.argv[value + 1]
const platforms = { 'x86_64-unknown-linux-musl': 'linux-x64', 'aarch64-unknown-linux-musl': 'linux-arm64', 'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64' }
if (!platforms[target]) throw new Error('Unsupported remote target')
async function run(command, args) { await new Promise((resolve, reject) => { const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false }); child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`))) }) }
const build = ['build', '--release', '--target', target, '-p', 'kode-bridge', '--bin', 'kode-session-server', '--bin', 'kode-ssh-tunnel', '--config', 'profile.release.lto=false', '--config', 'profile.release.codegen-units=16']
if (target.includes('linux') && process.platform !== 'linux') {
  const platform = target.startsWith('aarch64') ? 'linux/arm64' : 'linux/amd64', image = `kode-remote-memory-bridge-builder:${target}`
  try { await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']) }
  catch { await run('docker', ['build', '--platform', platform, '-t', image, '-f', 'deploy/remote-memory-bridge-builder-musl.Dockerfile', 'deploy']) }
  await run('docker', ['run', '--rm', '--platform', platform, '-v', `${root}:/work`, '-v', `kode-dsh-cargo-${target}:/usr/local/cargo`, '-v', `kode-dsh-rustup-${target}:/usr/local/rustup`, '-w', '/work', image, 'cargo', ...build])
} else await run('cargo', build)
const destination = join(root, 'integrations/dsh/assets/remote', platforms[target]); await mkdir(destination, { recursive: true })
for (const name of ['kode-session-server', 'kode-ssh-tunnel']) await copyFile(join(root, 'target', target, 'release', name), join(destination, name))
process.stdout.write(`Remote Host artifacts: ${destination}\n`)
