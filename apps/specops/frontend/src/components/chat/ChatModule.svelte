<script lang="ts">
  import Resizer from '../Resizer.svelte';
  import SessionList from './SessionList.svelte';
  import ChatHeader from './ChatHeader.svelte';
  import ChatThread from './ChatThread.svelte';
  import Composer from './Composer.svelte';
  import ProgressPanel from './ProgressPanel.svelte';
  import PanelToggle from '../shared/PanelToggle.svelte';
  import {
    chatLeftWidth,
    chatRightWidth,
    chatRightOpen,
  } from '../../lib/stores/layout.ts';
  import { t } from '../../lib/i18n.ts';
</script>

<section
  class="module chat-layout"
  class:right-open={$chatRightOpen}
  style="--col-left: {$chatLeftWidth}px; --col-right: {$chatRightOpen ? $chatRightWidth : 0}px;"
>
  <aside class="panel panel-left">
    <SessionList />
  </aside>

  <Resizer store={chatLeftWidth} min={200} max={420} side="left" />

  <section class="panel panel-mid chat-mid">
    <ChatHeader />
    <div class="thread-scroll">
      <ChatThread />
    </div>
    <Composer />
  </section>

  <Resizer store={chatRightWidth} min={240} max={480} side="right" />

  <aside class="panel panel-right" class:collapsed={!$chatRightOpen}>
    <ProgressPanel />
  </aside>

  <!-- Pinned to the module's top-right corner (not inside .panel-mid, whose
       overflow:auto would clip it). Stays in the same spot open or closed. -->
  <PanelToggle
    open={$chatRightOpen}
    label={t('Toggle progress panel')}
    side="right"
    onclick={() => chatRightOpen.set(!$chatRightOpen)}
  />
</section>

<style>
  .chat-mid {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    overflow: hidden;
    /* Slack-style: the message area sits on the base background, not the
       sidebar tone, so the composer card reads as floating on top. */
    background: var(--bg-base);
  }
  /* Scroll container wraps ChatThread so the thread content can have its own
     inner max-width (centered message column) without affecting the scroll. */
  .thread-scroll {
    display: flex;
    flex: 1 1 auto;
    min-height: 0;
  }
  .panel-right.collapsed {
    display: none;
  }
</style>
