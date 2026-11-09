/** Ship one small universal macOS screen geometry reader. */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
const directory = fileURLToPath(new URL('../assets/desktop/', import.meta.url))
mkdirSync(directory, { recursive: true })
execFileSync('/usr/bin/clang', ['-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0', '-fobjc-arc', '-framework', 'AppKit', directory + 'screen-layout.m', '-o', directory + 'screen-layout'], { stdio: 'inherit' })
