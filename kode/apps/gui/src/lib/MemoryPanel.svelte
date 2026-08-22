<script lang="ts">
  /**
   * MemoryPanel.svelte —— M4:GUI 集成 memory review queue。
   *
   * 触发:Cmd+Shift+M(App.svelte 监听)。模态层右侧滑出大面板,
   * 列出 ~/.kode-memory(或 KODE_MEMORY_ROOT)的 pending propose,
   * 每条提供 Approve / Edit Then Approve / Reject / Blacklist 四个动作,
   * 联动 budget。
   *
   * 设计:
   * - 不做悬停态预览,review 这种"看完再决定"的流程,选中项**展开内嵌编辑**
   *   就能改 body / tags / scope / confidence 后 approve(edit_then_approve)。
   * - 动作走 invoke,review 完直接乐观从列表移除当前条目,后端 emit
   *   `memory-pending` 事件更新计数 badge(在 App.svelte 里)。
   * - 队列空时显示空态;打不开 memory 子系统时显示错误。
   */
  import { onMount, onDestroy } from 'svelte'
  import {
    endpointIpc,
    memoryIpc,
    type EndpointSummary,
    type MemoryOrigin,
    type MemoryPending,
    type MemoryVerdict,
    type MemoryStats,
  } from './ipc'
  import Icon, { type IconName } from './Icon.svelte'
  import RelatedFactPicker from './RelatedFactPicker.svelte'
  import SelectionCheckbox from './SelectionCheckbox.svelte'
  import { formatLocalDateTimeFull, formatLocalDateTimeShort } from './time'
  import { t } from './i18n'
  import { outsidePressClose } from './outside_close'
  import { pushToast } from './toast'

  type Props = {
    onClose: () => void
  }
  let { onClose }: Props = $props()

  /// 单来源拉取失败的局部错误 —— 失败隔离:某个远端不可达不整体清空,
  /// 只在列表上方挂一条「Remote X unavailable」提示。
  type SourceError = { origin: MemoryOrigin; label: string; detail: string }

  let pending: MemoryPending[] = $state([])
  let stats: MemoryStats | null = $state(null)
  let endpoints: EndpointSummary[] = $state([])
  /// 各来源的局部错误(本地 + 每个远端各一条)。
  let sourceErrors: SourceError[] = $state([])
  let loading = $state(true)
  /// 仅当**完全没有任何来源可用**(本地失败且没有远端)时才算 bootError。
  let bootError: string | null = $state(null)
  /** 右侧详情当前聚焦项；包含来源，避免本地/远端出现相同 ULID 时选错。 */
  let selectedKey: string | null = $state(null)
  /** 批量审核勾选项；与详情聚焦互相独立。 */
  let checkedKeys = $state<Set<string>>(new Set())
  let batchConfirmMode: 'approve' | 'reject' | null = $state(null)
  let bulkRejectReason = $state('')
  let bulkRejectInputEl: HTMLInputElement | undefined = $state()
  let batchProgress: { done: number; total: number } | null = $state(null)
  let batchResult: { succeeded: number; failed: number } | null = $state(null)
  let listScrollEl: HTMLDivElement | undefined = $state()
  let editing = $state(false)
  /** edit_then_approve 表单 — 仅当 editing 时使用,保留原始值便于撤回 */
  let editBody = $state('')
  let editTagsStr = $state('')
  let editScope = $state('')
  let editConfidence: number | null = $state(null)
  /** Phase 10.10:edit-then-approve 时由 RelatedFactPicker 收集的链字段 */
  let editRelated: string[] = $state([])
  let editContradicts: string[] = $state([])
  let busy = $state(false) // 防止快速双击触发两次 review
  /// reject / blacklist 时弹的 inline reason 输入态。
  /// 不能用 window.prompt — Tauri WKWebView 禁用 dialog.* 系列(详见 Terminal.svelte 同样的坑)。
  let rejectMode: 'reject' | 'blacklist' | null = $state(null)
  let rejectReason = $state('')
  let rejectInputEl: HTMLInputElement | undefined = $state()
  let refreshQueued = false

  const checkedCount = $derived(checkedKeys.size)
  const allChecked = $derived(pending.length > 0 && checkedKeys.size === pending.length)
  const someChecked = $derived(checkedKeys.size > 0 && !allChecked)

  function showToast(kind: 'ok' | 'err', msg: string) {
    pushToast({ severity: kind === 'ok' ? 'success' : 'error', title: msg })
  }

  function originLabel(o: MemoryOrigin | undefined): string {
    if (!o || o.kind === 'local') return t('memory.common.local')
    const ep = endpoints.find((e) => e.id === o.endpointId)
    return t('memory.common.remote', { name: ep?.display_name || o.endpointId })
  }

  function pendingKey(p: MemoryPending): string {
    const origin = p.origin ?? { kind: 'local' }
    return origin.kind === 'local'
      ? `local:${p.id}`
      : `remote:${origin.endpointId}:${p.id}`
  }

  /// 聚合拉取本地 + 所有已配置远端的 pending,失败隔离:单来源失败只挂局部错误。
  /// 每条 pending 打上 origin,review() 据此路由到本地 / 远端命令。
  async function refresh() {
    loading = true
    bootError = null
    const errs: SourceError[] = []
    const merged: MemoryPending[] = []

    // 本地来源(同时取 stats 给 header 计数)
    const localTask = (async () => {
      try {
        const [list, st] = await Promise.all([
          memoryIpc.listPending(),
          memoryIpc.stats(),
        ])
        stats = st
        for (const p of list) merged.push({ ...p, origin: { kind: 'local' } })
        return true
      } catch (e) {
        stats = null
        errs.push({ origin: { kind: 'local' }, label: t('memory.common.local'), detail: String(e) })
        return false
      }
    })()

    // 每个远端 endpoint 并发拉,各自隔离失败
    const remoteTasks = endpoints.map(async (ep) => {
      try {
        const list = await memoryIpc.listPendingRemote(ep.id)
        for (const p of list)
          merged.push({ ...p, origin: { kind: 'remote', endpointId: ep.id } })
        return true
      } catch (e) {
        errs.push({
          origin: { kind: 'remote', endpointId: ep.id },
          label: t('memory.common.remote', { name: ep.display_name || ep.id }),
          detail: String(e),
        })
        return false
      }
    })

    const results = await Promise.all([localTask, ...remoteTasks])
    const anyOk = results.some((r) => r)

    // 按 created 倒序(新的在前),来源混排
    merged.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0))
    pending = merged
    sourceErrors = errs
    // 完全没有任何来源成功 → bootError(本地失败且远端也全挂 / 没远端)
    bootError = !anyOk && errs.length > 0 ? errs.map((e) => `${e.label}: ${e.detail}`).join('\n') : null

    const liveKeys = new Set(pending.map(pendingKey))
    checkedKeys = new Set([...checkedKeys].filter((key) => liveKeys.has(key)))
    if (checkedKeys.size === 0) {
      batchConfirmMode = null
      bulkRejectReason = ''
    }
    if (selectedKey && !liveKeys.has(selectedKey)) {
      selectedKey = null
      editing = false
    }
    loading = false
  }

  let unlistenPending: (() => void) | null = null
  let unlistenRemotePending: (() => void) | null = null

  onMount(async () => {
    try {
      endpoints = await endpointIpc.list()
    } catch {
      endpoints = []
    }
    await refresh()
    // 后端 watcher 1.5s 一次,前端模态打开期间也订阅事件即时刷新(任一来源变化都整表重拉)
    unlistenPending = await memoryIpc.onPendingCount(async () => {
      if (busy) {
        refreshQueued = true
        return
      }
      await refresh()
    })
    unlistenRemotePending = await memoryIpc.onRemotePendingCount(async () => {
      if (busy) {
        refreshQueued = true
        return
      }
      await refresh()
    })
  })

  onDestroy(() => {
    unlistenPending?.()
    unlistenRemotePending?.()
  })

  function selected(): MemoryPending | null {
    if (!selectedKey) return null
    return pending.find((p) => pendingKey(p) === selectedKey) ?? null
  }

  function resetBatchDecision() {
    batchConfirmMode = null
    bulkRejectReason = ''
    batchResult = null
  }

  function toggleChecked(p: MemoryPending, checked?: boolean) {
    if (busy) return
    const key = pendingKey(p)
    const next = new Set(checkedKeys)
    if (checked ?? !next.has(key)) next.add(key)
    else next.delete(key)
    checkedKeys = next
    resetBatchDecision()
  }

  function toggleAllChecked(checked: boolean) {
    if (busy) return
    checkedKeys = checked ? new Set(pending.map(pendingKey)) : new Set()
    resetBatchDecision()
  }

  function clearChecked() {
    if (busy) return
    checkedKeys = new Set()
    resetBatchDecision()
  }

  function startEdit() {
    const s = selected()
    if (!s) return
    editing = true
    editBody = s.body
    editTagsStr = s.tags.join(', ')
    editScope = s.scope
    editConfidence = s.confidence
    editRelated = [...s.related]
    editContradicts = [...s.contradicts]
  }

  function cancelEdit() {
    editing = false
    editRelated = []
    editContradicts = []
  }

  function reviewPending(p: MemoryPending, verdict: MemoryVerdict) {
    const origin = p.origin ?? { kind: 'local' }
    return origin.kind === 'local'
      ? memoryIpc.review(p.id, verdict)
      : memoryIpc.reviewRemote(origin.endpointId, p.id, verdict)
  }

  async function flushQueuedRefresh() {
    if (!refreshQueued) return
    refreshQueued = false
    await refresh()
  }

  async function review(verdict: MemoryVerdict) {
    const s = selected()
    if (!s || busy) return
    busy = true
    try {
      const result = await reviewPending(s, verdict)
      // 乐观:从列表移除被审掉的条目
      const reviewedKey = pendingKey(s)
      pending = pending.filter((p) => pendingKey(p) !== reviewedKey)
      checkedKeys = new Set([...checkedKeys].filter((key) => key !== reviewedKey))
      selectedKey = null
      editing = false
      const verb = result.outcome === 'approved' ? 'approved'
        : result.outcome === 'rejected' ? 'rejected' : 'blacklisted'
      showToast(
        result.outcome === 'approved' ? 'ok' : 'err',
        `${verb}, ${s.author} energy → ${result.author_energy.toFixed(1)}`,
      )
    } catch (e) {
      showToast('err', String(e))
    } finally {
      busy = false
      await flushQueuedRefresh()
    }
  }

  async function bulkReview(verdict: MemoryVerdict) {
    if (busy || checkedKeys.size === 0) return
    const targets = pending.filter((p) => checkedKeys.has(pendingKey(p)))
    if (targets.length === 0) return

    busy = true
    editing = false
    rejectMode = null
    batchResult = null
    batchProgress = { done: 0, total: targets.length }
    const succeeded = new Set<string>()
    const failures: string[] = []
    try {
      for (const [index, item] of targets.entries()) {
        try {
          await reviewPending(item, verdict)
          succeeded.add(pendingKey(item))
        } catch (error) {
          failures.push(`${originLabel(item.origin)} · ${item.id}: ${String(error)}`)
        }
        batchProgress = { done: index + 1, total: targets.length }
      }

      pending = pending.filter((p) => !succeeded.has(pendingKey(p)))
      checkedKeys = new Set([...checkedKeys].filter((key) => !succeeded.has(key)))
      const selectedWasRemoved = selectedKey ? succeeded.has(selectedKey) : false
      if (selectedWasRemoved) selectedKey = pending[0] ? pendingKey(pending[0]) : null
      batchResult = { succeeded: succeeded.size, failed: failures.length }

      if (failures.length > 0) {
        showToast('err', t('memory.review.bulkPartial', {
          succeeded: succeeded.size,
          failed: failures.length,
        }))
        console.error('bulk memory review failures:', failures)
      } else {
        showToast('ok', verdict.kind === 'approve'
          ? t('memory.review.bulkApproved', { count: succeeded.size })
          : t('memory.review.bulkRejected', { count: succeeded.size }))
      }
    } finally {
      batchProgress = null
      busy = false
      await flushQueuedRefresh()
      requestAnimationFrame(() => {
        listScrollEl?.querySelector<HTMLButtonElement>('.list-entry.checked .list-item, .list-item')?.focus()
      })
    }
  }

  function startBulkApprove() {
    if (busy || checkedKeys.size === 0) return
    batchConfirmMode = 'approve'
    bulkRejectReason = ''
    batchResult = null
  }

  function startBulkReject() {
    if (busy || checkedKeys.size === 0) return
    batchConfirmMode = 'reject'
    bulkRejectReason = ''
    batchResult = null
    requestAnimationFrame(() => bulkRejectInputEl?.focus())
  }

  function cancelBatchDecision() {
    batchConfirmMode = null
    bulkRejectReason = ''
  }

  async function confirmBulkReview() {
    if (!batchConfirmMode) return
    const mode = batchConfirmMode
    const reason = bulkRejectReason.trim() || 'rejected by user'
    batchConfirmMode = null
    bulkRejectReason = ''
    await bulkReview(mode === 'approve' ? { kind: 'approve' } : { kind: 'reject', reason })
  }

  async function approve() { await review({ kind: 'approve' }) }

  /// 进入 inline reason 输入态(reject 或 blacklist)。Tauri 没有原生 prompt,
  /// 所以在面板内显示一行输入框 + 确认/取消按钮,Enter 确认 / Esc 取消。
  function startReject(mode: 'reject' | 'blacklist') {
    rejectMode = mode
    rejectReason = ''
    // 等下一帧 input 渲染出来再 focus
    requestAnimationFrame(() => rejectInputEl?.focus())
  }
  function cancelReject() {
    rejectMode = null
    rejectReason = ''
  }
  async function confirmReject() {
    if (!rejectMode) return
    const reason = rejectReason.trim() || `${rejectMode}ed by user`
    const mode = rejectMode
    // 先清掉表单,review() 会处理 busy/toast/列表更新
    rejectMode = null
    rejectReason = ''
    if (mode === 'reject') {
      await review({ kind: 'reject', reason })
    } else {
      await review({ kind: 'blacklist', reason })
    }
  }
  async function approveEdited() {
    const tags = editTagsStr
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    await review({
      kind: 'edit_then_approve',
      body: editBody,
      tags,
      scope: editScope,
      confidence: editConfidence ?? undefined,
      related: editRelated.length > 0 ? editRelated : undefined,
      contradicts: editContradicts.length > 0 ? editContradicts : undefined,
    })
  }

  function onKey(e: KeyboardEvent) {
    // Esc 优先级:批量确认 > 单条拒绝 > editing > 关面板。
    if (e.key === 'Escape') {
      e.preventDefault()
      if (batchConfirmMode) {
        cancelBatchDecision()
      } else if (rejectMode) {
        cancelReject()
      } else if (editing) {
        cancelEdit()
      } else {
        onClose()
      }
      return
    }
    const target = e.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return
    // rejecting 状态下吞掉所有快捷键,焦点交给 reason input
    if (rejectMode || batchConfirmMode) return
    // 列表导航
    if (!editing && pending.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault()
        const idx = pending.findIndex((p) => pendingKey(p) === selectedKey)
        const next = pending[Math.min(pending.length - 1, idx + 1)] ?? pending[0]
        selectedKey = pendingKey(next)
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault()
        const idx = pending.findIndex((p) => pendingKey(p) === selectedKey)
        const prev = pending[Math.max(0, idx - 1)] ?? pending[0]
        selectedKey = pendingKey(prev)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        if (selected()) approve()
      } else if (e.key === 'r' || e.key === 'R') {
        e.preventDefault()
        if (selected()) startReject('reject')
      } else if (e.key === 'e' || e.key === 'E') {
        e.preventDefault()
        if (selected()) startEdit()
      }
    }
  }

  /// kind → Icon name 映射。无对应类型用 'list-checks' 兜底。
  function kindIcon(kind: string): IconName {
    switch (kind) {
      case 'gotcha': return 'alert-triangle'
      case 'invariant': return 'lock'
      case 'recipe': return 'list-checks'
      case 'dead_end': return 'construction'
      case 'preference': return 'star'
      default: return 'list-checks'
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" use:outsidePressClose={{ onClose }} role="presentation">
  <div class="panel" role="dialog" aria-modal="true" aria-label={t('memory.review.title')} tabindex="-1">
    <header>
      <div class="title">
        <span class="status-dot"></span>
        <strong>{t('memory.review.title')}</strong>
        <span class="muted">
          {pending.length} pending{#if endpoints.length > 0} · local + {endpoints.length} remote{/if}
        </span>
      </div>
      <div class="header-actions">
        {#if stats}
          <span class="root-path" title={stats.root}>{stats.root}</span>
        {/if}
        <button type="button" class="x-btn" title={t('memory.common.close')} aria-label={t('memory.common.close')} onclick={onClose}>
          <Icon name="x" />
        </button>
      </div>
    </header>

    <div class="body" class:single-col={pending.length === 0 && !loading && !bootError}>
      {#if loading}
        <div class="empty">{t('memory.common.loading')}</div>
      {:else if bootError}
        <div class="boot-error"><strong>{t('memory.review.unavailable')}</strong><br/>{bootError}</div>
      {:else if pending.length === 0}
        <div class="empty">
          {#if sourceErrors.length > 0}
            <div class="src-errors">
              {#each sourceErrors as se (se.label)}
                <div class="src-error" title={se.detail}>
                  <Icon name="alert-triangle" /> {se.label} unavailable — {se.detail}
                </div>
              {/each}
            </div>
          {/if}
          <div class="empty-icon"><Icon name="check" size="28" stroke={1.6} /></div>
          <strong>{t('memory.review.emptyTitle')}</strong>
          <span>{t('memory.review.emptyDescription')}</span>
        </div>
      {:else}
        <aside class="list" aria-label={t('memory.review.pendingList')} aria-busy={busy}>
          <div class="list-toolbar">
            <SelectionCheckbox
              checked={allChecked}
              indeterminate={someChecked}
              disabled={busy}
              label={t('memory.review.selectAllCount', { count: pending.length })}
              ariaLabel={t('memory.review.selectAllCount', { count: pending.length })}
              onChange={toggleAllChecked}
            />
            <span class="queue-hint" class:active={checkedCount > 0}>
              {checkedCount > 0
                ? t('memory.review.selectedCount', { count: checkedCount })
                : t('memory.review.selectionHint')}
            </span>
          </div>

          <div class="list-scroll" bind:this={listScrollEl}>
            {#if sourceErrors.length > 0}
              {#each sourceErrors as se (se.label)}
                <div class="src-error" title={se.detail}>
                  <Icon name="alert-triangle" /> {se.label} unavailable
                </div>
              {/each}
            {/if}
            {#each pending as p (pendingKey(p))}
              <div
                class="list-entry"
                class:checked={checkedKeys.has(pendingKey(p))}
                class:focused={pendingKey(p) === selectedKey}
              >
                <div class="item-check">
                  <SelectionCheckbox
                    checked={checkedKeys.has(pendingKey(p))}
                    disabled={busy}
                    ariaLabel={t('memory.review.toggleSelection')}
                    title={t('memory.review.toggleSelection')}
                    onChange={(checked) => toggleChecked(p, checked)}
                  />
                </div>
                <button
                  type="button"
                  class="list-item"
                  aria-current={pendingKey(p) === selectedKey ? 'true' : undefined}
                  onclick={() => { selectedKey = pendingKey(p); editing = false }}
                >
                  <div class="li-row1">
                    <span class="li-kind" title={p.kind}>
                      <Icon name={kindIcon(p.kind)} />
                      <span>{p.kind}</span>
                    </span>
                    <span class="li-author">{p.author}</span>
                    <span
                      class="li-origin"
                      class:remote={(p.origin ?? { kind: 'local' }).kind === 'remote'}
                      title={originLabel(p.origin)}
                    >{originLabel(p.origin)}</span>
                    <span class="li-date" title={formatLocalDateTimeFull(p.created)}>{formatLocalDateTimeShort(p.created)}</span>
                  </div>
                  <div class="li-body">{p.body}</div>
                  <div class="li-row3">
                    <span class="li-scope">{p.scope}</span>
                    {#if p.subsystem}
                      <span class="sub-chip">{p.subsystem}</span>
                    {/if}
                    {#each p.tags as tag}
                      <span class="tag-chip">#{tag}</span>
                    {/each}
                    <span class="conf">conf {p.confidence.toFixed(2)}</span>
                    <span class="energy" title="author remaining energy"><Icon name="zap" /> {p.author_energy.toFixed(1)}</span>
                  </div>
                </button>
              </div>
            {/each}
          </div>

          {#if checkedCount > 0 || batchResult}
            <section class="selection-dock" aria-live="polite">
              {#if checkedCount > 0}
                <div class="dock-summary">
                  <span class="selection-count">{checkedCount}</span>
                  <div class="selection-copy">
                    <strong>{t('memory.review.selectedCount', { count: checkedCount })}</strong>
                    <span>{t('memory.review.selectionScope')}</span>
                  </div>
                  <button
                    type="button"
                    class="dock-clear"
                    disabled={busy}
                    onclick={clearChecked}
                  >
                    <Icon name="x" size={12} /> {t('memory.review.clearSelection')}
                  </button>
                </div>

                {#if batchProgress}
                  <div class="batch-progress" role="status">
                    <div class="progress-copy">
                      <span>{t('memory.review.bulkProgress', { done: batchProgress.done, total: batchProgress.total })}</span>
                      <span>{Math.round((batchProgress.done / batchProgress.total) * 100)}%</span>
                    </div>
                    <progress value={batchProgress.done} max={batchProgress.total}></progress>
                  </div>
                {:else if batchConfirmMode}
                  <div class="batch-confirm" data-mode={batchConfirmMode}>
                    <div class="confirm-copy">
                      <strong>
                        {batchConfirmMode === 'approve'
                          ? t('memory.review.confirmBulkApprove', { count: checkedCount })
                          : t('memory.review.confirmBulkReject', { count: checkedCount })}
                      </strong>
                      <span>
                        {batchConfirmMode === 'approve'
                          ? t('memory.review.bulkApproveConsequence')
                          : t('memory.review.bulkRejectConsequence')}
                      </span>
                    </div>
                    {#if batchConfirmMode === 'reject'}
                      <label class="bulk-reason">
                        <span>{t('memory.review.bulkRejectReason')}</span>
                        <input
                          bind:this={bulkRejectInputEl}
                          bind:value={bulkRejectReason}
                          placeholder={t('memory.review.bulkRejectPlaceholder')}
                          spellcheck="false"
                          onkeydown={(e) => {
                            e.stopPropagation()
                            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmBulkReview() }
                            else if (e.key === 'Escape') { e.preventDefault(); cancelBatchDecision() }
                          }}
                        />
                      </label>
                    {/if}
                    <div class="confirm-actions">
                      <button type="button" class="dock-btn neutral" onclick={cancelBatchDecision}>
                        {t('memory.common.cancel')}
                      </button>
                      <button
                        type="button"
                        class="dock-btn"
                        class:approve={batchConfirmMode === 'approve'}
                        class:reject={batchConfirmMode === 'reject'}
                        onclick={confirmBulkReview}
                      >
                        <Icon name={batchConfirmMode === 'approve' ? 'check' : 'x'} />
                        {batchConfirmMode === 'approve'
                          ? t('memory.review.confirmBulkApproveAction', { count: checkedCount })
                          : t('memory.review.confirmBulkRejectAction', { count: checkedCount })}
                      </button>
                    </div>
                  </div>
                {:else}
                  <div class="dock-actions">
                    <button type="button" class="dock-btn approve" disabled={busy} onclick={startBulkApprove}>
                      <Icon name="check" /> {t('memory.review.bulkApprove')}
                    </button>
                    <button type="button" class="dock-btn reject" disabled={busy} onclick={startBulkReject}>
                      <Icon name="x" /> {t('memory.review.bulkReject')}
                    </button>
                  </div>
                {/if}
              {/if}

              {#if batchResult}
                <div class="batch-result" class:error={batchResult.failed > 0} role={batchResult.failed > 0 ? 'alert' : 'status'}>
                  <Icon name={batchResult.failed > 0 ? 'alert-triangle' : 'check'} />
                  <span>
                    {batchResult.failed > 0
                      ? t('memory.review.bulkPartial', { succeeded: batchResult.succeeded, failed: batchResult.failed })
                      : t('memory.review.bulkCompleted', { count: batchResult.succeeded })}
                  </span>
                  <button type="button" aria-label={t('memory.common.close')} onclick={() => (batchResult = null)}>
                    <Icon name="x" size={12} />
                  </button>
                </div>
              {/if}
            </section>
          {/if}
        </aside>

        <section class="detail">
          {#if selected()}
            {@const s = selected()!}
            <div class="d-meta">
              <div class="d-meta-row">
                <span class="muted">source</span>
                <span>{originLabel(s.origin)}</span>
              </div>
              <div class="d-meta-row">
                <span class="muted">id</span>
                <code>{s.id}</code>
              </div>
              <div class="d-meta-row">
                <span class="muted">author</span>
                <span>{s.author}{s.session ? ` · ${s.session}` : ''}</span>
              </div>
              <div class="d-meta-row">
                <span class="muted">kind / scope</span>
                <span><Icon name={kindIcon(s.kind)} /> {s.kind} · {s.scope}{s.subsystem ? ` · ${s.subsystem}` : ''}</span>
              </div>
              <div class="d-meta-row">
                <span class="muted">created</span>
                <span>{formatLocalDateTimeFull(s.created)}</span>
              </div>
              {#if s.supersedes}
                <div class="d-meta-row">
                  <span class="muted">supersedes</span>
                  <code>{s.supersedes}</code>
                </div>
              {/if}
            </div>

            {#if editing}
              <div class="d-section">
                <label>Body
                  <textarea class="resize-none" bind:value={editBody} rows="8"></textarea>
                </label>
                <label>Tags (comma-separated)
                  <input bind:value={editTagsStr} spellcheck="false"/>
                </label>
                <div class="row">
                  <label class="grow">Scope
                    <input bind:value={editScope} spellcheck="false" placeholder="shared / global / project:foo"/>
                  </label>
                  <label>Confidence
                    <input type="number" min="0" max="1" step="0.05" bind:value={editConfidence}/>
                  </label>
                </div>
                {#if (s.origin ?? { kind: 'local' }).kind === 'local'}
                  <RelatedFactPicker
                    parentId={s.id}
                    scope={editScope || s.scope}
                    bind:related={editRelated}
                    bind:contradicts={editContradicts}
                  />
                {:else}
                  <p class="remote-note">{t('memory.review.remoteNote')}</p>
                {/if}
              </div>
            {:else}
              <div class="d-section">
                <h3>{t('memory.review.body')}</h3>
                <pre class="d-body">{s.body}</pre>
                {#if s.rationale}
                  <h3>{t('memory.review.rationale')} <span class="muted">({t('memory.review.rationaleHint')})</span></h3>
                  <pre class="d-rationale">{s.rationale}</pre>
                {/if}
              </div>
            {/if}

            <footer class="actions">
              {#if rejectMode}
                <!-- inline reason 表单 — 替代 window.prompt(Tauri WKWebView 不允许调) -->
                <div class="reject-row">
                  <span class="reject-lbl">
                    {rejectMode === 'reject' ? t('memory.review.rejectReason') : t('memory.review.blacklistReason')}
                    <span class="muted">(shown to agent)</span>
                  </span>
                  <input
                    bind:this={rejectInputEl}
                    bind:value={rejectReason}
                    placeholder={rejectMode === 'reject' ? 'why reject?' : 'why blacklist? (heavy penalty)'}
                    onkeydown={(e) => {
                      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirmReject() }
                      else if (e.key === 'Escape') { e.preventDefault(); cancelReject() }
                    }}
                    spellcheck="false"
                  />
                  <button
                    class="btn {rejectMode === 'reject' ? 'btn-err' : 'btn-err-strong'}"
                    disabled={busy}
                    onclick={confirmReject}
                  >
                    <Icon name={rejectMode === 'reject' ? 'x' : 'octagon-x'} />
                    Confirm {rejectMode}
                  </button>
                  <button class="btn btn-ghost" onclick={cancelReject}>{t('memory.common.cancel')}</button>
                </div>
              {:else if editing}
                <button class="btn btn-ok" disabled={busy} onclick={approveEdited}>
                  <Icon name="check" /> Approve edited
                </button>
                <button class="btn btn-ghost" onclick={cancelEdit}>{t('memory.review.cancelEdit')}</button>
              {:else}
                <button class="btn btn-ok" disabled={busy} onclick={approve} title="Enter">
                  <Icon name="check" /> Approve <kbd>↵</kbd>
                </button>
                <button class="btn btn-warn" disabled={busy} onclick={startEdit} title="E">
                  <Icon name="pencil" /> Edit then approve <kbd>e</kbd>
                </button>
                <button class="btn btn-err" disabled={busy} onclick={() => startReject('reject')} title="R">
                  <Icon name="x" /> Reject <kbd>r</kbd>
                </button>
                <button class="btn btn-err-strong" disabled={busy} onclick={() => startReject('blacklist')}>
                  <Icon name="octagon-x" /> Blacklist
                </button>
              {/if}
            </footer>
          {:else}
            <div class="d-empty">
              <span class="muted">{t('memory.review.select')}</span>
            </div>
          {/if}
        </section>
      {/if}
    </div>

  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-modal-backdrop);
    backdrop-filter: var(--blur-modal);
    -webkit-backdrop-filter: var(--blur-modal);
    z-index: 1100;
    display: flex;
    justify-content: flex-end;
    animation: fade 120ms ease-out;
  }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .panel {
    width: min(1080px, 92vw);
    height: 100vh;
    background: var(--bg-elevated);
    color: var(--fg-primary);
    display: flex;
    flex-direction: column;
    box-shadow: var(--sh-modal);
    animation: slide 160ms ease-out;
  }
  @keyframes slide {
    from { transform: translateX(20px); opacity: 0; }
    to   { transform: translateX(0);    opacity: 1; }
  }

  header {
    flex-shrink: 0;
    height: 44px;
    padding: 0 var(--sp-3);
    border-bottom: 1px solid var(--bd-default);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-2);
  }
  .title { display: flex; align-items: baseline; gap: var(--sp-2); }
  .title strong { font-size: 14px; font-weight: var(--fw-semi); }
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--st-ok);
    flex-shrink: 0;
    box-shadow: 0 0 6px color-mix(in srgb, var(--st-ok) 40%, transparent);
    animation: statusPulse 2.5s ease-in-out infinite;
  }
  @keyframes statusPulse {
    0%, 100% { box-shadow: 0 0 4px color-mix(in srgb, var(--st-ok) 30%, transparent); }
    50% { box-shadow: 0 0 10px color-mix(in srgb, var(--st-ok) 50%, transparent), 0 0 18px color-mix(in srgb, var(--st-ok) 20%, transparent); }
  }
  .muted { color: var(--fg-tertiary); font-size: var(--fs-sm); }
  .header-actions { display: flex; align-items: center; gap: var(--sp-2); }
  .root-path {
    font-family: var(--font-mono);
    font-size: 10.5px;
    color: var(--fg-tertiary);
    max-width: 32ch;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .x-btn {
    background: transparent; border: none;
    color: var(--fg-secondary);
    width: 22px; height: 22px;
    border-radius: var(--rad-sm);
    cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .x-btn:hover { background: var(--bg-tab-hover); color: var(--fg-primary); }
  .x-btn:focus-visible,
  .list-item:focus-visible,
  .btn:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }

  .body {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: 400px 1fr;
    overflow: hidden;
  }
  .empty, .boot-error, .d-empty {
    grid-column: 1 / -1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--sp-2);
    padding: var(--sp-4);
    color: var(--fg-secondary);
  }
  .empty-icon {
    font-size: 32px;
    color: var(--st-ok);
    opacity: 0.5;
  }
  .empty strong { color: var(--fg-primary); font-size: 16px; }
  .boot-error { color: var(--st-err); white-space: pre-wrap; }
  .body.single-col { grid-template-columns: 1fr; }
  .src-errors { display: flex; flex-direction: column; gap: 4px; margin-bottom: var(--sp-2); }
  .src-error {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--st-warn);
    background: color-mix(in srgb, var(--st-warn) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--st-warn) 30%, transparent);
    border-radius: var(--rad-sm);
    padding: 4px 8px;
    margin: 2px 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ===== left list ===== */
  .list {
    border-right: 1px solid var(--bd-default);
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--bg-sidebar);
  }
  .list-toolbar {
    flex: 0 0 auto;
    min-height: 40px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--sp-2);
    padding: 6px 9px;
    border-bottom: 1px solid var(--bd-default);
    background: color-mix(in srgb, var(--bg-sidebar) 94%, var(--bg-elevated));
  }
  .queue-hint {
    flex: 1 1 180px;
    color: var(--fg-tertiary);
    font-size: 10px;
    line-height: 1.35;
    text-align: right;
  }
  .queue-hint.active {
    color: var(--acc);
    font-family: var(--font-mono);
  }
  .list-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    display: grid;
    grid-auto-rows: max-content;
    align-content: start;
    gap: 5px;
    padding: 7px;
    scrollbar-gutter: stable;
  }
  .selection-dock {
    flex-shrink: 0;
    position: relative;
    display: inline-flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 9px 9px;
    border-top: 1px solid color-mix(in srgb, var(--acc) 28%, var(--bd-default));
    background: color-mix(in srgb, var(--bg-elevated) 97%, var(--bg-sidebar));
    box-shadow: 0 -10px 24px rgba(0, 0, 0, 0.12);
  }
  .dock-summary {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
  }
  .selection-count {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--acc) 38%, var(--bd-default));
    border-radius: var(--rad-md);
    background: var(--acc-soft);
    color: var(--acc);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
  }
  .selection-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .selection-copy strong {
    color: var(--fg-primary);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semi);
  }
  .selection-copy span {
    color: var(--fg-tertiary);
    font-size: 10px;
  }
  .dock-clear {
    height: 26px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 7px;
    border: 1px solid transparent;
    border-radius: var(--rad-sm);
    background: transparent;
    color: var(--fg-tertiary);
    font-size: 10px;
    cursor: pointer;
  }
  .dock-clear:hover:not(:disabled) {
    border-color: var(--bd-default);
    background: var(--bg-hover);
    color: var(--fg-primary);
  }
  .dock-actions,
  .confirm-actions {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .dock-actions .dock-btn { flex: 1; }
  .confirm-actions { justify-content: flex-end; }
  .dock-btn {
    min-height: 31px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 5px;
    padding: 0 10px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    background: var(--bg-hover);
    color: var(--fg-primary);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semi);
    cursor: pointer;
    transition: background var(--t-fast), border-color var(--t-fast), transform var(--t-fast);
  }
  .dock-btn:hover:not(:disabled) { transform: translateY(-1px); }
  .dock-btn:active:not(:disabled) { transform: translateY(0); }
  .dock-btn:disabled,
  .dock-clear:disabled { opacity: 0.48; cursor: not-allowed; }
  .dock-btn.approve {
    border-color: var(--st-ok);
    background: var(--st-ok);
    color: var(--fg-on-accent);
  }
  .dock-btn.reject {
    border-color: color-mix(in srgb, var(--st-err) 55%, var(--bd-default));
    background: color-mix(in srgb, var(--st-err) 9%, var(--bg-elevated));
    color: var(--st-err);
  }
  .dock-btn.neutral { background: transparent; color: var(--fg-secondary); }
  .batch-confirm {
    display: flex;
    flex-direction: column;
    gap: 9px;
    padding: 9px;
    border: 1px solid color-mix(in srgb, var(--st-ok) 32%, var(--bd-default));
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--st-ok) 6%, var(--bg-input));
  }
  .batch-confirm[data-mode='reject'] {
    border-color: color-mix(in srgb, var(--st-err) 38%, var(--bd-default));
    background: color-mix(in srgb, var(--st-err) 6%, var(--bg-input));
  }
  .confirm-copy {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .confirm-copy strong { color: var(--fg-primary); font-size: var(--fs-xs); }
  .confirm-copy span { color: var(--fg-tertiary); font-size: 10px; line-height: 1.4; }
  .bulk-reason {
    display: flex;
    flex-direction: column;
    gap: 5px;
    color: var(--fg-secondary);
    font-size: 10px;
  }
  .bulk-reason input {
    flex: 1;
    min-width: 0;
    height: 31px;
    padding: 0 9px;
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    outline: none;
    background: var(--bg-input);
    color: var(--fg-primary);
    font: inherit;
    font-size: var(--fs-xs);
  }
  .bulk-reason input:focus {
    border-color: var(--st-err);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-err) 10%, transparent);
  }
  .batch-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .progress-copy {
    display: flex;
    justify-content: space-between;
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: 10px;
  }
  .batch-progress progress {
    width: 100%;
    height: 5px;
    border: none;
    border-radius: 999px;
    overflow: hidden;
    background: var(--bg-chip);
    accent-color: var(--acc);
  }
  .batch-progress progress::-webkit-progress-bar { background: var(--bg-chip); }
  .batch-progress progress::-webkit-progress-value { background: var(--acc); border-radius: 999px; }
  .batch-result {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) 24px;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 4px 4px 4px 8px;
    border: 1px solid color-mix(in srgb, var(--st-ok) 30%, var(--bd-default));
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--st-ok) 7%, transparent);
    color: var(--st-ok);
    font-size: 10px;
  }
  .batch-result.error {
    border-color: color-mix(in srgb, var(--st-err) 32%, var(--bd-default));
    background: color-mix(in srgb, var(--st-err) 7%, transparent);
    color: var(--st-err);
  }
  .batch-result button {
    width: 24px;
    height: 24px;
    display: grid;
    place-items: center;
    border: 0;
    border-radius: var(--rad-sm);
    background: transparent;
    color: currentColor;
    cursor: pointer;
  }
  .batch-result button:hover { background: var(--bg-hover); }
  .dock-btn:focus-visible,
  .dock-clear:focus-visible,
  .batch-result button:focus-visible {
    outline: 2px solid var(--acc);
    outline-offset: 2px;
  }
  .list-entry {
    position: relative;
    display: block;
    min-width: 0;
    border: 1px solid transparent;
    border-radius: var(--rad-md);
    background: color-mix(in srgb, var(--bg-elevated) 48%, transparent);
    overflow: hidden;
    transition: background var(--t-fast), border-color var(--t-fast), box-shadow var(--t-fast);
  }
  .list-entry.checked {
    background: color-mix(in srgb, var(--acc) 6%, var(--bg-elevated));
  }
  .list-entry.focused {
    border-color: color-mix(in srgb, var(--st-info) 52%, var(--bd-default));
    box-shadow: 0 1px 4px color-mix(in srgb, var(--fg-primary) 8%, transparent);
  }
  .list-entry:focus-within {
    box-shadow: inset 0 0 0 2px var(--acc);
  }
  .item-check {
    position: absolute;
    top: 2px;
    left: 4px;
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 2;
  }
  .list-item {
    display: block;
    width: 100%;
    box-sizing: border-box;
    text-align: left;
    background: transparent;
    border: 0;
    border-radius: inherit;
    padding: 8px 9px 9px 39px;
    margin: 0;
    cursor: pointer;
    color: inherit;
    transition: background var(--t-fast);
  }
  .list-item:hover { background: var(--bg-tab-hover); }
  .li-row1 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    font-size: var(--fs-xs);
  }
  .li-kind {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fg-secondary);
    font-family: var(--font-mono);
    font-size: 9.5px;
    white-space: nowrap;
  }
  .li-author { color: var(--fg-primary); font-weight: var(--fw-med); }
  .li-origin {
    max-width: 100%;
    font-size: 9.5px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--bg-chip);
    color: var(--fg-tertiary);
    line-height: 1.35;
    overflow-wrap: anywhere;
  }
  .li-origin.remote {
    background: color-mix(in srgb, var(--st-info) 16%, transparent);
    color: var(--st-info);
  }
  .li-scope {
    max-width: 100%;
    color: var(--st-info);
    font-family: var(--font-mono);
    font-size: 10px;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .li-date {
    margin-left: auto;
    color: var(--fg-tertiary);
    font-family: var(--font-mono);
    font-size: 10px;
    white-space: nowrap;
  }
  .li-body {
    margin-top: 4px;
    font-size: var(--fs-sm);
    color: var(--fg-secondary);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.35;
  }
  .li-row3 {
    margin-top: 5px;
    display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    font-size: 10px;
  }
  .sub-chip, .tag-chip, .conf, .energy {
    padding: 1px 5px;
    border-radius: 3px;
    font-family: var(--font-mono);
    line-height: 1.4;
  }
  .sub-chip { background: color-mix(in srgb, var(--st-info) 14%, transparent); color: var(--st-info); }
  .tag-chip { background: var(--bg-chip); color: var(--fg-secondary); }
  .conf     { color: var(--fg-tertiary); margin-left: auto; }
  .energy   { color: var(--st-tokens); }

  /* ===== right detail ===== */
  .detail {
    overflow-y: auto;
    padding: var(--sp-3);
    display: flex;
    flex-direction: column;
    gap: var(--sp-3);
  }
  .d-meta {
    display: grid;
    grid-template-columns: 90px 1fr;
    row-gap: 4px;
    column-gap: var(--sp-2);
    font-size: var(--fs-sm);
    padding: var(--sp-2);
    background: var(--bg-chip);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
  }
  .d-meta-row { display: contents; }
  .d-meta-row code {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-secondary);
  }
  .d-section { display: flex; flex-direction: column; gap: var(--sp-2); }
  .remote-note {
    margin: 0;
    color: var(--fg-tertiary);
    font-size: var(--fs-sm);
  }
  .d-section h3 {
    margin: 0;
    font-size: 10px;
    font-family: var(--font-mono);
    font-weight: var(--fw-semi);
    color: var(--fg-tertiary);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    display: flex;
    align-items: center;
    gap: var(--sp-2);
  }
  .d-section h3::after {
    content: '';
    flex: 1;
    height: 1px;
    background: var(--bd-muted);
  }
  .d-body, .d-rationale {
    margin: 0;
    padding: var(--sp-2);
    background: var(--bg-pre);
    border: 1px solid var(--bd-muted);
    border-radius: var(--rad-md);
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-primary);
  }
  .d-rationale { color: var(--fg-secondary); }
  .d-section label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  .d-section input, .d-section textarea {
    background: var(--bg-base);
    color: var(--fg-primary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-sm);
    padding: 6px 8px;
    font-family: var(--font-mono);
    font-size: 12.5px;
    line-height: 1.4;
  }
  .d-section textarea {
    min-height: 160px;
    resize: none;
  }
  .d-section input:focus, .d-section textarea:focus {
    outline: none;
    border-color: var(--acc);
  }
  .row { display: flex; gap: var(--sp-2); }
  .grow { flex: 1; }

  footer.actions {
    display: flex;
    gap: var(--sp-2);
    flex-wrap: wrap;
    padding-top: var(--sp-2);
    border-top: 1px solid var(--bd-default);
  }
  .reject-row {
    display: flex;
    align-items: center;
    gap: var(--sp-2);
    flex-wrap: wrap;
    flex: 1;
  }
  .reject-row .reject-lbl {
    color: var(--fg-secondary);
    font-size: var(--fs-sm);
    white-space: nowrap;
  }
  .reject-row input {
    flex: 1;
    min-width: 200px;
    padding: 6px 10px;
    background: var(--bg-input);
    color: var(--fg-primary);
    border: 1px solid var(--bd-default);
    border-radius: var(--rad-md);
    font: inherit;
    outline: none;
  }
  .reject-row input:focus { border-color: var(--acc); }
  .btn {
    padding: 6px 12px;
    border-radius: var(--rad-md);
    border: 1px solid var(--bd-default);
    cursor: pointer;
    font-size: var(--fs-sm);
    color: var(--fg-primary);
    background: var(--bg-hover);
    transition: background var(--t-fast), filter var(--t-fast);
  }
  .btn:hover:not(:disabled) { filter: brightness(1.15); }
  .btn:disabled { opacity: 0.55; cursor: not-allowed; }
  .btn kbd {
    margin-left: 4px;
    padding: 0 4px;
    border: 1px solid var(--bd-default);
    border-radius: 3px;
    font-size: 10px;
    color: var(--fg-tertiary);
    background: var(--bg-base);
  }
  .btn-ok { background: var(--st-ok); color: var(--fg-on-accent); border-color: var(--st-ok); }
  .btn-warn { background: var(--st-warn); color: var(--fg-on-accent); border-color: var(--st-warn); }
  .btn-err { background: var(--st-err); color: var(--fg-on-accent); border-color: var(--st-err); }
  .btn-err-strong { background: color-mix(in srgb, var(--st-err) 30%, transparent); color: var(--fg-on-accent); border-color: var(--st-err); }
  .btn-ghost { background: transparent; }

  @media (prefers-reduced-motion: reduce) {
    .panel, .backdrop { animation: none; }
    .list-entry, .list-item, .dock-btn { transition: none; }
  }

  @media (max-width: 760px) {
    .panel { width: 100vw; }
    .body { grid-template-columns: minmax(280px, 44%) minmax(0, 1fr); }
    .root-path { max-width: 18ch; }
    .selection-dock { padding: 8px; }
    .dock-actions { flex-direction: column; }
    .dock-actions .dock-btn { width: 100%; }
  }

  @media (forced-colors: active) {
    .list-entry.checked,
    .list-entry.focused,
    .selection-dock,
    .batch-confirm,
    .batch-result {
      border-color: Highlight;
    }
  }
</style>
