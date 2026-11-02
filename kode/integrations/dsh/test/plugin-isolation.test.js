import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import { AgentProfiles } from '../src/agent-profiles.js'

test('Kode leaves official execution plugins, presets and defaults intact', async () => {
  const ids = ['agent-loop','system-prompt','harness-dev-context','tool-working-directory','subagent','subagent-spawn-in-process','subagent-fork-in-process','preset-standard','preset-minimal','preset-ptc','preset-cordis','agent-preset-registry']
  const base = ids.map(id => ({id, name:id, config:{default:'standard'}}))
  const patches = yaml.load((await readFile(new URL('../cordis.patch.yml',import.meta.url),'utf8')).replaceAll('!!js ',''))
  const result = applyEntryPatches(base,patches,()=>{})
  for (const entry of base) assert.deepEqual(result.find(row=>row.id===entry.id),entry)
})
test('Kode defaults persist in its own Agent registry', async () => {
  const root=await mkdtemp(join(tmpdir(),'kode-isolated-default-'))
  try {
    const path=join(root,'agents.json'), profiles=await new AgentProfiles(path).open([{id:'test',name:'Test',type:'codex',executable:'codex'}])
    await profiles.setDefaultProfile('test')
    assert.equal((await new AgentProfiles(path).open()).defaultProfileId,'test')
    await profiles.setDefaultProfile(null)
    assert.equal((await new AgentProfiles(path).open()).defaultProfileId,null)
  } finally { await rm(root,{recursive:true,force:true}) }
})
