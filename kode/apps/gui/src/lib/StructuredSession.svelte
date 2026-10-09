<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { listen, type UnlistenFn } from '@tauri-apps/api/event'
  import { currentLocale, t } from './i18n'
  const tr = (key: string) => { $currentLocale; return t(key) }
  type Event = { type: string; ts: number; payload: Record<string, any> }
  let { sessionId, visible }: { sessionId: number; visible: boolean } = $props()
  let events: Event[] = $state([]), draft = $state(''), sending = $state(false), error = $state('')
  let answered: string[] = $state([])
  let values: Record<string, Record<string, any>> = $state({})
  let custom: Record<string, boolean> = $state({})
  let busy = $derived(events.filter(e => e.type === 'session.status').at(-1)?.payload.status === 'busy')
  let exited = $derived(events.some(e => e.type === 'session.exited'))
  const call = (action: string, payload: Record<string, any> = {}) => invoke<any>('acp_session_action', { id: sessionId, action, payload })
  async function refresh() {
    const history = await call('history') as Event[]
    applyEvents(history)
  }
  function applyEvents(incoming: Event[]) {
    const unique = new Map<string, Event>()
    for (const e of [...events, ...incoming]) {
      const key = e.type + '-' + (e.payload.id ?? e.payload.question_id ?? e.payload.plan_id ?? e.ts)
      const previous = unique.get(key)
      if (!previous || (e.payload.revision ?? e.ts) >= (previous.payload.revision ?? previous.ts)) unique.set(key, e)
      if (e.payload.request_id && e.payload.requested_schema && !values[e.payload.request_id]) {
        values[e.payload.request_id] = Object.fromEntries(Object.entries(e.payload.requested_schema.properties).filter(([, f]) => 'default' in (f as any)).map(([k, f]) => [k, (f as any).default]))
      }
      if (e.type === 'interaction.resolved' && e.payload.request_id && !answered.includes(e.payload.request_id)) answered.push(e.payload.request_id)
    }
    events = [...unique.values()]
  }
  onMount(() => {
    let stopped = false, buffering = true
    let unlisten: UnlistenFn | undefined
    const buffered: Event[] = []
    void (async () => {
      try {
        unlisten = await listen<Event & { session_id: number }>('acp-session-event', ({ payload }) => {
          if (payload.session_id !== sessionId || stopped) return
          if (buffering) buffered.push(payload)
          else applyEvents([payload])
        })
        if (stopped) { unlisten(); return }
        await refresh()
        buffering = false
        applyEvents(buffered)
      } catch (e) { if (!stopped) error = String(e) }
    })()
    return () => { stopped = true; unlisten?.() }
  })
  async function act(action: string, payload: Record<string, any>) {
    if (sending) return false
    sending = true; error = ''
    try { await call(action, payload); try { await refresh() } catch (e) { error = String(e) }; return true }
    catch (e) { error = String(e); return false }
    finally { sending = false }
  }
  async function send() { const text = draft; if (text.trim() && await act('input', { text })) draft = '' }
  function validForm(p: any): boolean {
    const schema = p.requested_schema
    for (const [key, field] of Object.entries(schema.properties) as [string, any][]) {
      const value = values[p.request_id]?.[key]
      const required = schema.required?.includes(key)
      let invalid = required && (value === undefined || value === '')
      if (value !== undefined) {
        if (field.type === 'array') invalid ||= !Array.isArray(value) || value.length < (field.minItems ?? (required ? 1 : 0)) || value.length > (field.maxItems ?? Infinity)
        if (field.type === 'number' || field.type === 'integer') invalid ||= !Number.isFinite(value) || (field.type === 'integer' && !Number.isInteger(value)) || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)
        if (field.type === 'string') invalid ||= typeof value !== 'string' || [...value].length < (field.minLength ?? 0) || [...value].length > (field.maxLength ?? Infinity)
      }
      if (invalid) { error = t('acp.invalidField', {field:field.title ?? key}); document.getElementById(`${p.request_id}-${key}`)?.focus(); return false }
    }
    return true
  }
  async function respond(id: string, response: Record<string, any>) {
    if (await act('respond', { request_id: id, response })) answered = [...answered, id]
  }
  function choices(f: any): {value: string; label: string}[] {
    return f.enum?.map((v: string, i: number) => ({value:v, label:f.enumNames?.[i] ?? v})) ?? f.oneOf?.map((v: any) => ({value:v.const, label:v.title ?? v.const})) ?? []
  }
  function setValue(id: string, key: string, value: any) {
    const next = {...values[id]}; if (value === undefined || value === '') delete next[key]; else next[key] = value; values[id] = next
  }
  function formResponse(p: any, action: string) {
    return p.source === 'acp_questions' ? {decision:action === 'accept' ? 'allow' : 'deny', ...(action === 'accept' ? {content:values[p.request_id]} : {})} : {action, ...(action === 'accept' ? {content:values[p.request_id]} : {})}
  }
