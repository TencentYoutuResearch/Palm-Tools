<script lang="ts">
  import AvatarSprite from './AvatarSprite.svelte'
  import Icon from './Icon.svelte'
  import { avatarLibrary, findGalleryAvatar, resolveBannerCss, type AvatarStatus } from './avatars'
  import type { BotRecord } from './ipc'

  export type BotEntry = {
    bot: BotRecord
    active: boolean
    status: AvatarStatus
    sessionCount: number
  }

  type Props = {
    entries: BotEntry[]
    compact?: boolean
    canManage?: boolean
    onSelect: (bot: BotRecord) => void
    onManage?: () => void
  }

  let { entries, compact = false, canManage = false, onSelect, onManage }: Props = $props()
  let collapsed = $state(false)
</script>

{#if entries.length > 0}
  <section class="bot-nest" class:compact aria-label="伙伴">
    {#if !compact}
      <div class="bot-nest-head">
        <button
          type="button"
          class="bot-nest-toggle"
          aria-expanded={!collapsed}
          onclick={() => (collapsed = !collapsed)}
        >
          <span class="bot-nest-chevron">
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />
          </span>
          <span class="bot-nest-title">伙伴</span>
          <span class="bot-nest-count">{entries.length}</span>
        </button>
        {#if canManage && onManage}
          <button
            type="button"
            class="bot-nest-manage"
            title="管理伙伴"
            aria-label="管理伙伴"
            onclick={onManage}
          >
            <Icon name="settings" size={12} />
          </button>
        {/if}
      </div>
    {/if}

    {#if compact || !collapsed}
      <div class="bot-list">
        {#each entries as entry (entry.bot.id)}
          {@const gallerySet = findGalleryAvatar($avatarLibrary, entry.bot.avatar)}
          {@const banner = resolveBannerCss(entry.bot.banner, gallerySet)}
          <button
            type="button"
            class="bot-card"
            class:active={entry.active}
            class:has-banner={!!banner}
            title={entry.bot.tagline ? `${entry.bot.name} · ${entry.bot.tagline}` : entry.bot.name}
            onclick={() => onSelect(entry.bot)}
          >
            {#if !compact && banner}
              <span
                class="bot-card-bg"
                style={banner.image
                  ? `background-image: url("${banner.image}")`
                  : `background: ${banner.background}`}
                aria-hidden="true"
              ></span>
              <span class="bot-card-scrim" aria-hidden="true"></span>
            {/if}

            <span class="bot-avatar-wrap">
              <AvatarSprite
                label={entry.bot.name}
                compact={compact}
                status={entry.status}
                avatarId={entry.bot.avatar ?? null}
                backendKey={entry.bot.backend_key}
              />
              <span
                class="bot-dot"
                class:running={entry.status === 'running'}
                class:awaiting={entry.status === 'awaiting'}
                aria-hidden="true"
              ></span>
            </span>

            {#if !compact}
              <span class="bot-meta">
                <span class="bot-name-row">
                  <span class="bot-name">{entry.bot.name}</span>
                  {#if entry.sessionCount > 1}
                    <span class="bot-sessions">{entry.sessionCount}</span>
                  {/if}
                </span>
                <span class="bot-sub">
                  {entry.bot.tagline?.trim() || entry.bot.backend_key}
                </span>
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .bot-nest {
    padding: 4px 8px 8px;
    border-bottom: 1px solid var(--border-subtle, rgba(128, 128, 128, 0.14));
    margin-bottom: 6px;
  }
  .bot-nest.compact {
    padding: 4px 4px 8px;
  }
  .bot-nest-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px 6px;
    gap: 4px;
  }
  .bot-nest-toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    background: none;
    border: none;
    color: var(--text-muted, #8b949e);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    cursor: pointer;
    padding: 2px 4px;
    border-radius: 5px;
  }
  .bot-nest-toggle:hover {
    color: var(--text-primary, inherit);
    background: var(--bg-hover, rgba(128, 128, 128, 0.12));
  }
  .bot-nest-chevron {
    display: inline-flex;
    opacity: 0.7;
  }
  .bot-nest-count {
    font-size: 10px;
    opacity: 0.7;
    font-variant-numeric: tabular-nums;
  }
  .bot-nest-manage {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-muted, #8b949e);
    cursor: pointer;
  }
  .bot-nest-manage:hover {
    color: var(--text-primary, inherit);
    background: var(--bg-hover, rgba(128, 128, 128, 0.14));
  }
  .bot-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .bot-card {
    position: relative;
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    padding: 7px 9px;
    border-radius: 10px;
    border: 1px solid transparent;
    background: transparent;
    color: var(--text-primary, inherit);
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    transition: background 140ms ease, border-color 140ms ease, transform 120ms ease;
  }
  .bot-nest.compact .bot-card {
    justify-content: center;
    padding: 5px;
  }
  .bot-card:hover {
    background: var(--bg-hover, rgba(128, 128, 128, 0.12));
  }
  .bot-card.active {
    border-color: color-mix(in srgb, var(--accent, #5b8def) 55%, transparent);
    background: color-mix(in srgb, var(--accent, #5b8def) 14%, transparent);
  }
  .bot-card.has-banner {
    border-color: rgba(255, 255, 255, 0.08);
  }
  .bot-card-bg {
    position: absolute;
    inset: 0;
    background-size: cover;
    background-position: center;
    opacity: 0.34;
    pointer-events: none;
    transition: opacity 150ms ease;
  }
  .bot-card:hover .bot-card-bg,
  .bot-card.active .bot-card-bg {
    opacity: 0.48;
  }
  .bot-card-scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      color-mix(in srgb, var(--bg-sidebar, #16181d) 82%, transparent) 0%,
      color-mix(in srgb, var(--bg-sidebar, #16181d) 58%, transparent) 55%,
      color-mix(in srgb, var(--bg-sidebar, #16181d) 36%, transparent) 100%
    );
    pointer-events: none;
  }
  .bot-avatar-wrap {
    position: relative;
    z-index: 1;
    display: inline-flex;
    flex-shrink: 0;
  }
  .bot-dot {
    position: absolute;
    right: -1px;
    bottom: -1px;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    border: 1.5px solid var(--bg-sidebar, #16181d);
    background: #6b7280;
  }
  .bot-dot.running {
    background: #22c55e;
  }
  .bot-dot.awaiting {
    background: #f59e0b;
  }
  .bot-meta {
    position: relative;
    z-index: 1;
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .bot-name-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .bot-name {
    font-size: 12.5px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bot-sessions {
    font-size: 10px;
    font-weight: 600;
    padding: 0 5px;
    border-radius: 999px;
    background: rgba(128, 128, 128, 0.2);
    color: var(--text-muted, #9ca3af);
    flex-shrink: 0;
  }
  .bot-sub {
    font-size: 11px;
    color: var(--text-muted, #8b949e);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
