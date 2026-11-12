<script lang="ts">
  /**
   * Conversation with a session running on another desktop of the account.
   *
   * Reads the relay's `/history` window every 2 s while mounted (each read also
   * keeps that desktop streaming) and sends input, interrupts and answers as
   * relay commands, the same ones the mobile app uses. The remote PTY screen
   * is never transferred; this is the semantic timeline only.
   */
  import { onMount, tick } from 'svelte'
  import { ipc, type AccountDevice, type AccountDeviceEvent, type AccountDeviceSession } from './ipc'
  import Icon from './Icon.svelte'
  import ConfirmDialog from './ConfirmDialog.svelte'
  import { currentLocale, t } from './i18n'
  import {
    buildTimeline,
    commandFailure,
    liveStatus,
    relayDelivery,
    relayToolTitleKey,
    sessionNameFor,
  } from './device_timeline'

  type Props = {
    device: AccountDevice
    session: AccountDeviceSession
    sessions: AccountDeviceSession[]
    workerScoped?: boolean
    onClose: () => void
    onChanged?: () => void
  }
  let { device, session, sessions, workerScoped = false, onClose, onChanged }: Props = $props()
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  const POLL_MS = 2000
  let events = $state<AccountDeviceEvent[]>([])
  let loaded = $state(false)
  let draft = $state('')
  let sending = $state(false)
  let error = $state('')
  let localTitle = $state('')
  let renameOpen = $state(false)
  let renameDraft = $state('')
  let deleteOpen = $state(false)
  let deleting = $state(false)
  let sentCommands: string[] = []
  let transcript: HTMLDivElement | undefined = $state()
  let pinnedToBottom = true

  let items = $derived(buildTimeline(events))
  let status = $derived(liveStatus(events, session.status))
  let busy = $derived(status === 'busy')
  let exited = $derived(status === 'exited')
  let agentName = $derived(session.backend_key)
  let sessionTitle = $derived(localTitle || session.title?.trim() || session.backend_key)

  function loadHistory(limit = 500) {
    return workerScoped
      ? ipc.cloudSyncWorkerHistory(device.device_id, session.id, limit)
      : ipc.accountDeviceHistory(device.device_id, session.id, limit)
  }

  function sendCommand(
    op: 'input' | 'interrupt' | 'answer' | 'plan_response' | 'delete' | 'rename',
    body: Record<string, unknown> = {},
  ) {
    if (workerScoped) return ipc.cloudSyncWorkerCommand(device.device_id, session.id, op, body)
    if (op === 'delete' || op === 'rename') {
      return Promise.reject(new Error('Session management requires a self-hosted Worker'))
    }
    return ipc.accountDeviceCommand(device.device_id, session.id, op, body)
  }

  async function refresh() {
    try {
      const reply = await loadHistory()
      const stick = pinnedToBottom
      events = reply.events
      loaded = true
      const failure = commandFailure(events, sentCommands)
      if (failure) error = t('devices.commandFailed', { error: failure })
      if (stick) {
        await tick()
        transcript?.scrollTo({ top: transcript.scrollHeight })
      }
    } catch (e) {
      error = String(e)
    }
  }

  onMount(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // Chain polls so a slow relay round-trip never stacks requests.
    const loop = async () => {
      if (stopped) return
      if (!document.hidden) await refresh()
      if (!stopped) timer = setTimeout(loop, POLL_MS)
    }
    void loop()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  })

  function onScroll() {
    if (!transcript) return
    pinnedToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40
  }

  async function command(
    op: 'input' | 'interrupt' | 'answer' | 'plan_response' | 'delete' | 'rename',
    body: Record<string, unknown> = {},
  ) {
    if (sending) return false
    sending = true
    error = ''
    try {
      const receipt = await sendCommand(op, body)
      if (receipt.command_id) sentCommands = [...sentCommands.slice(-19), receipt.command_id]
      void refresh()
      return true
    } catch (e) {
      error = String(e)
      return false
    } finally {
      sending = false
    }
  }

  async function send() {
    const text = draft.trim()
    if (!text) return
    pinnedToBottom = true
    if (await command('input', { text })) draft = ''
  }

  function onComposerKey(event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  /** Choice per AskUserQuestion `question_id`, until the group is submitted. */
  let selections = $state<Record<string, number>>({})

  /** Waits for the desktop's receipt so grouped answers land in order. */
  async function executed(commandId: string) {
    const deadline = Date.now() + 35_000
    while (Date.now() < deadline) {
      const { events: window } = await loadHistory(2000)
      const receipt = window.findLast((e) => e.type === 'command.status' && e.payload.command_id === commandId)
      if (receipt?.payload.status === 'executed') return
      if (receipt?.payload.status === 'failed' || receipt?.payload.status === 'expired') {
        throw new Error(String(receipt.payload.error ?? receipt.payload.status))
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    throw new Error(t('devices.unconfirmed'))
  }

  async function submitAnswers(questions: Record<string, any>[]) {
    if (sending) return
    sending = true
    error = ''
    try {
      for (const [index, q] of questions.entries()) {
        const receipt = await sendCommand('answer', {
          question_id: q.question_id,
          choice_index: selections[q.question_id],
          submit: index === questions.length - 1,
        })
        if (receipt.command_id && receipt.status !== 'executed') await executed(receipt.command_id)
      }
      void refresh()
    } catch (e) {
      error = String(e)
    } finally {
      sending = false
    }
  }

  function openRename() {
    renameDraft = sessionTitle
    renameOpen = true
  }

  async function rename() {
    const title = renameDraft.trim()
    if (!title || title === sessionTitle) {
      renameOpen = false
      return
    }
    sending = true
    error = ''
    try {
      const receipt = await sendCommand('rename', { title })
      if (receipt.command_id && receipt.status !== 'executed') {
        await executed(receipt.command_id)
      }
      localTitle = title
      renameOpen = false
      onChanged?.()
    } catch (e) {
      error = String(e)
    } finally {
      sending = false
    }
  }

  async function remove() {
    if (deleting) return
    deleting = true
    error = ''
    try {
      const receipt = await sendCommand('delete')
      if (receipt.command_id && receipt.status !== 'executed') {
        await executed(receipt.command_id)
      }
      deleteOpen = false
      onChanged?.()
      onClose()
    } catch (e) {
      error = String(e)
      deleting = false
    }
  }

  function relaySender(relay: Record<string, any>): string {
    return sessionNameFor(relay.from_session, sessions) ?? tr('devices.relay.unknownSession')
  }
  function relayTarget(relay: Record<string, any>): string {
    return sessionNameFor(relay.session_id, sessions) ?? tr('devices.relay.unknownSession')
  }
  function deliveryLabel(payload: Record<string, any>): string {
    if (payload.status === 'error') return tr('devices.tool.failed')
    if (!payload.status || ['running', 'pending', 'in_progress'].includes(payload.status)) return tr('devices.tool.running')
    const delivery = relayDelivery(payload)
    return delivery ? t('devices.tool.delivery', { status: delivery }) : tr('devices.tool.returned')
  }
</script>

<section class="device-session" aria-label={t('devices.sessionLabel', { device: device.name, session: sessionTitle })}>
  <header>
    <Icon name="monitor" size={14} />
    <div class="heading">
      {#if renameOpen}
        <form
          class="rename"
          onsubmit={(event) => {
            event.preventDefault()
            void rename()
          }}
        >
          <input bind:value={renameDraft} maxlength="200" aria-label={tr('devices.renameLabel')} />
          <button type="submit" disabled={sending} title={tr('devices.renameSave')} aria-label={tr('devices.renameSave')}>
            <Icon name="check" size={13} />
          </button>
          <button type="button" disabled={sending} title={tr('devices.cancel')} aria-label={tr('devices.cancel')} onclick={() => (renameOpen = false)}>
            <Icon name="x" size={13} />
          </button>
        </form>
      {:else}
        <strong>{sessionTitle}</strong>
      {/if}
      <span>{device.name} · {session.cwd}</span>
    </div>
    <span class="status {status}">{tr(`devices.status.${['busy', 'idle', 'starting', 'exited'].includes(status) ? status : 'idle'}`)}</span>
    <button class="icon" title={tr('devices.rename')} aria-label={tr('devices.rename')} onclick={openRename}>
      <Icon name="pencil" size={14} />
    </button>
    <button class="icon danger" title={tr('devices.delete')} aria-label={tr('devices.delete')} onclick={() => (deleteOpen = true)}>
      <Icon name="trash-2" size={14} />
    </button>
    <button class="icon" title={tr('devices.close')} aria-label={tr('devices.close')} onclick={onClose}>
      <Icon name="x" size={14} />
    </button>
  </header>

  <div class="transcript" bind:this={transcript} onscroll={onScroll}>
    {#if !loaded}
      <p class="muted center">{tr('devices.loading')}</p>
    {:else if items.length === 0}
      <p class="muted center">{tr('devices.emptyHistory')}</p>
    {/if}
    {#each items as item (item.key)}
      {@const p = item.payload}
      {#if item.type === 'message' && p.relay}
        <article class="relay">
          <div class="relay-head"><strong>{relaySender(p.relay)}</strong> → {sessionTitle}</div>
          <span class="muted small">{p.relay.reply_to ? tr('devices.relay.replied') : tr('devices.relay.sent')}</span>
          <div class="content">{p.relay.content}</div>
        </article>
      {:else if item.type === 'message'}
        <article class:user={p.role === 'user'}>
          <strong>{p.role === 'user' ? tr('devices.you') : agentName}</strong>
          <div class="content">{p.text}</div>
        </article>
      {:else if item.type === 'tool_use' && p.relay_tool}
        <article class="relay">
          <div class="relay-head">
            <strong>{tr(relayToolTitleKey(p.relay_tool))}</strong>
            {#if p.relay_tool.session_id} → {relayTarget(p.relay_tool)}{/if}
          </div>
          <span class="muted small" class:error-text={p.status === 'error'}>{deliveryLabel(p)}</span>
          {#if p.relay_tool.content}<div class="content">{p.relay_tool.content}</div>{/if}
        </article>
      {:else if item.type === 'tool_use'}
        <details class="tool">
          <summary><span class="tool-name">{p.tool ?? p.name ?? 'Tool'}</span> <span class="muted">{p.input_summary ?? ''}</span> <span class="tool-status {p.status ?? 'running'}">{p.status ?? 'running'}</span></summary>
          {#if p.output_preview}<pre>{typeof p.output_preview === 'string' ? p.output_preview : JSON.stringify(p.output_preview, null, 2)}</pre>{/if}
        </details>
      {:else if item.type === 'ask_user_question'}
        {@const questions = item.questions ?? [p]}
        {@const answerable = questions.every((q) => q.question_id && !q.multi_select && q.options?.length)}
        <article class="ask">
          {#each questions as q (q.question_id ?? q.request_id)}
            <strong>{q.header ?? tr('devices.question')}</strong>
            <p>{q.question}</p>
            {#if item.pending && !exited}
              {#if q.request_id && q.options?.some((o: any) => o.option_id)}
                <div class="actions">
                  {#each q.options as option}
                    <button disabled={sending} onclick={() => command('answer', { request_id: q.request_id, response: { optionId: option.option_id } })}>{option.label}</button>
                  {/each}
                </div>
              {:else if answerable}
                <div class="actions" role="radiogroup" aria-label={q.question}>
                  {#each q.options as option, index}
                    <button
                      role="radio"
                      aria-checked={selections[q.question_id] === index}
                      class:selected={selections[q.question_id] === index}
                      disabled={sending}
                      title={option.description ?? ''}
                      onclick={() => (selections[q.question_id] = index)}
                    >{option.label}</button>
                  {/each}
                </div>
              {/if}
            {/if}
          {/each}
          {#if !item.pending || exited}
            <p class="muted small">{tr('devices.answered')}</p>
          {:else if answerable}
            <div class="actions">
              <button
                class="primary"
                disabled={sending || questions.some((q) => selections[q.question_id] === undefined)}
                onclick={() => submitAnswers(questions)}
              >{questions.length > 1 ? tr('devices.submitAll') : tr('devices.submit')}</button>
            </div>
          {:else if !questions.some((q) => q.request_id)}
            <p class="muted small">{tr('devices.answerOnDevice')}</p>
          {/if}
        </article>
      {:else if item.type === 'plan_proposed'}
        <article class="ask">
          <strong>{tr('devices.plan')}</strong>
          <div class="content">{p.plan_md}</div>
          {#if item.pending && !exited}
            <div class="actions">
              <button disabled={sending} onclick={() => command('plan_response', { plan_id: p.plan_id, accept: true })}>{tr('devices.accept')}</button>
              <button disabled={sending} onclick={() => command('plan_response', { plan_id: p.plan_id, accept: false })}>{tr('devices.reject')}</button>
            </div>
          {/if}
        </article>
      {/if}
    {/each}
  </div>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <form class="composer" onsubmit={(e) => { e.preventDefault(); void send() }}>
    <textarea
      bind:value={draft}
      onkeydown={onComposerKey}
      disabled={exited}
      placeholder={exited ? tr('devices.exited') : t('devices.placeholder', { device: device.name })}
      aria-label={t('devices.placeholder', { device: device.name })}
    ></textarea>
    {#if busy}
      <button type="button" disabled={sending} onclick={() => command('interrupt')}>{tr('devices.stop')}</button>
    {/if}
    <button type="submit" class="primary" disabled={sending || exited || !draft.trim()}>{tr('devices.send')}</button>
  </form>
</section>

{#if deleteOpen}
  <ConfirmDialog
    title={tr('devices.deleteTitle')}
    message={tr('devices.deleteMessage', { title: sessionTitle })}
    confirmLabel={tr('devices.deleteConfirm')}
    cancelLabel={tr('devices.cancel')}
    danger
    onConfirm={remove}
    onClose={() => { if (!deleting) deleteOpen = false }}
  />
{/if}

<style>
  .device-session { position: absolute; inset: 0; bottom: var(--bottom-terminal-h, 0px); z-index: 2; display: flex; flex-direction: column; padding-top: 44px; color: var(--fg-primary); background: var(--bg-base); font: var(--fs-md) var(--font-ui); }
  header { display: flex; align-items: center; gap: 10px; padding: 8px 20px; border-bottom: 1px solid var(--bd-default); color: var(--fg-secondary); }
  .heading { display: grid; flex: 1; min-width: 0; }
  .heading strong { overflow: hidden; color: var(--fg-primary); text-overflow: ellipsis; white-space: nowrap; }
  .heading span { overflow: hidden; color: var(--fg-tertiary); font-size: var(--fs-xs); text-overflow: ellipsis; white-space: nowrap; }
  .rename { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .rename input { flex: 1; min-width: 0; height: 26px; padding: 0 7px; border: 1px solid var(--bd-focus); border-radius: var(--rad-sm); background: var(--bg-input); color: var(--fg-primary); font: var(--fs-sm) var(--font-ui); outline: none; }
  .status { padding: 2px 8px; border-radius: 999px; background: var(--bg-chip); font-size: var(--fs-xs); }
  .status.busy { color: var(--st-busy); }
  .status.idle { color: var(--st-ok); }
  .status.exited { color: var(--fg-tertiary); }
  .transcript { flex: 1; min-height: 0; overflow: auto; padding: 20px; }
  article, details.tool { max-width: 860px; margin: 0 auto 12px; padding: 12px 16px; border: 1px solid var(--bd-default); border-radius: var(--rad-lg); background: var(--bg-card); }
  article.user { background: var(--bg-base); }
  article.relay { border-color: var(--acc-soft); background: var(--bg-base); }
  article.ask { border-color: var(--st-warn); }
  .relay-head { margin-bottom: 2px; }
  .content { margin-top: 8px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  details.tool { padding: 8px 16px; color: var(--fg-secondary); font-size: var(--fs-sm); }
  summary { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
  .tool-name { color: var(--fg-primary); font-weight: 600; }
  .tool-status.ok { color: var(--st-ok); }
  .tool-status.error { color: var(--st-err); }
  pre { max-height: 320px; overflow: auto; margin: 8px 0 0; padding: 10px; border-radius: var(--rad-sm); background: var(--bg-pre); font: var(--fs-xs) var(--font-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
  .muted { color: var(--fg-tertiary); }
  .small { font-size: var(--fs-xs); }
  .center { text-align: center; }
  .error-text { color: var(--st-err); }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  button { padding: 6px 14px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-card); color: var(--fg-primary); font: inherit; font-size: var(--fs-sm); cursor: pointer; }
  button:hover:not(:disabled) { background: var(--bg-hover); }
  button:disabled { opacity: .5; cursor: default; }
  button.icon { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; background: transparent; }
  button.icon.danger:hover:not(:disabled) { color: var(--st-err); }
  button.selected { border-color: var(--acc); background: var(--acc-soft); }
  button.primary { border-color: var(--acc); background: var(--acc); color: var(--fg-on-accent); }
  button:focus-visible, textarea:focus-visible { outline: 2px solid var(--bd-focus); outline-offset: 2px; }
  .error { margin: 0; padding: 6px 20px; color: var(--st-err); font-size: var(--fs-sm); }
  .composer { display: flex; align-items: flex-end; gap: 8px; padding: 12px 20px; border-top: 1px solid var(--bd-default); }
  textarea { flex: 1; min-height: 44px; max-height: 200px; padding: 10px 12px; border: 1px solid var(--bd-default); border-radius: var(--rad-md); background: var(--bg-input); color: inherit; font: inherit; resize: vertical; }
</style>
