import { readFileSync } from 'node:fs'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{
    name: 'specops-public-assets-as-text',
    enforce: 'pre',
    load(id) {
      if (/\/src\/server\/public\/(?:app\.js|index\.html|styles\.css)$/.test(id)) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
      }
      if (/\/src\/(?:skills|prompts)\/.+\.md$/.test(id)) {
        return `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`
      }
      return null
    },
  }],
  test: {
    environment: 'node',
    // SpecOps tests do heavy git + filesystem I/O (worktrees, commits, rm -rf
    // cleanup in afterEach). Running test files in parallel turns the filesystem
    // into a bottleneck and produces intermittent ENOTEMPTY races during tmpdir
    // cleanup. Sequential file execution keeps the suite stable without
    // changing any test logic.
    fileParallelism: false,
  },
})
