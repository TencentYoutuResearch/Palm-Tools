import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initWorkspace, scanWorkspace } from '../src/domain/commands.js';
import { pathInside } from '../src/store/workspace.js';
import { gitWorkspace } from './helpers.js';
const cleanup = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
describe('workspace commands', () => {
    test('init is idempotent and scan is rebuildable', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        const first = await initWorkspace(workspace);
        const second = await initWorkspace(workspace);
        expect(first.data?.created.length).toBeGreaterThan(0);
        expect(second.data?.created).toEqual([]);
        const scanned = await scanWorkspace(workspace);
        expect(scanned.ok).toBe(true);
        expect(scanned.data?.documents.map((item) => item.id)).toEqual(['project-overview']);
        const statePath = path.join(workspace, '.specops/state/registry.json');
        await rm(statePath);
        await scanWorkspace(workspace);
        expect(JSON.parse(await readFile(statePath, 'utf8')).documents).toHaveLength(1);
    });
    test('scan reports duplicate ids without replacing valid state', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        await scanWorkspace(workspace);
        const statePath = path.join(workspace, '.specops/state/registry.json');
        const before = await readFile(statePath, 'utf8');
        const original = await readFile(path.join(workspace, '.specops/specs/project-overview.md'), 'utf8');
        await writeFile(path.join(workspace, '.specops/specs/duplicate.md'), original);
        const result = await scanWorkspace(workspace);
        expect(result.ok).toBe(false);
        expect(result.diagnostics[0]?.code).toBe('duplicate_id');
        expect(await readFile(statePath, 'utf8')).toBe(before);
    });
    test('scan rejects symlinks in canonical documents', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        await symlink('/tmp', path.join(workspace, '.specops/specs/outside'));
        await expect(scanWorkspace(workspace)).rejects.toThrow('symlinks are not allowed');
    });
    test('pathInside rejects traversal', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        expect(() => pathInside(workspace, '..', 'outside')).toThrow('path escapes workspace');
    });
});
