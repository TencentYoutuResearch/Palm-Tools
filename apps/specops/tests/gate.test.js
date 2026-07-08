import { appendFile, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initWorkspace } from '../src/domain/commands.js';
import { driftWorkspace, gateWorkspace } from '../src/domain/gate.js';
import { gitCommit, gitWorkspace } from './helpers.js';
const cleanup = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
describe('gate', () => {
    test('requires a reference on every non-merge commit', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const base = await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        await gitCommit(workspace, 'Missing reference');
        const result = await gateWorkspace(workspace, base, 'HEAD');
        expect(result.ok).toBe(false);
        expect(result.diagnostics.map((item) => item.code)).toContain('missing_reference');
    });
    test('resolves spec references and runs named verify commands', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        await appendFile(path.join(workspace, 'specops.toml'),
            '\n[verify.smoke]\ncommand = ["node", "-e", "process.stdout.write(\'ok\')"]\n');
        const base = await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        await gitCommit(workspace, 'Document project\n\nSpec: project-overview');
        const result = await gateWorkspace(workspace, base, 'HEAD', ['smoke']);
        expect(result.ok).toBe(true);
        expect(result.data?.verify_results[0]?.stdout).toBe('ok');
    });
    test('rejects unknown spec references', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const base = await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        await gitCommit(workspace, 'Unknown spec\n\nSpec: missing/spec');
        const result = await gateWorkspace(workspace, base, 'HEAD');
        expect(result.diagnostics.map((item) => item.code)).toContain('unknown_reference');
    });
    test('suppress_commit_types skips commits by type prefix', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        // Configure suppress_commit_types
        const configPath = path.join(workspace, 'specops.toml');
        const config = await readFile(configPath, 'utf8');
        await writeFile(configPath,
            `${config}\n[gate.suppress]\nsuppress_codes = []\nsuppress_commit_types = ["feat"]\n`);
        const base = await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        // feat: commit should be suppressed
        await gitCommit(workspace, 'feat: add feature');
        // feat(scope): commit should also be suppressed (scope stripped)
        await gitCommit(workspace, 'feat(ui): add button');
        // fix: commit should NOT be suppressed
        await gitCommit(workspace, 'fix: bugfix');
        const result = await gateWorkspace(workspace, base, 'HEAD');
        // Only the fix: commit should produce a missing_reference (feat: ones suppressed)
        const missingRefs = result.diagnostics.filter((d) => d.code === 'missing_reference');
        expect(missingRefs).toHaveLength(1);
    });
    test('suppress_codes downgrades errors to warnings', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const configPath = path.join(workspace, 'specops.toml');
        const config = await readFile(configPath, 'utf8');
        await writeFile(configPath,
            `${config}\n[gate.suppress]\nsuppress_codes = ["missing_reference"]\nsuppress_commit_types = []\n`);
        const base = await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        await gitCommit(workspace, 'No reference here');
        const result = await gateWorkspace(workspace, base, 'HEAD');
        // Should be warning, not error
        expect(result.ok).toBe(true); // no errors → ok
        const diag = result.diagnostics.find((d) => d.code === 'missing_reference');
        expect(diag?.severity).toBe('warning');
    });
});
describe('drift', () => {
    test('reports stale paths and unknown verify bindings', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const specPath = path.join(workspace, '.specops/specs/project-overview.md');
        const original = await readFile(specPath, 'utf8');
        const active = original
            .replace('status: draft', 'status: active')
            .replace('title: Project overview',
                'title: Project overview\nverifies:\n  - missing-check\npaths:\n  - missing.file');
        await writeFile(specPath, active);
        const result = await driftWorkspace(workspace);
        expect(result.ok).toBe(false);
        expect(result.data?.stale_paths).toEqual([{ id: 'project-overview', path: 'missing.file' }]);
        expect(result.data?.unknown_verifies).toEqual([{ id: 'project-overview', verify: 'missing-check' }]);
        expect(result.data?.wild_specs).toEqual([]);
    });
    test('warns about wild specs and writes a canonical links report', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        await writeFile(path.join(workspace, 'requirements.md'), '# Wild requirements\n');
        const result = await driftWorkspace(workspace);
        expect(result.ok).toBe(true);
        expect(result.data?.wild_specs).toEqual(['requirements.md']);
        expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'wild_spec', severity: 'warning' }));
    });
});
