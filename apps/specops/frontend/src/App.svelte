<script lang="ts">
  import { onMount } from 'svelte';
  import Rail from './components/Rail.svelte';
  import StatusBar from './components/StatusBar.svelte';
  import IwikiModule from './components/iwiki/IwikiModule.svelte';
  import ChatModule from './components/chat/ChatModule.svelte';
  import { activeModule } from './lib/stores/layout.ts';
  import { loadState, pendingDocSelection } from './lib/stores/documents.ts';
  import { loadSessions, subscribeEvents, unsubscribeEvents } from './lib/stores/sessions.ts';

  let health = $state<'connecting' | 'ok' | 'error'>('connecting');

  onMount(() => {
    void loadState();
    void loadSessions();
    subscribeEvents();
    health = 'ok';
    return () => unsubscribeEvents();
  });

  // Cross-module navigation: when chat requests "View document", switch to iwiki
  $effect(() => {
    const target = $pendingDocSelection;
    if (target) {
      activeModule.set('iwiki');
    }
  });
</script>

<div class="root">
  <Rail />
  <main class="module-container">
    {#if $activeModule === 'iwiki'}
      <IwikiModule />
    {:else}
      <ChatModule />
    {/if}
  </main>
  <StatusBar />
</div>

<style>
  .module-container {
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    /* Fill the grid cell so child .module can height:100% */
    display: flex;
  }
  .module-container > :global(*) {
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
  }
</style>
