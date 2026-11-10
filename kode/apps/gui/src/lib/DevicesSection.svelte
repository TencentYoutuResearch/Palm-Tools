<script lang="ts">
  /**
   * Sidebar list of the account's other desktops and their sessions.
   *
   * The device list is cheap (no viewing lease) and refreshes every 30 s.
   * Listing a device's sessions extends that desktop's viewing lease and makes
   * it stream, so sessions load only for expanded devices, and only while
   * the window is visible.
   */
  import { onMount } from 'svelte'
  import { ipc, type AccountDevice, type AccountDeviceSession } from './ipc'
  import Icon from './Icon.svelte'
  import { currentLocale, t } from './i18n'

  type Props = {
    active: { deviceId: string; sessionId: number } | null
    onOpen: (device: AccountDevice, session: AccountDeviceSession, sessions: AccountDeviceSession[]) => void
  }
  let { active, onOpen }: Props = $props()
  let tr = $derived.by(() => {
    void $currentLocale
    return t
  })

  let devices = $state<AccountDevice[]>([])
  let collapsed = $state(false)
  let expanded = $state<Record<string, boolean>>({})
  let sessions = $state<Record<string, AccountDeviceSession[]>>({})
  let errors = $state<Record<string, string>>({})
  let loading = $state<Record<string, boolean>>({})

  async function loadDevices() {
    try {
      const reply = await ipc.accountDevices()
      devices = reply.devices.filter((d) => d.device_id !== reply.self_device_id)
    } catch {
      // Offline or signed out: keep the last list; the section hides when empty.
    }
  }

  async function loadSessions(deviceId: string) {
    loading[deviceId] = true
    try {
      sessions[deviceId] = (await ipc.accountDeviceSessions(deviceId)).sessions
      delete errors[deviceId]
    } catch (e) {
      errors[deviceId] = String(e)
    } finally {
      loading[deviceId] = false
    }
  }

  function toggle(device: AccountDevice) {
    expanded[device.device_id] = !expanded[device.device_id]
    if (expanded[device.device_id] && device.online) void loadSessions(device.device_id)
  }

  onMount(() => {
    void loadDevices()
    const timer = setInterval(() => {
      if (document.hidden) return
      void loadDevices()
      for (const device of devices) {
        if (expanded[device.device_id] && device.online) void loadSessions(device.device_id)
      }
    }, 30_000)
    return () => clearInterval(timer)
  })

  function title(session: AccountDeviceSession): string {
    return session.title?.trim() || session.backend_key
  }
</script>

{#if devices.length > 0}
  <section class="devices" aria-label={tr('devices.title')}>
    <button class="section-header" aria-expanded={!collapsed} onclick={() => (collapsed = !collapsed)}>
      <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
      <span>{tr('devices.title')}</span>
      <span class="count">{devices.filter((d) => d.online).length}/{devices.length}</span>
    </button>
    {#if !collapsed}
      <div class="device-list">
        {#each devices as device (device.device_id)}
          <button
            class="device"
            class:offline={!device.online}
            aria-expanded={Boolean(expanded[device.device_id])}
            title={device.online ? device.name : tr('devices.offline')}
            onclick={() => toggle(device)}
          >
            <Icon name={expanded[device.device_id] ? 'chevron-down' : 'chevron-right'} size={12} />
            <Icon name="monitor" size={13} />
            <span class="name">{device.name}</span>
            <span class="dot" class:on={device.online} aria-label={device.online ? tr('devices.online') : tr('devices.offline')}></span>
          </button>
          {#if expanded[device.device_id]}
            <div class="sessions">
              {#if !device.online}
                <p class="hint">{tr('devices.offlineHint')}</p>
              {:else if errors[device.device_id]}
                <p class="hint error" title={errors[device.device_id]}>{tr('devices.loadFailed')}</p>
              {:else if loading[device.device_id] && !sessions[device.device_id]}
                <p class="hint">{tr('devices.loading')}</p>
              {:else if (sessions[device.device_id] ?? []).length === 0}
                <p class="hint">{tr('devices.noSessions')}</p>
              {:else}
                {#each sessions[device.device_id] ?? [] as session (session.id)}
                  <button
                    class="session"
                    class:active={active?.deviceId === device.device_id && active.sessionId === session.id}
                    title={`${title(session)} · ${session.cwd}`}
                    onclick={() => onOpen(device, session, sessions[device.device_id] ?? [])}
                  >
                    <span class="status {session.status}"></span>
                    <span class="name">{title(session)}</span>
                    <span class="backend">{session.backend_key}</span>
                  </button>
                {/each}
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .devices { flex-shrink: 0; max-height: 40%; overflow-y: auto; padding: 4px 7px 6px; border-top: 1px solid var(--bd-default); scrollbar-width: thin; }
  button { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 28px; padding: 0 8px; border: 0; border-radius: var(--rad-sm); background: transparent; color: var(--fg-secondary); font: var(--fs-sm) var(--font-ui); text-align: left; cursor: pointer; }
  button:hover, button:focus-visible { background: var(--bg-tab-hover); color: var(--fg-primary); outline: none; }
  .section-header { color: var(--fg-tertiary); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .count { margin-left: auto; font-weight: 400; }
  .device.offline { color: var(--fg-tertiary); }
  .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-tertiary); opacity: .5; }
  .dot.on { background: var(--st-ok); opacity: 1; }
  .sessions { padding-left: 18px; }
  .session.active { background: var(--bg-tab-active); color: var(--fg-primary); }
  .status { width: 6px; height: 6px; flex: 0 0 auto; border-radius: 50%; background: var(--fg-tertiary); }
  .status.busy { background: var(--st-busy); }
  .status.idle { background: var(--st-ok); }
  .backend { flex: 0 0 auto; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .hint { margin: 4px 8px; color: var(--fg-tertiary); font-size: var(--fs-xs); }
  .hint.error { color: var(--st-err); }
</style>
