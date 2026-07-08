import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { initWorkspace } from '../src/domain/commands.js';
import { startServer } from '../src/server/index.js';
import { cleanupRun, readRun } from '../src/domain/run.js';
import { attachSessionAgent, createSpecOpsSession, updateSpecOpsSession } from '../src/domain/session.js';
import { exists } from '../src/store/workspace.js';
import { gitCommit, gitWorkspace } from './helpers.js';
const cleanup = [];
const servers = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
    await Promise.all(cleanup.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});
async function fixture() {
    const workspace = await gitWorkspace();
    cleanup.push(workspace);
    await initWorkspace(workspace);
    const server = await startServer({ workspace, token: 'test-token' });
    servers.push(server);
    return { workspace, server };
}
function auth(server, init = {}) {
    return {
        ...init,
        headers: {
            authorization: `Bearer ${server.token}`,
            origin: server.origin,
            'content-type': 'application/json',
            ...(init.headers ?? {}),
        },
    };
}
describe('SpecOps server', () => {
    test('health is public and state requires a token', async () => {
        const { server } = await fixture();
        expect((await fetch(`${server.origin}/healthz`)).status).toBe(200);
        expect((await fetch(`${server.origin}/api/state`)).status).toBe(401);
        expect((await fetch(`${server.origin}/api/state`, auth(server))).status).toBe(200);
    });
    test('rejects a wrong origin', async () => {
        const { server } = await fixture();
        const response = await fetch(`${server.origin}/api/state`, auth(server, { headers: { origin: 'https://attacker.invalid' } }));
        expect(response.status).toBe(403);
    });
    test('rejects opaque and cross-site browser origins', async () => {
        const { server } = await fixture();
        const opaque = await fetch(`${server.origin}/api/state`, auth(server, {
            headers: { origin: 'null' },
        }));
        expect(opaque.status).toBe(403);
        const crossSite = await fetch(`${server.origin}/api/state`, auth(server, {
            headers: { origin: server.origin, 'sec-fetch-site': 'cross-site' },
        }));
        expect(crossSite.status).toBe(403);
    });
    test('edits documents with optimistic concurrency', async () => {
        const { server } = await fixture();
        const relativePath = '.specops/specs/project-overview.md';
        const loaded = await (await fetch(`${server.origin}/api/document?path=${encodeURIComponent(relativePath)}`, auth(server))).json();
        const changed = loaded.content.replace('status: draft', 'status: active');
        const first = await fetch(`${server.origin}/api/document`, auth(server, {
            method: 'PUT',
            body: JSON.stringify({ path: relativePath, content: changed, version: loaded.version }),
        }));
        expect(first.status).toBe(200);
        const conflict = await fetch(`${server.origin}/api/document`, auth(server, {
            method: 'PUT',
            body: JSON.stringify({ path: relativePath, content: loaded.content, version: loaded.version }),
        }));
        expect(conflict.status).toBe(409);
    });
    test('rejects document traversal', async () => {
        const { server } = await fixture();
        const response = await fetch(`${server.origin}/api/document?path=${encodeURIComponent('../outside.md')}`, auth(server));
        expect(response.status).toBe(400);
    });
    test('creates every document kind in its canonical directory without overwriting', async () => {
        const { workspace, server } = await fixture();
        const cases = [
            { kind: 'spec', directory: 'specs', id: 'feature/create-spec' },
            { kind: 'change', directory: 'changes', id: 'feature/create-change' },
        ];
        for (const item of cases) {
            const relativePath = `.specops/${item.directory}/${item.id}.md`;
            const content = `---\nschema_version: 1\nid: ${item.id}\nkind: ${item.kind}\ntitle: Created ${item.kind}\nstatus: draft\nverifies: []\npaths: []\n---\n`;
            const created = await fetch(`${server.origin}/api/document`, auth(server, {
                method: 'POST',
                body: JSON.stringify({ path: relativePath, content }),
            }));
            expect(created.status).toBe(201);
            expect(await readFile(path.join(workspace, relativePath), 'utf8')).toBe(content);
            const duplicate = await fetch(`${server.origin}/api/document`, auth(server, {
                method: 'POST',
                body: JSON.stringify({ path: relativePath, content: content.replace('Created', 'Overwritten') }),
            }));
            expect(duplicate.status).toBe(409);
            expect(await readFile(path.join(workspace, relativePath), 'utf8')).toBe(content);
        }
    });
    test('runs the verify, decision, and explicit apply workflow', async () => {
        const workspace = await gitWorkspace();
        const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'));
        cleanup.push(workspace, cache);
        await initWorkspace(workspace);
        await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache });
        servers.push(server);
        const createdResponse = await fetch(`${server.origin}/api/runs`, auth(server, {
            method: 'POST',
            body: JSON.stringify({
                backend_key: 'codebuddy',
                tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
            }),
        }));
        expect(createdResponse.status).toBe(201);
        const created = await createdResponse.json();
        await writeFile(path.join(created.run.worktree_path, 'result.txt'), 'verified\n');
        const verified = await fetch(`${server.origin}/api/runs/${created.run.run_id}/verify`, auth(server, { method: 'POST' }));
        expect(verified.status).toBe(200);
        const accepted = await fetch(`${server.origin}/api/runs/${created.run.run_id}/decision`, auth(server, {
            method: 'POST', body: JSON.stringify({ verdict: 'accept', note: 'Reviewed' }),
        }));
        expect((await accepted.json()).run.state).toBe('completed');
        expect(await readFile(path.join(workspace, 'result.txt'), 'utf8').catch(() => '')).toBe('');
        const applied = await fetch(`${server.origin}/api/runs/${created.run.run_id}/apply`, auth(server, { method: 'POST' }));
        expect(applied.status).toBe(200);
        expect(await readFile(path.join(workspace, 'result.txt'), 'utf8')).toBe('verified\n');
        await cleanupRun(await readRun(workspace, created.run.run_id));
    });
    test('quick-run creates a document and launches a run in one call', async () => {
        const workspace = await gitWorkspace();
        const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'));
        cleanup.push(workspace, cache);
        await initWorkspace(workspace);
        await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache });
        servers.push(server);
        const response = await fetch(`${server.origin}/api/quick-run`, auth(server, {
            method: 'POST',
            body: JSON.stringify({
                kind: 'change',
                id: 'test-quick-run',
                title: 'Test quick run',
                body: 'Testing the quick run endpoint',
                backend_key: 'codebuddy',
                tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
            }),
        }));
        expect(response.status).toBe(201);
        const result = await response.json();
        expect(result.document.path).toBe('.specops/changes/test-quick-run.md');
        expect(result.run.state).toBe('running');
        expect(await exists(path.join(workspace, '.specops', 'changes', 'test-quick-run.md'))).toBe(true);
        await writeFile(path.join(result.run.worktree_path, 'result.txt'), 'verified\n');
        const verified = await fetch(`${server.origin}/api/runs/${result.run.run_id}/verify`, auth(server, { method: 'POST' }));
        expect(verified.status).toBe(200);
        const accepted = await fetch(`${server.origin}/api/runs/${result.run.run_id}/decision`, auth(server, {
            method: 'POST', body: JSON.stringify({ verdict: 'accept', note: 'Reviewed' }),
        }));
        expect((await accepted.json()).run.state).toBe('completed');
        await cleanupRun(await readRun(workspace, result.run.run_id));
    });
    test('session list reconciles a run that reached review while the server was down', async () => {
        const workspace = await gitWorkspace();
        const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-server-cache-'));
        cleanup.push(workspace, cache);
        await initWorkspace(workspace);
        await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        const server = await startServer({ workspace, token: 'test-token', runCacheRoot: cache });
        servers.push(server);
        const createdResponse = await fetch(`${server.origin}/api/runs`, auth(server, {
            method: 'POST',
            body: JSON.stringify({
                backend_key: 'codebuddy',
                tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
            }),
        }));
        const created = await createdResponse.json();
        await writeFile(path.join(created.run.worktree_path, 'result.txt'), 'verified\n');
        const verified = await fetch(`${server.origin}/api/runs/${created.run.run_id}/verify`, auth(server, { method: 'POST' }));
        expect(verified.status).toBe(200);
        await updateSpecOpsSession(workspace, created.specops_session.id, (record) => {
            record.phase = 'run_in_worktree';
            record.state = 'active';
            record.required_action = null;
        });
        const listed = await fetch(`${server.origin}/api/sessions`, auth(server));
        expect(listed.status).toBe(200);
        const body = await listed.json();
        const session = body.sessions.find((item) => item.id === created.specops_session.id);
        expect(session?.phase).toBe('review');
        expect(session?.state).toBe('awaiting_user');
        expect(session?.required_action?.kind).toBe('review');
        expect(session?.required_action?.patch_files).toContain('result.txt');
        await cleanupRun(await readRun(workspace, created.run.run_id));
    });
    test('intake analyzes in the primary workspace and writes the classified document without a run', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const prompts = [];
        const session = { id: 42, backend_key: 'codebuddy', status: 'idle' };
        const socket = { on: () => socket, close: () => undefined };
        const kode = {
            createAnalysisSession: async (_backend, cwd, prompt) => {
                expect(await realpath(cwd)).toBe(await realpath(workspace));
                prompts.push(prompt);
                const primaryPath = '.specops/changes/bug/session-filter';
                const secondaryPath = '.specops/specs/session-filter-process.md';
                const primaryFile = path.join(workspace, primaryPath, 'proposal.md');
                await mkdir(path.dirname(primaryFile), { recursive: true });
                await writeFile(primaryFile, [
                    '---',
                    'schema_version: 1',
                    'id: bug/session-filter',
                    'kind: change',
                    'title: Fix session filter',
                    'status: proposed',
                    'verifies: []',
                    'paths: [apps/gui/src]',
                    '---',
                    '',
                    '# Problem',
                    'The filter is stale.',
                    '',
                ].join('\n'));
                const secondary = path.join(workspace, secondaryPath);
                await writeFile(secondary, [
                    '---',
                    'schema_version: 1',
                    'id: session-filter-process',
                    'kind: spec',
                    'title: Session filter process',
                    'status: active',
                    'verifies: []',
                    'paths: [apps/gui/src]',
                    '---',
                    '',
                    '# Process',
                    'Keep the filter synchronized.',
                    '',
                ].join('\n'));
                const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(prompt);
                expect(receiptMatch).not.toBeNull();
                const receiptId = receiptMatch?.[1] ?? '';
                const receipt = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`);
                await mkdir(path.dirname(receipt), { recursive: true });
                await writeFile(receipt, `${JSON.stringify({
                    schema_version: 1,
                    intake_id: receiptId,
                    status: 'completed',
                    primary: primaryPath,
                    documents: [primaryPath, secondaryPath],
                })}\n`);
                return session;
            },
            getSession: async () => session,
            subscribe: () => socket,
        };
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode });
        servers.push(server);
        const started = await fetch(`${server.origin}/api/intakes`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ request: 'The session filter is stale', backend_key: 'codebuddy' }),
        }));
        const startedBody = await started.json();
        expect({ status: started.status, error: startedBody.error }).toEqual({ status: 201, error: undefined });
        const specopsSession = startedBody.specops_session;
        expect(specopsSession).toMatchObject({ phase: 'analyze_request', state: 'active' });
        expect(prompts[0]).toContain('Do not edit source files');
        const listed = await (await fetch(`${server.origin}/api/sessions`, auth(server))).json();
        expect(listed.sessions[0]?.id).toBe(specopsSession.id);
        const result = await (await fetch(`${server.origin}/api/intakes/42`, auth(server))).json();
        expect(result.document.path).toBe('.specops/changes/bug/session-filter');
        expect(result.documents).toEqual([
            '.specops/changes/bug/session-filter',
            '.specops/specs/session-filter-process.md',
        ]);
        expect(await readFile(path.join(workspace, result.document.path, 'proposal.md'), 'utf8')).toContain('kind: change');
        expect(await exists(path.join(workspace, '.specops', 'runs', '42'))).toBe(false);
        const detail = await (await fetch(`${server.origin}/api/sessions/${specopsSession.id}`, auth(server))).json();
        expect(detail.session).toMatchObject({
            document_path: '.specops/changes/bug/session-filter',
            phase: 'run_in_worktree',
            state: 'awaiting_user',
            required_action: { kind: 'run_in_worktree' },
        });
    });
    test('intake commits plan docs with specops(plan): prefix', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        const headBeforeDocs = await (await import('./helpers.js')).git(workspace, ['rev-parse', 'HEAD']);
        const session = { id: 51, backend_key: 'codebuddy', status: 'idle' };
        const socket = { on: () => socket, close: () => undefined };
        const kode = {
            createAnalysisSession: async (_backend, _cwd, prompt) => {
                const primaryPath = '.specops/changes/bug/plan-docs';
                const primaryFile = path.join(workspace, primaryPath, 'proposal.md');
                await mkdir(path.dirname(primaryFile), { recursive: true });
                await writeFile(primaryFile, [
                    '---',
                    'schema_version: 1',
                    'id: bug/plan-docs',
                    'kind: change',
                    'title: Plan docs commit',
                    'status: proposed',
                    'verifies: []',
                    'paths: [apps/gui/src]',
                    '---',
                    '',
                    '# Problem',
                    'Need to commit plan docs.',
                    '',
                ].join('\n'));
                const receiptMatch = /\.specops\/state\/intakes\/([0-9a-f-]+)\.json/.exec(prompt);
                const receiptId = receiptMatch?.[1] ?? '';
                const receipt = path.join(workspace, '.specops', 'state', 'intakes', `${receiptId}.json`);
                await mkdir(path.dirname(receipt), { recursive: true });
                await writeFile(receipt, `${JSON.stringify({
                    schema_version: 1,
                    intake_id: receiptId,
                    status: 'completed',
                    primary: primaryPath,
                    documents: [primaryPath],
                })}\n`);
                return session;
            },
            getSession: async () => session,
            subscribe: () => socket,
        };
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode });
        servers.push(server);
        await fetch(`${server.origin}/api/intakes`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ request: 'Plan docs commit test', backend_key: 'codebuddy' }),
        }));
        await (await fetch(`${server.origin}/api/intakes/51`, auth(server))).json();
        // The plan docs commit must have landed on the main workspace.
        const { git } = await import('./helpers.js');
        const log = await git(workspace, ['log', '--oneline', `${headBeforeDocs}..HEAD`]);
        expect(log).toMatch(/specops\(plan\): Plan docs commit/);
        // proposal.md is now in HEAD, so a worktree built from HEAD would see it.
        const blob = await git(workspace, ['show', `HEAD:.specops/changes/bug/plan-docs/proposal.md`]);
        expect(blob).toContain('kind: change');
    });
    // ── resume flow ──
    // The resume handler must (a) cover every active phase that owns a kode
    // session (not just run_in_worktree / analyze_request), (b) resume from the
    // codebuddy UUID stored on the matching agent rather than the numeric
    // kode_session_id, and (c) degrade gracefully when no UUID is available.
    function buildKodeMock(overrides = {}) {
        const calls = { createSession: [] };
        const socket = { on: () => socket, close: () => undefined };
        const defaultGetSession = async (id) => ({ id, backend_key: 'codebuddy', status: 'idle' });
        const defaultCreateSession = async (backendKey, cwd, _initialPrompt, resumeSessionUuid) => {
            calls.createSession.push({ backendKey, cwd, resumeSessionUuid });
            return { id: 9001, backend_key: backendKey, status: 'idle', session_uuid: 'new-uuid-9001' };
        };
        const kode = {
            getSession: overrides.getSession ?? defaultGetSession,
            createSession: overrides.createSession ?? defaultCreateSession,
            subscribe: () => socket,
            history: async () => ({ events: [], next_from: 0 }),
            killSession: async () => undefined,
        };
        return { kode, calls };
    }
    test('resume on a clarify phase re-attaches when the kode session is still alive', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const { kode } = buildKodeMock();
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode });
        servers.push(server);
        const specopsSession = await createSpecOpsSession(workspace, {
            title: 'Clarify resume',
            backend_key: 'codebuddy',
            kode_session_id: 55,
            phase: 'clarify',
            state: 'awaiting_user',
        });
        await attachSessionAgent(workspace, specopsSession.id, {
            kode_session_id: 55,
            session_uuid: 'clarify-uuid-55',
            backend_key: 'codebuddy',
            model: null,
            purpose: 'clarify',
            status: 'idle',
        });
        const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ kind: 'resume' }),
        }));
        expect(res.status).toBe(200);
        const body = await res.json();
        // Alive session is reused — kode_session_id stays 55, no new session created.
        expect(body.session.kode_session_id).toBe(55);
        expect(body.session.state).toBe('active');
    });
    test('resume on plan_discussion rebuilds using the agent UUID, not the numeric kode_session_id', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const planUuid = 'plan-uuid-aaaaaaaa';
        const { kode, calls } = buildKodeMock({
            // kode session already exited → handler must rebuild
            getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
        });
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode });
        servers.push(server);
        const specopsSession = await createSpecOpsSession(workspace, {
            title: 'Plan resume',
            backend_key: 'codebuddy',
            kode_session_id: 77,
            phase: 'plan_discussion',
            state: 'awaiting_user',
        });
        await attachSessionAgent(workspace, specopsSession.id, {
            kode_session_id: 77,
            session_uuid: planUuid,
            backend_key: 'codebuddy',
            model: null,
            purpose: 'plan',
            status: 'exited',
        });
        const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ kind: 'resume' }),
        }));
        expect(res.status).toBe(200);
        expect(calls.createSession).toHaveLength(1);
        // The UUID, not the numeric id (77), must be passed as resume_session_uuid.
        expect(calls.createSession[0]?.resumeSessionUuid).toBe(planUuid);
        // cwd for a plan-phase session is the workspace itself (no worktree).
        expect(await realpath(calls.createSession[0].cwd)).toBe(await realpath(workspace));
        const body = await res.json();
        expect(body.session.kode_session_id).toBe(9001);
        expect(body.session.agents.some((a) => a.purpose === 'repair' && a.session_uuid === 'new-uuid-9001')).toBe(true);
    });
    test('resume degrades to a fresh session when no agent UUID is available', async () => {
        const workspace = await gitWorkspace();
        cleanup.push(workspace);
        await initWorkspace(workspace);
        const { kode, calls } = buildKodeMock({
            getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
        });
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode });
        servers.push(server);
        const specopsSession = await createSpecOpsSession(workspace, {
            title: 'No uuid resume',
            backend_key: 'codebuddy',
            kode_session_id: 88,
            phase: 'analyze_request',
            state: 'awaiting_user',
        });
        // Agent predates the session_uuid field — null UUID, must not be passed as --resume.
        await attachSessionAgent(workspace, specopsSession.id, {
            kode_session_id: 88,
            session_uuid: null,
            backend_key: 'codebuddy',
            model: null,
            purpose: 'intake',
            status: 'exited',
        });
        const res = await fetch(`${server.origin}/api/sessions/${specopsSession.id}/action`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ kind: 'resume' }),
        }));
        expect(res.status).toBe(200);
        expect(calls.createSession).toHaveLength(1);
        expect(calls.createSession[0]?.resumeSessionUuid).toBeUndefined();
    });
    test('resume on run_in_worktree rebuilds inside the run worktree with the implement agent UUID', async () => {
        const workspace = await gitWorkspace();
        const cache = await mkdtemp(path.join(os.tmpdir(), 'specops-resume-cache-'));
        cleanup.push(workspace, cache);
        await initWorkspace(workspace);
        await gitCommit(workspace, 'Bootstrap\n\nBug: INIT-1');
        const implUuid = 'impl-uuid-bbbbbbbb';
        const { kode, calls } = buildKodeMock({
            getSession: async (id) => ({ id, backend_key: 'codebuddy', status: 'exited' }),
        });
        const server = await startServer({ workspace, token: 'test-token', kodeClient: kode, runCacheRoot: cache });
        servers.push(server);
        const created = await fetch(`${server.origin}/api/runs`, auth(server, {
            method: 'POST',
            body: JSON.stringify({
                backend_key: 'codebuddy',
                tasks: [{ id: 'task-1', title: 'Add result', prompt: 'Add result.txt', verify: [] }],
            }),
        }));
        const createdBody = await created.json();
        // Patch the implement agent with a real UUID so resume has something to use.
        await updateSpecOpsSession(workspace, createdBody.specops_session.id, (record) => {
            for (const agent of record.agents) {
                if (agent.purpose === 'implement')
                    agent.session_uuid = implUuid;
            }
        });
        const res = await fetch(`${server.origin}/api/sessions/${createdBody.specops_session.id}/action`, auth(server, {
            method: 'POST',
            body: JSON.stringify({ kind: 'resume' }),
        }));
        expect(res.status).toBe(200);
        // First createSession came from launchRun (no resume); the second is the resume rebuild.
        expect(calls.createSession).toHaveLength(2);
        expect(calls.createSession[0]?.resumeSessionUuid).toBeUndefined();
        expect(calls.createSession[1]?.resumeSessionUuid).toBe(implUuid);
        expect(await realpath(calls.createSession[1].cwd)).toBe(await realpath(createdBody.run.worktree_path));
        await cleanupRun(await readRun(workspace, createdBody.run.run_id));
    });
});
