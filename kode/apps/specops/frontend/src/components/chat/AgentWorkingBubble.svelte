<script lang="ts">
  import BackendIcon from '../shared/BackendIcon.svelte';

  interface Props {
    backendKey?: string | null;
  }

  let { backendKey = null }: Props = $props();
</script>

<div class="working" role="status" aria-live="polite" aria-label="Agent is working">
  <div class="avatar" aria-hidden="true">
    <BackendIcon {backendKey} />
  </div>
  <div class="typing-bubble">
    <span class="dot dot-1"></span>
    <span class="dot dot-2"></span>
    <span class="dot dot-3"></span>
    <span class="label">Agent is working</span>
  </div>
</div>

<style>
  .working {
    display: flex;
    align-items: center;
    gap: var(--sp-3);
    width: 100%;
    padding: var(--sp-2) var(--sp-4);
    animation: working-in var(--t-base) cubic-bezier(0.2, 0, 0, 1) both;
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    overflow: hidden;
    background: var(--bg-chip);
  }
  .typing-bubble {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 var(--sp-3);
    border: 1px solid var(--bd-muted);
    border-radius: 18px 18px 18px 6px;
    background: var(--bg-elevated);
    color: var(--fg-tertiary);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    background: var(--st-busy);
    animation: typing-step 1.2s ease-in-out infinite;
  }
  .dot-2 { animation-delay: 0.14s; }
  .dot-3 { animation-delay: 0.28s; }
  .label {
    margin-left: var(--sp-1);
    font-size: var(--fs-xs);
    color: var(--fg-tertiary);
  }
  @keyframes typing-step {
    0%, 55%, 100% { transform: translateY(0); }
    28% { transform: translateY(-3px); }
  }
  @keyframes working-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @media (prefers-reduced-motion: reduce) {
    .working,
    .dot { animation: none; }
  }
</style>