</script>
<section class="structured-session" aria-hidden={!visible} aria-label={tr('acp.conversation')}>
  <div class="transcript">
    {#each events.filter(e => ['message','ask_user_question','plan_proposed','system'].includes(e.type)) as e (e.type + '-' + (e.payload.id ?? e.payload.question_id ?? e.payload.plan_id ?? e.ts))}
      {@const p = e.payload}
      {#if e.type === 'message'}
        <article class:user={p.role === 'user'}><strong>{p.role === 'user' ? tr('acp.you') : 'CodeBuddy'}</strong><div class="content">{p.text}</div></article>
      {:else if e.type === 'system'}<p class="muted">{p.text}</p>
      {:else if e.type === 'plan_proposed'}
        <article><strong>{tr('acp.plan')}</strong><div class="content">{p.plan_md || tr('acp.noPlan')}</div><div class="actions">
          <button disabled={sending || exited || answered.includes(p.plan_id)} onclick={() => respond(p.plan_id,{decision:'allow'})}>{tr('acp.accept')}</button>
          <button disabled={sending || exited || answered.includes(p.plan_id)} onclick={() => respond(p.plan_id,{decision:'deny'})}>{tr('acp.reject')}</button></div></article>
      {:else if p.source === 'acp_permission'}
        <article><strong>CodeBuddy · {tr('acp.permission')}</strong><p>{p.question}</p><pre>{p.context}</pre><div class="actions">
          {#each p.options as option}<button disabled={sending || exited || answered.includes(p.request_id)} onclick={() => respond(p.request_id,{optionId:option.option_id})}>{option.label}</button>{/each}</div></article>
      {:else if p.requested_schema}
        <article><strong>CodeBuddy · {tr('acp.question')}</strong><p>{p.question}</p>
          <form novalidate onsubmit={(e) => {e.preventDefault(); if (validForm(p)) void respond(p.request_id,formResponse(p,'accept'))}}><fieldset disabled={sending || exited || answered.includes(p.request_id)}>
            {#each Object.entries(p.requested_schema.properties) as [key, field] (key)}
              {@const f = field as any}{@const required = p.requested_schema.required?.includes(key)}
              <label for={`${p.request_id}-${key}`}>{f.title ?? key}{required ? ' *' : ''}</label>
              {#if f.description}<p class="muted">{f.description}</p>{/if}
              {#if f.type === 'array'}
                <div class="actions">{#each choices(f.items) as option}<label class="check"><input type="checkbox" checked={values[p.request_id]?.[key]?.includes(option.value) ?? false} onchange={(e) => {
                  const selected: string[] = values[p.request_id]?.[key] ?? []
                  setValue(p.request_id,key,e.currentTarget.checked ? [...selected,option.value] : selected.filter(v => v !== option.value))
                }} />{option.label}</label>{/each}</div>
              {:else if f.type === 'boolean' || choices(f).length}
                <select id={`${p.request_id}-${key}`} required={required} value={custom[`${p.request_id}-${key}`] ? '__custom__' : (values[p.request_id]?.[key] === undefined ? '' : `option:${values[p.request_id][key]}`)} onchange={(e) => {
                  const v = e.currentTarget.value; custom[`${p.request_id}-${key}`] = f.allow_custom && v === '__custom__'
                  setValue(p.request_id,key,v === '__custom__' ? undefined : f.type === 'boolean' ? (v === '' ? undefined : v === 'option:true') : v === '' ? undefined : v.slice(7))
                }}><option value="">{tr('acp.choose')}</option>
                  {#if f.type === 'boolean'}<option value="option:true">{tr('acp.yes')}</option><option value="option:false">{tr('acp.no')}</option>
                  {:else}{#each choices(f) as o}<option value={`option:${o.value}`}>{o.label}</option>{/each}{/if}
                  {#if f.allow_custom}<option value="__custom__">{tr('acp.custom')}</option>{/if}</select>
                {#if custom[`${p.request_id}-${key}`]}<textarea class="resize-none" required value={values[p.request_id]?.[key] ?? ''} aria-label={tr('acp.custom')} oninput={(e) => setValue(p.request_id,key,e.currentTarget.value)}></textarea>{/if}
              {:else if f.type === 'number' || f.type === 'integer'}
                <input id={`${p.request_id}-${key}`} type="number" step={f.type === 'integer' ? 1 : 'any'} min={f.minimum} max={f.maximum} required={required} value={values[p.request_id]?.[key] ?? ''} oninput={(e) => setValue(p.request_id,key,e.currentTarget.value === '' ? undefined : Number(e.currentTarget.value))} />
              {:else}<textarea class="resize-none" id={`${p.request_id}-${key}`} required={required} minlength={f.minLength} maxlength={f.maxLength} value={values[p.request_id]?.[key] ?? ''} oninput={(e) => setValue(p.request_id,key,e.currentTarget.value)}></textarea>{/if}
            {/each}
            <div class="actions"><button type="submit">{tr('acp.submit')}</button><button type="button" onclick={() => respond(p.request_id,formResponse(p,'decline'))}>{tr('acp.decline')}</button><button type="button" onclick={() => respond(p.request_id,formResponse(p,'cancel'))}>{tr('acp.cancel')}</button></div>
          </fieldset></form></article>
      {/if}
    {/each}
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <form novalidate class="composer" onsubmit={(e) => {e.preventDefault(); void send()}}><textarea class="resize-none" bind:value={draft} aria-label={tr('acp.message')} placeholder={tr('acp.message')} disabled={exited}></textarea>
    <button type="submit" disabled={sending || busy || exited || !draft.trim()}>{tr('acp.send')}</button>{#if busy}<button type="button" disabled={sending} onclick={() => void act('interrupt',{})}>{tr('acp.stop')}</button>{/if}</form>
</section>
<style>
  .structured-session {height:100%;display:flex;flex-direction:column;color:var(--fg-primary);background:var(--bg-primary)}
  .transcript {flex:1;min-height:0;overflow:auto;padding:24px}
  article {max-width:900px;margin:0 auto 20px;padding:20px;border:1px solid var(--bd-default);border-radius:16px;background:var(--bg-secondary)}
  article.user {background:var(--bg-primary)}
  .content {white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6;margin-top:12px}
  pre {max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;padding:12px;border:1px solid var(--bd-default);border-radius:8px}
  fieldset {border:0;padding:0;min-width:0} label {display:block;margin:16px 0 8px} .check {display:flex;align-items:center;gap:8px}
  textarea,select,input[type=number] {width:100%;box-sizing:border-box;padding:12px;border:1px solid var(--bd-default);border-radius:8px;color:inherit;background:var(--bg-primary);font:inherit}
  textarea.resize-none {resize: none;min-height:100px;overflow:auto} button {padding:10px 16px;border:1px solid var(--bd-default);border-radius:10px;color:inherit;background:var(--bg-secondary);cursor:pointer}
  button:disabled {opacity:.5;cursor:default} button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible {outline:2px solid var(--accent);outline-offset:2px}
  .actions {display:flex;flex-wrap:wrap;gap:10px;margin-top:16px} .muted {opacity:.75;line-height:1.5} .error {padding:0 24px;color:var(--st-danger)}
  .composer {display:flex;align-items:center;gap:12px;padding:16px 24px;border-top:1px solid var(--bd-default)}
</style>
