<script lang="ts">
  import Icon from './shared/Icon.svelte';
  import { activeModule, type ModuleId } from '../lib/stores/layout.ts';
  import { cycleTheme, theme } from '../lib/theme.ts';
  import { t } from '../lib/i18n.ts';

  const items: { id: ModuleId; labelKey: string; icon: string }[] = [
    { id: 'iwiki', labelKey: 'specops.rail.documents', icon: 'iwiki' },
    { id: 'chat', labelKey: 'specops.rail.sessions', icon: 'chat' },
  ];
</script>

<nav class="rail">
  <!-- Top strip aligned with macOS traffic lights height.
       The lights overlay the top-left of this strip; it is a drag region. -->
  <div class="rail-top" data-tauri-drag-region></div>

  <div class="rail-items">
    {#each items as item (item.id)}
      <button
        class="rail-item"
        class:active={$activeModule === item.id}
        onclick={() => activeModule.set(item.id)}
        aria-label={t(item.labelKey)}
      >
        <span class="icon-wrap">
          <Icon name={item.icon} size={20} />
        </span>
        <span class="label">{t(item.labelKey)}</span>
      </button>
    {/each}
  </div>

  <div class="rail-foot">
    <button
      class="rail-tool"
      onclick={() => theme.set(cycleTheme($theme))}
      aria-label={t('specops.rail.theme')}
      title={t('specops.rail.theme')}
    >
      <Icon name="theme" size={16} />
    </button>
  </div>
</nav>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    /* 78px: matches the narrowed root grid column. Still wide enough for the
       macOS traffic-light cluster to overlay the top strip cleanly. */
    width: 78px;
    background: var(--bg-sidebar);
    border-right: 1px solid var(--bd-default);
    flex-shrink: 0;
    height: 100%;
    min-height: 0;
  }
  /* Reserved top strip that aligns with the macOS traffic-light height. */
  .rail-top {
    flex-shrink: 0;
    height: 44px;
    -webkit-app-region: drag;
    user-select: none;
    -webkit-user-select: none;
  }
  .rail-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--sp-1);
  }
  .rail-item {
    /* Slack-like: icon on top, label below. Tightened for the 78px column. */
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: var(--sp-1) 0;
    border-radius: var(--rad-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--fg-secondary);
    transition:
      background var(--t-fast),
      color var(--t-fast),
      border-color var(--t-fast);
    min-height: 46px;
    justify-content: center;
  }
  .icon-wrap {
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 0;
  }
  .rail-item:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
  .rail-item.active {
    background: var(--acc-soft);
    color: var(--acc);
    border-color: color-mix(in srgb, var(--acc) 30%, transparent);
  }
  .label {
    /* Truncate to fit 78px width even for the longest label ("iwiki"). */
    font-size: 9px;
    font-weight: var(--fw-med);
    letter-spacing: 0.01em;
    line-height: 1;
    max-width: 56px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail-foot {
    margin-top: auto;
    padding: var(--sp-1);
    display: flex;
    justify-content: center;
  }
  .rail-tool {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--rad-md);
    border: 1px solid transparent;
    background: transparent;
    color: var(--fg-secondary);
    transition: background var(--t-fast), color var(--t-fast);
  }
  .rail-tool:hover {
    background: var(--bg-tab-hover);
    color: var(--fg-primary);
  }
</style>
