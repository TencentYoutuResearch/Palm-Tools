<script lang="ts">
  import codebuddy from '../../assets/backend-icons/codebuddy.png';
  import claudecode from '../../assets/backend-icons/claudecode.png';
  import codex from '../../assets/backend-icons/codex.png';
  import gemini from '../../assets/backend-icons/gemini.png';
  import cursor from '../../assets/backend-icons/cursor.png';
  import githubcopilot from '../../assets/backend-icons/githubcopilot.png';
  import grok from '../../assets/backend-icons/grok.png';
  import kimi from '../../assets/backend-icons/kimi.png';
  import kiro from '../../assets/backend-icons/kiro.png';
  import amp from '../../assets/backend-icons/amp.png';
  import antigravity from '../../assets/backend-icons/antigravity.png';
  import droid from '../../assets/backend-icons/droid.png';
  import pi from '../../assets/backend-icons/pi.png';
  import opencode from '../../assets/backend-icons/opencode.png';

  interface Props {
    backendKey?: string | null;
  }
  let { backendKey }: Props = $props();

  interface IconDef {
    src: string;
  }

  const ICONS: Record<string, IconDef> = {
    codebuddy: { src: codebuddy },
    claude: { src: claudecode },
    'claude-code': { src: claudecode },
    claudecode: { src: claudecode },
    codex: { src: codex },
    gemini: { src: gemini },
    cursor: { src: cursor },
    'cursor-agent': { src: cursor },
    copilot: { src: githubcopilot },
    'github-copilot': { src: githubcopilot },
    githubcopilot: { src: githubcopilot },
    grok: { src: grok },
    kimi: { src: kimi },
    kiro: { src: kiro },
    'kiro-cli': { src: kiro },
    amp: { src: amp },
    antigravity: { src: antigravity },
    agy: { src: antigravity },
    droid: { src: droid },
    pi: { src: pi },
    opencode: { src: opencode },
  };

  function lookup(key: string): IconDef | null {
    const k = key.trim().toLowerCase();
    if (!k) return null;
    const base = k.split(/[\\/]/).pop() ?? k;
    const compact = base.replace(/\.(cmd|exe|sh|zsh|bash)$/, '').replace(/[_\s]+/g, '-');
    const candidates = [compact, compact.replace(/-internal$/, ''), compact.replace(/-cli$/, '')];
    for (const c of candidates) {
      if (ICONS[c]) return ICONS[c]!;
    }
    return null;
  }

  function fallbackLabel(key: string): string {
    const parts = key.trim().replace(/[_/\\]+/g, '-').split('-').filter(Boolean);
    if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    return (parts[0] ?? '?').slice(0, 2).toUpperCase();
  }

  const profile = $derived(backendKey ? lookup(backendKey) : null);
  const fallback = $derived(fallbackLabel(backendKey ?? '?'));
</script>

<span class="backend-icon">
  {#if profile}
    <img src={profile.src} alt="" loading="lazy" decoding="async" />
  {:else}
    <span class="fallback">{fallback}</span>
  {/if}
</span>

<style>
  .backend-icon {
    width: 26px;
    height: 26px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    overflow: visible;
  }
  img {
    width: 26px;
    height: 26px;
    display: block;
    object-fit: contain;
  }
  .fallback {
    width: 26px;
    height: 26px;
    border-radius: var(--rad-sm);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: color-mix(in srgb, var(--fg-secondary) 12%, transparent);
    color: var(--fg-secondary);
    font-size: 10px;
    font-weight: var(--fw-semi);
    line-height: 1;
    font-family: var(--font-mono);
    letter-spacing: 0.02em;
  }
</style>
