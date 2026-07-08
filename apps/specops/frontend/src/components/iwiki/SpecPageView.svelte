<script lang="ts">
  import { onMount } from 'svelte';
  import { renderMarkdown } from '../../lib/markdown.ts';
  import { selectedTextContext } from '../../lib/stores/documents.ts';
  import { loadSessions, selectSession } from '../../lib/stores/sessions.ts';
  import { activeModule } from '../../lib/stores/layout.ts';
  import { api } from '../../lib/api.ts';
  import type { RegistryFile, SpecOpsSession } from '../../lib/types.ts';
  import Icon from '../shared/Icon.svelte';

  interface Props {
    source: string;
    path: string;
    title: string;
    status: string;
    session?: SpecOpsSession | null;
    files?: RegistryFile[];
  }

  interface SpecBlock {
    id: string;
    kind: 'markdown' | 'plan' | 'flow' | 'table' | 'task_list' | 'test_matrix';
    title: string;
    body: string;
    lineStart: number;
    lineEnd: number;
    status: 'draft' | 'active' | 'waiting' | 'applied';
  }

  interface SelectionState {
    blockId: string;
    blockKind: string;
    quote: string;
    lineStart: number | null;
    lineEnd: number | null;
  }

  interface ActivityItem {
    id: string;
    kind: 'note' | 'ask' | 'patch';
    title: string;
    body: string;
    blockId: string;
  }

  interface LaunchTask {
    id: string;
    title: string;
    prompt: string;
    verify: string[];
  }

  let { source, path, title, status, session = null, files = [] }: Props = $props();

  let hostEl: HTMLElement | null = $state(null);
  let contextMenu = $state<{ x: number; y: number } | null>(null);
  let selection = $state<SelectionState | null>(null);
  let composerMode = $state<'ask' | 'change' | 'note' | null>(null);
  let composerText = $state('');
  let actionText = $state('');
  let actionBusy = $state(false);
  let actionError = $state<string | null>(null);
  let tasksSource = $state<string | null>(null);
  let tasksLoading = $state(false);
  let pendingPatch = $state<{ blockId: string; preview: string } | null>(null);
  let appliedBlockId = $state<string | null>(null);
  let overrides = $state<Record<string, string>>({});
  let activity = $state<ActivityItem[]>([]);

  const workflow = [
    { label: 'Intake', state: 'done' },
    { label: 'Plan', state: 'active' },
    { label: 'Build', state: 'waiting' },
    { label: 'Verify', state: 'waiting' },
    { label: 'Apply', state: 'waiting' },
  ];

  let blocks = $derived(buildBlocks(source, overrides));
  let planBlocks = $derived(blocks.filter((block) => block.kind === 'plan' || block.kind === 'flow').slice(0, 3));
  let taskBlocks = $derived(blocks.filter((block) => block.kind === 'task_list').slice(0, 4));
  let testBlocks = $derived(blocks.filter((block) => block.kind === 'test_matrix').slice(0, 4));
  let requiredAction = $derived(session?.required_action ?? null);
  let nextStep = $derived(describeNextStep(session));
  let launchTasks = $derived(buildLaunchTasks(tasksSource ?? source, title, path));
  let canLaunchRun = $derived(session !== null && requiredAction?.kind === 'run_in_worktree');
  let canLaunchStandalone = $derived(session === null && status === 'proposed' && path.replace(/\/+$/, '').startsWith('.specops/changes/'));

  $effect(() => {
    const taskPath = taskDocumentPath(path, files);
    if (taskPath === null) {
      tasksSource = null;
      return;
    }
    void loadTasks(taskPath);
  });

  function blockKind(titleText: string, body: string): SpecBlock['kind'] {
    const text = `${titleText}\n${body}`.toLowerCase();
    if (/\|.+\|/.test(body)) return text.includes('test') || text.includes('测试') || text.includes('验证') ? 'test_matrix' : 'table';
    if (/^\s*[-*]\s+\[[ x]\]/m.test(body)) return 'task_list';
    if (text.includes('plan') || text.includes('计划') || text.includes('方案')) return 'plan';
    if (text.includes('flow') || text.includes('流程') || text.includes('workflow')) return 'flow';
    return 'markdown';
  }

  function blockStatus(kind: SpecBlock['kind'], index: number): SpecBlock['status'] {
    if (kind === 'plan' || kind === 'flow') return 'active';
    if (kind === 'task_list' || kind === 'test_matrix') return index < 3 ? 'waiting' : 'draft';
    return 'draft';
  }

  function buildBlocks(markdown: string, custom: Record<string, string>): SpecBlock[] {
    const lines = markdown.replaceAll('\r\n', '\n').split('\n');
    const starts: number[] = [];
    lines.forEach((line, index) => {
      if (/^#{1,3}\s+\S/.test(line)) starts.push(index);
    });
    if (starts.length === 0) starts.push(0);

    return starts.map((start, index) => {
      const end = (starts[index + 1] ?? lines.length) - 1;
      const section = lines.slice(start, end + 1);
      const heading = section[0]?.match(/^#{1,3}\s+(.*)$/)?.[1]?.trim() ?? (index === 0 ? 'Overview' : `Section ${index + 1}`);
      const body = section.join('\n').trim();
      const id = `block-${index}-${slug(heading)}`;
      const renderedBody = custom[id] ?? body;
      const kind = blockKind(heading, renderedBody);
      return {
        id,
        kind,
        title: heading,
        body: renderedBody,
        lineStart: start + 1,
        lineEnd: end + 1,
        status: custom[id] ? 'applied' : blockStatus(kind, index),
      };
    });
  }

  function taskDocumentPath(docPath: string, relatedFiles: RegistryFile[]): string | null {
    const explicit = relatedFiles.find((file) => file.name === 'tasks.md')?.path;
    if (explicit !== undefined) return explicit;
    const base = docPath.replace(/\/+$/, '').replace(/\/(?:proposal|design|tasks)\.md$/, '');
    if (base.includes('/changes/')) return `${base}/tasks.md`;
    return null;
  }

  async function loadTasks(taskPath: string): Promise<void> {
    tasksLoading = true;
    try {
      const res = await api.get<{ content: string }>(`/api/document?path=${encodeURIComponent(taskPath)}`);
      tasksSource = res.content;
    } catch {
      tasksSource = null;
    } finally {
      tasksLoading = false;
    }
  }

  function buildLaunchTasks(markdown: string, docTitle: string, docPath: string): LaunchTask[] {
    const tasks: LaunchTask[] = [];
    const lines = markdown.replaceAll('\r\n', '\n').split('\n');
    for (const line of lines) {
      const match = /^\s*[-*]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
      if (match === null) continue;
      const rawTitle = (match[1] ?? '').replace(/`/g, '').trim();
      if (rawTitle.length < 4) continue;
      if (/^(scope|out of scope|notes?|验收|测试|风险)[:：]?$/i.test(rawTitle)) continue;
      const id = `task-${tasks.length + 1}`;
      tasks.push({
        id,
        title: rawTitle.slice(0, 120),
        prompt: [
          `Implement task: ${rawTitle}`,
          '',
          `SpecOps document: ${docPath}`,
          '',
          'Follow the proposal/design/tasks documents in this change folder. Keep changes scoped to the requested task and update tests when needed.',
        ].join('\n'),
        verify: [],
      });
      if (tasks.length >= 8) break;
    }
    if (tasks.length > 0) return tasks;
    return [{
      id: 'task-1',
      title: `Implement ${docTitle}`,
      prompt: [
        `Implement the SpecOps change: ${docTitle}`,
        '',
        `SpecOps document: ${docPath}`,
        '',
        markdown.slice(0, 4000),
      ].join('\n'),
      verify: [],
    }];
  }

  function slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 36) || 'section';
  }

  function updateSelection(): void {
    const raw = window.getSelection();
    const quote = raw?.toString().trim() ?? '';
    const anchor = raw?.anchorNode;
    if (!quote || !anchor || !hostEl?.contains(anchor)) {
      selection = null;
      selectedTextContext.set(null);
      return;
    }
    const blockEl = anchor.parentElement?.closest<HTMLElement>('[data-spec-block-id]');
    const blockId = blockEl?.dataset.specBlockId ?? '';
    const block = blocks.find((item) => item.id === blockId);
    if (block === undefined) return;
    const localIndex = block.body.indexOf(quote);
    const lineStart = localIndex < 0 ? block.lineStart : block.lineStart + block.body.slice(0, localIndex).split(/\r?\n/).length - 1;
    const lineEnd = localIndex < 0 ? block.lineEnd : lineStart + quote.split(/\r?\n/).length - 1;
    selection = { blockId, blockKind: block.kind, quote, lineStart, lineEnd };
    selectedTextContext.set({
      path,
      text: quote,
      lineStart,
      lineEnd,
      blockId,
      blockKind: block.kind,
    });
  }

  function openContextMenu(event: MouseEvent): void {
    updateSelection();
    if (selection === null) return;
    event.preventDefault();
    contextMenu = { x: event.clientX, y: event.clientY };
  }

  function start(mode: 'ask' | 'change' | 'note'): void {
    composerMode = mode;
    contextMenu = null;
    composerText = mode === 'change' ? '把这段改得更可执行，并补充验收状态。' : '';
  }

  function submitComposer(): void {
    if (selection === null || composerMode === null) return;
    const target = blocks.find((block) => block.id === selection?.blockId);
    if (target === undefined) return;
    const request = composerText.trim();
    const titleText = composerMode === 'ask'
      ? 'Agent question'
      : composerMode === 'change'
        ? 'Generated change'
        : 'Note';
    activity = [
      {
        id: `${Date.now()}`,
        kind: composerMode === 'change' ? 'patch' : composerMode,
        title: titleText,
        body: request.length > 0 ? request : selection.quote,
        blockId: target.id,
      },
      ...activity,
    ];
    if (composerMode === 'change') {
      pendingPatch = {
        blockId: target.id,
        preview: `${target.body.trim()}\n\n> SpecOps draft update: ${request || 'Applied selected context into this section.'}`,
      };
    }
    composerMode = null;
    composerText = '';
  }

  function applyPatch(): void {
    if (pendingPatch === null) return;
    overrides = { ...overrides, [pendingPatch.blockId]: pendingPatch.preview };
    appliedBlockId = pendingPatch.blockId;
    activity = [
      {
        id: `${Date.now()}-applied`,
        kind: 'patch',
        title: 'Applied to live HTML',
        body: 'The selected block was regenerated in place. Persistence comes in the next server-backed pass.',
        blockId: pendingPatch.blockId,
      },
      ...activity,
    ];
    pendingPatch = null;
    window.setTimeout(() => {
      appliedBlockId = null;
    }, 900);
  }

  function cancelComposer(): void {
    composerMode = null;
    composerText = '';
  }

  function closeMenus(): void {
    contextMenu = null;
  }

  async function answerRequiredAction(optionIndex: number, label: string, freeText?: string): Promise<void> {
    if (session === null || requiredAction?.kind !== 'answer') return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${session.id}/answer`, {
        question_id: requiredAction.question_id ?? '',
        choice_index: optionIndex,
        label,
        ...(freeText ? { free_text: freeText } : {}),
      });
      actionText = '';
      await loadSessions();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  }

  async function respondPlan(accept: boolean): Promise<void> {
    if (session === null || requiredAction?.kind !== 'plan_review') return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${session.id}/plan_response`, {
        plan_id: requiredAction.plan_id ?? '',
        accept,
        ...(actionText.trim() ? { note: actionText.trim() } : {}),
      });
      actionText = '';
      await loadSessions();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  }

  async function launchRun(): Promise<void> {
    actionBusy = true;
    actionError = null;
    try {
      if (session !== null) {
        await api.post(`/api/sessions/${session.id}/action`, {
          kind: 'run_in_worktree',
          tasks: launchTasks,
          backend_key: session.backend_key ?? 'codebuddy',
          document_path: path,
        });
        await loadSessions();
        await selectSession(session.id);
      } else {
        const res = await api.post<{ specops_session?: { id: string } }>('/api/runs', {
          tasks: launchTasks,
          backend_key: 'codebuddy',
          document_path: path,
        });
        await loadSessions();
        if (res.specops_session?.id) await selectSession(res.specops_session.id);
      }
      await loadSessions();
      activeModule.set('chat');
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  }

  async function runSessionAction(kind: string, note?: string): Promise<void> {
    if (session === null) return;
    actionBusy = true;
    actionError = null;
    try {
      await api.post(`/api/sessions/${session.id}/action`, {
        kind,
        ...(note && note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      actionText = '';
      await loadSessions();
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      actionBusy = false;
    }
  }

  async function openSession(): Promise<void> {
    if (session === null) return;
    await selectSession(session.id);
    activeModule.set('chat');
  }

  function describeNextStep(current: SpecOpsSession | null): string {
    if (current === null) return 'No live SpecOps session is attached to this document yet.';
    const action = current.required_action;
    if (action?.kind === 'answer') return 'Choose an answer here; SpecOps will send it back to the agent and continue the same workflow.';
    if (action?.kind === 'plan_review') return 'Review the plan here. Approving it moves the workflow into document generation or implementation.';
    if (action?.kind === 'run_in_worktree') return 'Launch the generated tasks into an isolated worktree. SpecOps will track implementation, verify, review, and apply from this same session.';
    if (action?.kind === 'verify') return 'Run verification before accepting the patch.';
    if (action?.kind === 'review') return 'Review the generated patch, then accept, reject, or request feedback.';
    if (action?.kind === 'apply_patch') return 'Apply the accepted patch back to the main workspace.';
    const phase = current.phase ?? '';
    if (phase === 'plan_approved') return 'The agent is generating canonical SpecOps documents. New proposal/tasks/design files will appear after the receipt is written.';
    if (phase === 'run_in_worktree') return 'Implementation is running in an isolated worktree. Watch progress or open the chat session for details.';
    if (phase === 'verify') return 'Implementation finished; verification is the next gate.';
    if (phase === 'review') return 'Verification finished; review the patch and decide what to do next.';
    if (current.state === 'awaiting_user') return 'The workflow is waiting for your decision.';
    return 'The workflow is active. New questions, plans, and review gates will appear here when the agent reaches them.';
  }

  onMount(() => {
    document.addEventListener('selectionchange', updateSelection);
    document.addEventListener('click', closeMenus);
    return () => {
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('click', closeMenus);
    };
  });
</script>

<div class="specpage" role="document" bind:this={hostEl} oncontextmenu={openContextMenu}>
  <header class="page-head">
    <div>
      <p class="eyebrow">{path}</p>
      <h1>{title}</h1>
    </div>
    <span class="status">{status}</span>
  </header>

  <section class="state-strip" aria-label="workflow state">
    {#each workflow as step}
      <span class="step" data-state={step.state}>
        <span class="dot"></span>
        {step.label}
      </span>
    {/each}
  </section>

  <section class="trackers">
    <div class="tracker">
      <span class="tracker-label">Plan</span>
      <strong>{planBlocks.length || 1}</strong>
      <span>active block{planBlocks.length === 1 ? '' : 's'}</span>
    </div>
    <div class="tracker">
      <span class="tracker-label">Tasks</span>
      <strong>{taskBlocks.length}</strong>
      <span>tracked list{taskBlocks.length === 1 ? '' : 's'}</span>
    </div>
    <div class="tracker">
      <span class="tracker-label">Tests</span>
      <strong>{testBlocks.length}</strong>
      <span>status table{testBlocks.length === 1 ? '' : 's'}</span>
    </div>
  </section>

  <section class="workflow-card" data-state={session?.state ?? 'none'}>
    <div class="workflow-copy">
      <span class="workflow-label">{requiredAction === null ? 'Next step' : 'Action required'}</span>
      <p>{nextStep}</p>
    </div>
    {#if session !== null}
      <button type="button" class="ghost" onclick={openSession}>Open session</button>
    {/if}
  </section>

  {#if requiredAction !== null}
    <section class="required-action" data-kind={requiredAction.kind}>
      {#if requiredAction.kind === 'answer'}
        <div class="action-head">
          <span>{requiredAction.header ?? 'Question'}</span>
          <strong>Choose one response</strong>
        </div>
        <p class="action-prompt">{requiredAction.prompt}</p>
        {#if requiredAction.options?.length}
          <div class="action-options">
            {#each requiredAction.options as option, index (option.label)}
              <button
                type="button"
                class="choice"
                disabled={actionBusy}
                onclick={() => answerRequiredAction(index, option.label)}
              >
                <span>{option.label}</span>
                {#if option.description}
                  <small>{option.description}</small>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
        <div class="reply-row">
          <textarea bind:value={actionText} placeholder="Reply with additional context"></textarea>
          <button
            type="button"
            class="apply"
            disabled={actionBusy || actionText.trim().length === 0}
            onclick={() => answerRequiredAction(requiredAction.options?.length ?? 0, actionText.trim(), actionText.trim())}
          >
            Reply
          </button>
        </div>
      {:else if requiredAction.kind === 'plan_review'}
        <div class="action-head">
          <span>Plan review</span>
          <strong>Approve or request changes</strong>
        </div>
        {#if requiredAction.markdown}
          <div class="plan-markdown">{@html renderMarkdown(requiredAction.markdown).html}</div>
        {:else}
          <p class="action-prompt">The agent has proposed a plan. Review it in the session, then decide here.</p>
        {/if}
        <textarea bind:value={actionText} placeholder="Optional note for revision"></textarea>
        <div class="plan-actions">
          <button type="button" class="apply" disabled={actionBusy} onclick={() => respondPlan(true)}>Approve plan</button>
          <button type="button" class="danger" disabled={actionBusy} onclick={() => respondPlan(false)}>Revise</button>
        </div>
      {:else if requiredAction.kind === 'run_in_worktree'}
        <div class="action-head">
          <span>Launch run</span>
          <strong>{launchTasks.length} task{launchTasks.length === 1 ? '' : 's'} ready</strong>
        </div>
        <p class="action-prompt">{nextStep}</p>
        {#if tasksLoading}
          <p class="action-muted">Loading tasks.md…</p>
        {/if}
        <ol class="launch-tasks">
          {#each launchTasks as task (task.id)}
            <li>
              <span>{task.title}</span>
              {#if task.verify.length > 0}
                <small>{task.verify.length} verify command{task.verify.length === 1 ? '' : 's'}</small>
              {:else}
                <small>Verify commands can be added after launch.</small>
              {/if}
            </li>
          {/each}
        </ol>
        <div class="plan-actions">
          <button type="button" class="apply" disabled={actionBusy || !canLaunchRun} onclick={launchRun}>Launch Run</button>
          <button type="button" class="ghost" onclick={openSession}>Open session</button>
        </div>
      {:else if requiredAction.kind === 'verify'}
        <div class="action-head">
          <span>Verify</span>
          <strong>Run checks</strong>
        </div>
        <p class="action-prompt">{nextStep}</p>
        <div class="plan-actions">
          <button type="button" class="apply" disabled={actionBusy} onclick={() => runSessionAction('verify')}>Run verify</button>
          <button type="button" class="ghost" onclick={openSession}>Open session</button>
        </div>
      {:else if requiredAction.kind === 'review'}
        <div class="action-head">
          <span>Review patch</span>
          <strong>{requiredAction.patch_files?.length ?? 0} file{requiredAction.patch_files?.length === 1 ? '' : 's'} changed</strong>
        </div>
        {#if requiredAction.review_note}
          <p class="review-note">{requiredAction.review_note}</p>
        {:else}
          <p class="action-prompt">{nextStep}</p>
        {/if}
        {#if requiredAction.patch_files?.length}
          <ol class="changed-files">
            {#each requiredAction.patch_files as file (file)}
              <li>{file}</li>
            {/each}
          </ol>
        {/if}
        <textarea bind:value={actionText} placeholder="Feedback for the agent"></textarea>
        <div class="plan-actions">
          <button type="button" class="apply" disabled={actionBusy} onclick={() => runSessionAction('accept')}>Accept task</button>
          <button type="button" class="ghost" disabled={actionBusy || actionText.trim().length === 0} onclick={() => runSessionAction('feedback', actionText)}>Request changes</button>
          <button type="button" class="danger" disabled={actionBusy} onclick={() => runSessionAction('reject', actionText)}>Reject run</button>
        </div>
      {:else if requiredAction.kind === 'apply_patch'}
        <div class="action-head">
          <span>Apply patch</span>
          <strong>Ready to merge</strong>
        </div>
        <p class="action-prompt">{nextStep}</p>
        <div class="plan-actions">
          <button type="button" class="apply" disabled={actionBusy} onclick={() => runSessionAction('apply_with_verify')}>Apply with verify</button>
          <button type="button" class="ghost" disabled={actionBusy} onclick={() => runSessionAction('apply')}>Apply only</button>
          <button type="button" class="danger" disabled={actionBusy} onclick={() => runSessionAction('rollback')}>Rollback</button>
        </div>
      {:else}
        <div class="action-head">
          <span>Action required</span>
          <strong>{requiredAction.kind}</strong>
        </div>
        <p class="action-prompt">{nextStep}</p>
      {/if}
      {#if actionError !== null}
        <p class="action-error">{actionError}</p>
      {/if}
    </section>
  {:else if canLaunchStandalone}
    <section class="required-action" data-kind="run_in_worktree">
      <div class="action-head">
        <span>Launch run</span>
        <strong>{launchTasks.length} task{launchTasks.length === 1 ? '' : 's'} ready</strong>
      </div>
      <p class="action-prompt">This proposed change has no live SpecOps session attached. Launching will create one and run the tasks in an isolated worktree.</p>
      {#if tasksLoading}
        <p class="action-muted">Loading tasks.md…</p>
      {/if}
      <ol class="launch-tasks">
        {#each launchTasks as task (task.id)}
          <li>
            <span>{task.title}</span>
            {#if task.verify.length > 0}
              <small>{task.verify.length} verify command{task.verify.length === 1 ? '' : 's'}</small>
            {:else}
              <small>Verify commands can be added after launch.</small>
            {/if}
          </li>
        {/each}
      </ol>
      <div class="plan-actions">
        <button type="button" class="apply" disabled={actionBusy} onclick={launchRun}>Launch Run</button>
      </div>
      {#if actionError !== null}
        <p class="action-error">{actionError}</p>
      {/if}
    </section>
  {/if}

  {#if pendingPatch !== null}
    <aside class="patch-bar">
      <div>
        <span class="patch-title">Generated update</span>
        <p>Ready to apply to the selected HTML block.</p>
      </div>
      <button type="button" class="ghost" onclick={() => (pendingPatch = null)}>Discard</button>
      <button type="button" class="apply" onclick={applyPatch}>Apply</button>
    </aside>
  {/if}

  <div class="body-grid">
    <article class="blocks">
      {#each blocks as block (block.id)}
        <section
          class="spec-block"
          class:applied={appliedBlockId === block.id}
          data-kind={block.kind}
          data-status={block.status}
          data-spec-block-id={block.id}
        >
          <div class="block-meta">
            <span>{block.kind.replace('_', ' ')}</span>
            <span>L{block.lineStart}-L{block.lineEnd}</span>
          </div>
          <div class="markdown">{@html renderMarkdown(block.body).html}</div>
        </section>
      {/each}
    </article>

    <aside class="activity">
      <header>
        <span>Discussion</span>
        <small>{activity.length}</small>
      </header>
      {#if selection !== null}
        <div class="selection-card">
          <span>{selection.blockKind.replace('_', ' ')}</span>
          <p>{selection.quote}</p>
        </div>
      {/if}
      {#if composerMode !== null}
        <div class="composer">
          <span>{composerMode === 'ask' ? 'Ask agent' : composerMode === 'change' ? 'Request change' : 'Add note'}</span>
          <textarea bind:value={composerText} placeholder="Write the prompt or note"></textarea>
          <div class="composer-actions">
            <button type="button" class="ghost" onclick={cancelComposer}>Cancel</button>
            <button type="button" class="apply" onclick={submitComposer}>Send</button>
          </div>
        </div>
      {/if}
      {#if activity.length === 0}
        <p class="empty">Select content or right-click a block to start a document-scoped exchange.</p>
      {:else}
        <ol>
          {#each activity as item (item.id)}
            <li>
              <span>{item.title}</span>
              <p>{item.body}</p>
            </li>
          {/each}
        </ol>
      {/if}
    </aside>
  </div>

  {#if contextMenu !== null && selection !== null}
    <div class="context-menu" role="menu" style={`left: ${contextMenu.x}px; top: ${contextMenu.y}px;`}>
      <button type="button" onclick={() => start('ask')}><Icon name="message-circle" size={14} />Ask agent</button>
      <button type="button" onclick={() => start('change')}><Icon name="wand-sparkles" size={14} />Request change</button>
      <button type="button" onclick={() => start('note')}><Icon name="sticky-note" size={14} />Add note</button>
    </div>
  {/if}
</div>

<style>
  .specpage {
    max-width: 1180px;
    margin: 0 auto;
    padding: var(--sp-4) var(--sp-5) var(--sp-6);
  }
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-4);
    padding-bottom: var(--sp-3);
    border-bottom: 1px solid var(--bd-muted);
  }
  .eyebrow {
    margin: 0 0 var(--sp-1);
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  h1 {
    margin: 0;
    font-size: 22px;
    font-weight: var(--fw-semi);
    letter-spacing: 0;
  }
  .status,
  .step,
  .tracker-label,
  .block-meta span,
  .selection-card span,
  .composer span,
  .activity header span,
  .activity li span,
  .patch-title {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .status {
    padding: 3px var(--sp-2);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    color: var(--fg-secondary);
  }
  .state-strip {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: var(--sp-3) 0;
  }
  .step {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-tertiary);
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--bd-strong);
  }
  .step[data-state='done'] .dot {
    background: var(--st-ok);
  }
  .step[data-state='active'] {
    color: var(--fg-primary);
  }
  .step[data-state='active'] .dot {
    background: var(--st-info);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--st-info) 16%, transparent);
  }
  .trackers {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
  }
  .workflow-card,
  .required-action {
    margin-bottom: var(--sp-3);
    border-radius: var(--rad-lg);
    animation: action-in var(--t-base) cubic-bezier(0.2, 0, 0, 1) both;
  }
  @keyframes action-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
  .workflow-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-3);
    padding: var(--sp-3);
    border: 1px solid var(--bd-muted);
    background: var(--bg-status);
  }
  .workflow-card[data-state='awaiting_user'] {
    border-color: color-mix(in srgb, var(--st-warn) 42%, var(--bd-default));
    background: color-mix(in srgb, var(--st-warn) 9%, var(--bg-status));
  }
  .workflow-copy {
    min-width: 0;
  }
  .workflow-label,
  .action-head span {
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fg-tertiary);
  }
  .workflow-copy p {
    margin: var(--sp-1) 0 0;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  .required-action {
    padding: var(--sp-3);
    border: 1px solid color-mix(in srgb, var(--st-info) 36%, var(--bd-default));
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--st-info) 9%, transparent), transparent 28%),
      var(--bg-elevated);
    box-shadow: var(--sh-md);
  }
  .required-action[data-kind='answer'] {
    border-color: color-mix(in srgb, var(--st-warn) 42%, var(--bd-default));
    background:
      linear-gradient(90deg, color-mix(in srgb, var(--st-warn) 10%, transparent), transparent 30%),
      var(--bg-elevated);
  }
  .action-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-3);
    margin-bottom: var(--sp-2);
  }
  .action-head strong {
    color: var(--fg-primary);
    font-size: var(--fs-sm);
  }
  .action-prompt {
    margin: 0 0 var(--sp-2);
    color: var(--fg-primary);
    line-height: 1.5;
  }
  .action-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--sp-2);
    margin-bottom: var(--sp-2);
  }
  .choice {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-height: 58px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-base);
    text-align: left;
    transition:
      border-color var(--t-fast),
      background var(--t-fast),
      transform var(--t-fast);
  }
  .choice:hover:not(:disabled) {
    border-color: var(--acc);
    background: var(--bg-selected);
    transform: translateY(-1px);
  }
  .choice span {
    color: var(--fg-primary);
    font-weight: var(--fw-med);
  }
  .choice small {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
    line-height: 1.35;
  }
  .required-action textarea {
    width: 100%;
    min-height: 74px;
    resize: vertical;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: var(--sp-2);
    background: var(--bg-input);
    color: var(--fg-primary);
    font-family: inherit;
    font-size: var(--fs-sm);
  }
  .reply-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: end;
    gap: var(--sp-2);
  }
  .plan-markdown {
    max-height: 360px;
    overflow: auto;
    margin-bottom: var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-base);
  }
  .plan-markdown :global(h1),
  .plan-markdown :global(h2),
  .plan-markdown :global(h3) {
    margin: var(--sp-2) 0 var(--sp-1);
    font-size: var(--fs-md);
  }
  .plan-markdown :global(p),
  .plan-markdown :global(li) {
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .plan-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .action-muted {
    margin: var(--sp-1) 0 var(--sp-2);
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
  .launch-tasks {
    list-style: none;
    margin: 0 0 var(--sp-3);
    padding: 0;
    display: grid;
    gap: var(--sp-2);
  }
  .launch-tasks li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-2) var(--sp-3);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-base);
  }
  .launch-tasks span {
    color: var(--fg-primary);
    font-weight: var(--fw-med);
  }
  .launch-tasks small {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .review-note {
    margin: 0 0 var(--sp-2);
    padding: var(--sp-2);
    border-left: 3px solid var(--st-warn);
    border-radius: var(--rad-sm);
    background: color-mix(in srgb, var(--st-warn) 8%, transparent);
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    line-height: 1.5;
  }
  .changed-files {
    list-style: none;
    margin: 0 0 var(--sp-2);
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-1);
  }
  .changed-files li {
    padding: 3px var(--sp-2);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-sm);
    background: var(--bg-base);
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
  }
  .danger {
    border-radius: var(--rad-sm);
    border: 1px solid color-mix(in srgb, var(--st-err) 30%, var(--bd-default));
    padding: 5px var(--sp-2);
    background: color-mix(in srgb, var(--st-err) 10%, transparent);
    color: var(--st-err);
  }
  .danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--st-err) 18%, transparent);
  }
  .action-error {
    margin: var(--sp-2) 0 0;
    color: var(--st-err);
    font-size: var(--fs-sm);
  }
  .tracker {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 1px var(--sp-2);
    padding: var(--sp-2);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-status);
  }
  .tracker strong {
    grid-row: span 2;
    font-size: 24px;
    line-height: 1;
  }
  .tracker span:last-child {
    color: var(--fg-tertiary);
    font-size: var(--fs-xs);
  }
  .patch-bar {
    position: sticky;
    top: var(--sp-2);
    z-index: 4;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    margin-bottom: var(--sp-3);
    padding: var(--sp-2);
    border: 1px solid color-mix(in srgb, var(--acc) 44%, var(--bd-default));
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--bg-elevated) 88%, var(--acc-soft));
    box-shadow: var(--sh-md);
  }
  .patch-bar div {
    flex: 1;
  }
  .patch-bar p {
    margin: 2px 0 0;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
  }
  .body-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 280px;
    gap: var(--sp-4);
    align-items: start;
  }
  .blocks {
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
    min-width: 0;
  }
  .spec-block {
    position: relative;
    padding: var(--sp-3);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-lg);
    background: var(--bg-elevated);
    transition:
      border-color var(--t-base),
      background var(--t-base),
      transform var(--t-base);
  }
  .spec-block:hover {
    border-color: var(--bd-strong);
  }
  .spec-block[data-kind='plan'],
  .spec-block[data-kind='flow'] {
    border-left: 3px solid var(--st-info);
  }
  .spec-block[data-kind='task_list'] {
    border-left: 3px solid var(--st-busy);
  }
  .spec-block[data-kind='test_matrix'] {
    border-left: 3px solid var(--st-ok);
  }
  .spec-block.applied {
    animation: apply-flash 900ms cubic-bezier(0.2, 0, 0, 1);
  }
  @keyframes apply-flash {
    0% {
      transform: translateY(-2px);
      background: color-mix(in srgb, var(--acc-soft) 42%, var(--bg-elevated));
      border-color: var(--acc);
    }
    100% {
      transform: translateY(0);
      background: var(--bg-elevated);
    }
  }
  .block-meta {
    display: flex;
    justify-content: space-between;
    gap: var(--sp-2);
    color: var(--fg-tertiary);
    margin-bottom: var(--sp-2);
  }
  .markdown :global(h1),
  .markdown :global(h2),
  .markdown :global(h3) {
    margin: 0 0 var(--sp-2);
    font-size: var(--fs-lg);
    letter-spacing: 0;
  }
  .markdown :global(p) {
    margin: var(--sp-2) 0;
    line-height: 1.55;
  }
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: var(--sp-2) 0;
    padding-left: var(--sp-4);
  }
  .markdown :global(li) {
    margin: var(--sp-1) 0;
  }
  .markdown :global(code) {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    background: var(--bg-pre);
    padding: 1px var(--sp-1);
    border-radius: var(--rad-sm);
  }
  .markdown :global(pre) {
    overflow-x: auto;
    padding: var(--sp-3);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-pre);
  }
  .markdown :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: var(--sp-3) 0;
    font-size: var(--fs-sm);
  }
  .markdown :global(th),
  .markdown :global(td) {
    border: 1px solid var(--bd-default);
    padding: var(--sp-1) var(--sp-2);
    text-align: left;
    vertical-align: top;
  }
  .markdown :global(blockquote) {
    margin: var(--sp-3) 0;
    padding: var(--sp-2) var(--sp-3);
    border-left: 3px solid var(--acc);
    background: var(--bg-selected);
    color: var(--fg-secondary);
  }
  .activity {
    position: sticky;
    top: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    max-height: calc(100vh - 180px);
    overflow: auto;
    padding: var(--sp-2);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-lg);
    background: var(--bg-sidebar);
  }
  .activity header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--fg-tertiary);
  }
  .selection-card,
  .composer,
  .activity li {
    padding: var(--sp-2);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
  }
  .selection-card p,
  .activity li p,
  .empty {
    margin: var(--sp-1) 0 0;
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  .selection-card p {
    display: -webkit-box;
    overflow: hidden;
    line-clamp: 4;
    -webkit-line-clamp: 4;
    -webkit-box-orient: vertical;
  }
  .composer textarea {
    width: 100%;
    min-height: 76px;
    margin-top: var(--sp-2);
    resize: vertical;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    padding: var(--sp-2);
    background: var(--bg-input);
    color: var(--fg-primary);
    font-family: inherit;
    font-size: var(--fs-sm);
  }
  .composer-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-2);
    margin-top: var(--sp-2);
  }
  .activity ol {
    display: flex;
    flex-direction: column;
    gap: var(--sp-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .ghost,
  .apply {
    border-radius: var(--rad-sm);
    border: 1px solid var(--bd-default);
    padding: 5px var(--sp-2);
    background: transparent;
  }
  .ghost:hover {
    background: var(--bg-hover);
  }
  .apply {
    border-color: var(--acc);
    background: var(--acc);
    color: var(--fg-on-accent);
  }
  .context-menu {
    position: fixed;
    z-index: 30;
    display: flex;
    flex-direction: column;
    min-width: 170px;
    padding: var(--sp-1);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-elevated);
    box-shadow: var(--sh-lg);
  }
  .context-menu button {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    width: 100%;
    border: 0;
    border-radius: var(--rad-sm);
    padding: var(--sp-2);
    background: transparent;
    text-align: left;
  }
  .context-menu button:hover {
    background: var(--bg-hover);
  }
  @media (max-width: 920px) {
    .body-grid,
    .trackers {
      grid-template-columns: 1fr;
    }
    .activity {
      position: static;
      max-height: none;
    }
  }
</style>
