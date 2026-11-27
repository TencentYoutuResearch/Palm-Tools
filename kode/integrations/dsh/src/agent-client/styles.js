    const style = document.createElement('style')
    style.textContent = `
.kode-conversation-navigation{display:grid;grid-template:minmax(0,1fr)/minmax(0,1fr);height:100%;min-height:0;min-width:0}
.kode-conversation-body,.kode-conversation-loading{grid-area:1/1;min-height:0;min-width:0}
.kode-conversation-body[aria-busy=true]{visibility:hidden}
.kode-conversation-loading{display:flex;align-items:center;justify-content:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}
.kode-conversation-loading>svg{animation:kode-loading-spin 850ms linear infinite}
@keyframes kode-loading-spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.kode-conversation-loading>svg{animation:none}.kode-relay-toggle>svg,.kode-tool-heading>svg{transition:none}}
.kode-review-symbol{position:relative;display:inline-flex}
/* Status corner: a 10px dot cut out of the glyph by a ring of panel background; the mark is badge artwork, independent of the host's panel SVG sizing. */
[data-review-status]{position:absolute;right:-3px;bottom:-2px;display:grid;place-items:center;width:10px;height:10px;box-sizing:border-box;padding:0;border-radius:50%;corner-shape:round;background:var(--kode-review-fill);box-shadow:0 0 0 1.5px var(--kode-badge-gap,var(--dsw-alias-bg-layer-1));font-size:0}
[data-review-status]::after{content:'';width:6px;height:6px;background:center / contain no-repeat var(--kode-review-glyph,none)}
[data-review-status=open]{--kode-review-fill:#1a7f37}
[data-review-status=draft]{--kode-review-fill:#6e7781;--kode-review-glyph:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6 6' fill='none' stroke='white' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='3' cy='3' r='1.6' stroke-width='1.2'/%3E%3C/svg%3E")}
[data-review-status=merged]{--kode-review-fill:#8250df;--kode-review-glyph:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6 6' fill='none' stroke='white' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M.9 3.2l1.4 1.4L5.1 1.5' stroke-width='1.3'/%3E%3C/svg%3E")}
[data-review-status=closed]{--kode-review-fill:#cf222e;--kode-review-glyph:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 6 6' fill='none' stroke='white' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M1.2 1.2l3.6 3.6M4.8 1.2L1.2 4.8' stroke-width='1.3'/%3E%3C/svg%3E")}
body[data-ds-dark-theme] [data-review-status=open]{--kode-review-fill:#3fb950}body[data-ds-dark-theme] [data-review-status=draft]{--kode-review-fill:#7d8590}body[data-ds-dark-theme] [data-review-status=merged]{--kode-review-fill:#a371f7}body[data-ds-dark-theme] [data-review-status=closed]{--kode-review-fill:#f85149}
.kode-panel-link{color:inherit;text-decoration:none}
@media(hover:hover){[data-session-panel-row]:has(>.kode-panel-link):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.kode-panel-link:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;border-radius:var(--dsw-radius-sm)}
[data-kode-panel-row]:has(>button[aria-expanded=true])>[data-row-part=trailing]{transform:rotate(180deg)}
/* Kode's own card lists keep one line per item: the detail trails the title and the disclosure still shows everything. */
[data-kode-panel-row][data-kode-compact] [data-row-part=lines]{flex-direction:row;align-items:baseline;gap:6px}
[data-kode-panel-row][data-kode-compact] [data-row-part=content]{flex:0 1 auto}
[data-kode-panel-row][data-kode-compact] [data-row-part=content]{min-width:2em}
.kode-sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.kode-relay-icon{position:relative;display:inline-flex;color:var(--dsw-alias-label-secondary)}
.kode-panel-meta{color:var(--dsw-alias-label-tertiary)}
[data-kode-panel-row][data-kode-compact] [data-row-part=detail]{flex:1 1 0;min-width:0}
[data-kode-panel-row][data-kode-compact] [data-row-part=detail]:has(>.kode-relay-peer){flex:0 1 auto;min-width:min(7em,45%);max-width:55%;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-relay-direction{color:var(--dsw-alias-label-tertiary)}
.kode-panel-detail{display:grid;gap:6px;padding:2px 8px 8px 32px;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);min-width:0}
[data-kode-panel-row] [data-row-part=icon]:has(>.kode-agent-avatar){width:auto;height:auto;flex:none}
[data-kode-panel-row] .kode-agent-avatar{position:relative;overflow:visible}
[data-kode-panel-row] [data-row-part=lines]{min-width:0}
[data-kode-panel-row] [data-row-part=content],[data-kode-panel-row] [data-row-part=detail]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-session-identity{display:grid;min-width:0;padding:4px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin-bottom:2px}
.kode-environment-identity{display:flex;align-items:center;gap:4px;min-width:0;container-type:inline-size}
.kode-environment-identity>[data-kode-panel-row]{flex:1;min-width:0}
.kode-environment-identity [data-row-part=content]{font-weight:600}
.kode-environment-handoff{flex:none}
@container(max-width:256px){.kode-environment-handoff-label{display:none}}
.kode-environment-project{min-width:0;margin-top:4px}
.kode-environment-project[data-git]{display:grid;gap:0}
.kode-environment-project[data-git] [data-session-panel-project] [data-row-part=content]{font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-environment-git{display:grid;grid-template-columns:16px minmax(0,1fr);align-items:center;gap:8px;min-height:28px;padding:2px 6px;box-sizing:border-box;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}
@media(hover:hover){.kode-environment-git:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.kode-environment-git:has(code:focus-visible){outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.kode-environment-git>svg{margin:0 auto}
.kode-environment-ref{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 8px;min-width:0}
.kode-environment-ref code{display:block;flex:1 1 10ch;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px;line-height:18px}
.kode-environment-ref code:focus-visible{outline:none}
.kode-environment-kind{padding:0 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover);font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kode-environment-project[data-git=worktree] .kode-environment-kind{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent);color:var(--dsw-alias-label-primary)}
.kode-panel-detail>p{margin:0;overflow-wrap:anywhere}
.kode-panel-markdown{min-width:0;max-block-size:12rem;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.kode-panel-markdown>[data-markdown-variant]{min-width:0}
.kode-panel-detail .kode-panel-markdown>[data-markdown-variant]{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.kode-panel-markdown pre{max-width:100%;overflow:auto}
.kode-panel-markdown :not(pre)>code{overflow-wrap:anywhere}
@media(max-width:520px){.kode-panel-detail{padding-inline-start:8px}.kode-panel-markdown{max-block-size:8rem}}
.kode-subagent-trigger{gap:5px;padding-inline:6px;font-variant-numeric:tabular-nums}
.kode-subagent-menu-item{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:220px}
.kode-subagent-menu-item>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-subagent-status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
.kode-subagent-section h4{margin:16px 0 6px;font-size:13px}
.kode-subagent-section>p{margin:0;overflow-wrap:anywhere}
.kode-subagent-section .kode-panel-markdown{max-block-size:min(40vh,24rem)}
.kode-subagent-section .kode-panel-markdown>[data-markdown-variant]{color:var(--dsw-alias-label-primary)}
.kode-subagent-section .kode-native-output{margin:0}
.kode-branch-trigger{box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;min-height:40px;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.kode-branch-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-branch-trigger:disabled{opacity:.5;cursor:default}
.kode-branch-trigger:focus-visible,.kode-branch-option:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-branch-popup{width:min(440px,calc(100vw - 24px));padding:0!important}
.kode-branch-search{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);position:sticky;top:0;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);z-index:1}
.kode-branch-search input{min-width:0;flex:1;border:0;padding:3px 0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.kode-branch-search:focus-within{box-shadow:inset 0 -2px var(--dsw-focus-ring-color)}
.kode-branch-results{max-height:280px;overflow-y:auto;padding:4px;scrollbar-width:thin}
.kode-branch-option{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;padding:9px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}
.kode-branch-option>span{display:flex;flex-direction:column;gap:3px;min-width:0}
.kode-branch-name{font-size:13px;overflow-wrap:anywhere}
.kode-branch-option small{font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kode-branch-option:hover,.kode-branch-option[aria-checked=true]{background:var(--dsw-alias-interactive-bg-hover)}
.kode-branch-option[aria-checked=true]>svg{color:var(--dsw-alias-label-primary-bluish);flex-shrink:0}
.kode-branch-empty{margin:0;padding:24px 12px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.kode-native-input{display:block;margin:8px 0 8px 22px;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;font-family:var(--ds-font-family-code);font-size:12px}
.kode-native-output{padding:12px 0 4px;margin:0 0 0 22px;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-family:var(--ds-font-family-code);font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary)}
.kode-internal-stack{display:flex;flex-direction:column;gap:8px;min-width:0}
.kode-internal-message{min-width:0;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-turn-trigger-bg,var(--dsw-alias-markdown-code-block));font-size:var(--dsh-content-font-size,14px);color:var(--dsw-alias-label-secondary)}
.kode-internal-message>summary{display:flex;align-items:center;gap:8px;min-width:0;cursor:pointer;list-style:none;padding:12px 16px;font-size:13px}
.kode-internal-message>summary::-webkit-details-marker{display:none}
.kode-internal-message>summary:hover{background:var(--dsw-alias-interactive-bg-hover);border-radius:inherit}
.kode-internal-title{color:var(--dsw-alias-label-primary);flex-shrink:0}
.kode-internal-hint{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;color:var(--dsw-alias-label-tertiary);flex:1}
.kode-internal-message>summary>svg{flex-shrink:0}
.kode-internal-chevron{margin-left:auto}
.kode-internal-message[open]>summary>.kode-internal-chevron{transform:rotate(180deg)}
.kode-internal-message summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-internal-body{padding:12px 16px 16px;min-width:0;overflow-wrap:anywhere}
.kode-internal-body>dl{margin:0;display:flex;flex-direction:column;gap:6px;font-size:13px}
.kode-internal-body>dl>div{display:flex;gap:12px;min-width:0;flex-wrap:wrap}
.kode-internal-body dt{min-width:64px;color:var(--dsw-alias-label-tertiary)}
.kode-internal-body dd{margin:0;min-width:0;flex:1;overflow-wrap:anywhere}
[class*="hoverContent"]:has(.kode-unknown-time)>[class*="hoverTime"]{display:none}
.kode-unknown-time{font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-unified-workspaces{flex:1;min-height:0;display:flex;flex-direction:column}
.kode-navigation-error{position:fixed;bottom:24px;left:50%;padding:12px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-state-error-primary);z-index:100}
.kode-remote-computer{display:inline-block;flex-shrink:0;background:currentColor;mask-size:contain;mask-repeat:no-repeat;mask-position:center;-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center}
.kode-project-source{padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);display:flex;flex-wrap:wrap;justify-content:center;gap:12px}
.kode-project-path{width:100%;overflow-wrap:anywhere;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.kode-hero-controls{flex-wrap:wrap;column-gap:6px;row-gap:4px}
.kode-hero-controls>button,.kode-hero-controls>.kode-mode-control{flex:0 1 auto;min-width:0;max-width:100%;white-space:nowrap}
.kode-hero-controls>.kode-mode-control{display:inline-flex}
.kode-hero-controls .kode-trigger{max-width:100%;white-space:nowrap;flex-shrink:0}
.kode-hero-controls .kode-trigger>svg,.kode-hero-controls .kode-trigger>.kode-hub-settings .kode-agent-row-head{flex-wrap:wrap}
[data-composer-seat]>:has(.kode-goal-bar){row-gap:0}
.kode-goal-bar{--kode-goal-state-color:var(--dsw-alias-label-secondary);box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));margin:0 auto -1px;padding:0 var(--dsh-composer-dock-inset);flex:none;font-size:13px;color:var(--dsw-alias-label-primary)}
.kode-goal-panel{display:flex;flex-wrap:wrap;align-items:center;gap:8px;box-sizing:border-box;width:100%;min-height:36px;padding:4px 12px;border:.5px solid var(--dsw-alias-border-l1);border-bottom:none;border-radius:var(--dsw-radius-lg) var(--dsw-radius-lg) 0 0;background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter)}
.kode-goal-status{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kode-goal-objective{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:0;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer}
.kode-goal-objective:focus-visible{outline:2px solid var(--dsw-focus-ring-color)}
.kode-goal-actions{display:flex;align-items:center;gap:4px;flex:none;margin-left:auto}
.kode-goal-icon{display:grid;place-items:center;box-sizing:border-box;width:28px;height:28px;padding:0;border:0;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.kode-goal-icon:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kode-goal-icon:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:-2px}
.kode-goal-icon:disabled{cursor:default;opacity:.45}
.kode-goal-leading{display:grid;place-items:center;flex:none;color:var(--kode-goal-state-color)}
.kode-goal-bar[data-goal-status=active]{--kode-goal-state-color:var(--dsw-alias-state-business-primary)}
.kode-goal-bar[data-goal-status=complete]{--kode-goal-state-color:var(--dsw-alias-state-success-primary)}
.kode-goal-bar:is([data-goal-status=blocked],[data-goal-status=usageLimited],[data-goal-status=budgetLimited]){--kode-goal-state-color:var(--dsw-alias-state-warning-primary)}
.kode-goal-bar[data-goal-status=active] .kode-goal-panel{border-color:color-mix(in srgb,var(--kode-goal-state-color) 35%,var(--dsw-alias-border-l1))}
.kode-goal-sidebar{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;height:100%;padding:12px;overflow:auto}
.kode-goal-sidebar form{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}
.kode-goal-sidebar textarea{box-sizing:border-box;width:100%;min-height:180px;flex:1;resize:vertical;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.6}
.kode-goal-sidebar form>button{align-self:flex-end}
.kode-goal-bar form{display:flex;flex-wrap:wrap;align-items:end;gap:8px;width:100%}
.kode-agent-avatar{flex-shrink:0}
.kode-hero-controls .kode-trigger>span:not(.kode-agent-avatar){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-hero-controls>.kode-error{flex-basis:100%;margin:0}
.kode-hero-controls .kode-mode-control>.kode-trigger{flex-shrink:1}
@media(max-width:600px){.kode-hero-controls{row-gap:4px;column-gap:6px}.kode-hero-controls>button,.kode-hero-controls .kode-trigger{height:auto;min-height:44px;padding-inline:8px}.kode-hero-controls>.kode-agent-trigger{max-width:100%}}
.kode-host-location{gap:6px;padding:0 8px;white-space:nowrap}
.kode-workspace-menu{width:min(400px,calc(100vw - 32px));max-width:calc(100vw - 32px)}
.kode-workspace-search{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.kode-workspace-search input{font:inherit;color:var(--dsw-alias-label-primary);background:transparent;border:0;outline:none;min-width:0;width:100%}
.kode-workspace-search:focus-within{box-shadow:inset 0 -2px var(--dsw-focus-ring-color)}
.kode-workspace-caption{font-size:12px;color:var(--dsw-alias-label-secondary);padding:10px 12px 4px}
.kode-workspace-option{display:flex;flex-direction:column;gap:3px;min-width:0;max-width:310px}
.kode-workspace-option>span,.kode-workspace-option small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-workspace-option small{font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-relay{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:12px 16px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:13px;min-width:0}
.kode-relay-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-relay-heading strong{font-weight:500;overflow-wrap:anywhere;min-width:0;max-width:100%}
.kode-relay-heading time{margin-left:auto;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-relay-source{display:flex;align-items:center;gap:10px;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow-wrap:anywhere}
.kode-relay summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;padding:4px 0}
.kode-relay:has(>.kode-relay-toggle){padding:0}
.kode-relay-toggle{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;column-gap:8px;row-gap:2px;width:100%;min-width:0;padding:8px 12px;border:0;border-radius:inherit;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
@media(hover:hover){.kode-relay-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.kode-relay-toggle .kode-relay-heading{flex-wrap:nowrap;min-width:0}
.kode-relay-toggle .kode-relay-heading>strong{flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-relay-toggle .kode-relay-heading>*{flex-shrink:0}
.kode-relay-toggle .kode-relay-heading>strong{flex-shrink:1}
.kode-relay-failed{grid-area:1/2;display:inline-flex}
.kode-relay-toggle>svg{grid-area:1/3;color:var(--dsw-alias-label-tertiary);transition:transform 160ms ease}
.kode-relay[data-open] .kode-relay-toggle>svg,.kode-message-tool .kode-tool-heading[aria-expanded=true]>svg:last-child{transform:rotate(180deg)}
.kode-relay-title{display:block;grid-column:1/-1;margin:0;padding-left:24px;font-weight:600;overflow-wrap:anywhere}
.kode-relay-detail{padding:0 12px 10px 36px}
.kode-relay-detail>.kode-panel-meta{margin:0 0 4px;font-size:12px}
.kode-relay-detail>.kode-relay-body{margin:0}
.kode-tool-target.kode-relay-title{color:var(--dsw-alias-label-primary);font-size:13px}
.kode-relay-body{max-block-size:320px}
.kode-relay-body>[data-markdown-variant]{color:var(--dsw-alias-label-primary)}
[data-step-process-body]{--dsh-chat-flow-gap:2px}
[data-step-process-content][data-chat-flow]>:not([hidden]):not(:empty)~:not([hidden]):not(:empty){margin-top:2px}
[data-step-process-content] .kode-message-tool{padding-block:0}
[data-step-process-content] .kode-tool-heading{padding-block:2px;min-height:26px}
[data-chat-running]{padding-block:4px;font-variant-numeric:tabular-nums}
[data-chat-running]>[aria-hidden=true]{display:none}
.kode-message-tool{min-width:0;font-size:13px;padding:4px 0}
.kode-tool-heading{display:flex;align-items:center;gap:8px;flex-wrap:wrap;cursor:pointer;background:none;border:0;color:var(--dsw-alias-label-primary);padding:4px 0;font:inherit;text-align:left}
.kode-tool-target{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:normal;overflow-wrap:anywhere;line-height:1.6;padding-left:22px}
.kode-tool-detail{padding-left:22px}
.kode-relay button:focus-visible,.kode-relay summary:focus-visible,.kode-tool-heading:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:240px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:transparent;border:0;align-items:center;gap:4px;padding:0 4px 0 8px;font:inherit;font-size:13px;line-height:20px;display:inline-flex}
.kode-trigger>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-trigger svg{flex:none}
.kode-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.kode-trigger:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.kode-agent-trigger{color:var(--dsw-alias-label-primary)}
.kode-chevron-open{transform:rotate(180deg)}
.kode-unified-workspaces [data-kode-status-avatar]{position:relative;width:20px;height:20px;flex:0 0 20px}
.kode-unified-workspaces [data-kode-status-avatar]>[data-state]{visibility:hidden}
.kode-unified-workspaces [data-kode-status-avatar]>[data-state] *{animation:none}
.kode-status-avatar-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none}
.kode-status-avatar-body{display:inline-flex;position:relative;width:20px;height:20px;flex:none}
/* Session state: a 1.5px ring over a fixed 1px gap around the circular face, plus a corner dot that notches face and ring locally.
   Awaiting is dashed ring + hollow dot so color is not the only cue; running only fades, nothing grows. */
.kode-agent-avatar-face{position:absolute;inset:-2.5px;box-sizing:border-box;padding:1px;border:1.5px solid transparent;border-radius:50%}
.kode-agent-avatar-art{position:relative;display:flex;align-items:center;justify-content:center;width:100%;height:100%;overflow:hidden;border-radius:50%}
.kode-agent-avatar[data-avatar-artwork=gallery] .kode-agent-avatar-art::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);pointer-events:none}
.kode-agent-avatar[data-avatar-artwork=gallery] img{object-fit:cover;object-position:50% 35%}
/* DSH gives every element a superellipse corner-shape; circles must opt back into round arcs or 50% renders as a squircle. */
.kode-agent-avatar-face,.kode-agent-avatar-art,.kode-agent-avatar-art::after,.kode-agent-avatar-dot{corner-shape:round}
.kode-agent-avatar[data-avatar-state=running]{--kode-avatar-ring:var(--dsw-alias-brand-primary-new-colorprimary-new-color,#4176e6)}
.kode-agent-avatar[data-avatar-state=awaiting]{--kode-avatar-ring:var(--dsw-static-amber-500,#f59e0b)}
.kode-agent-avatar[data-avatar-state=done]{--kode-avatar-ring:var(--dsw-alias-state-success-primary,#22c55e)}
body[data-ds-dark-theme] .kode-agent-avatar[data-avatar-state=awaiting]{--kode-avatar-ring:var(--dsw-static-amber-400,#f7ad31)}
body[data-ds-dark-theme] .kode-agent-avatar[data-avatar-state=done]{--kode-avatar-ring:var(--dsw-alias-state-success-secondary,#4ed17e)}
.kode-agent-avatar[data-avatar-state=running]>.kode-agent-avatar-face,.kode-agent-avatar[data-avatar-state=awaiting]>.kode-agent-avatar-face,.kode-agent-avatar[data-avatar-state=done]>.kode-agent-avatar-face{--kode-avatar-notch:radial-gradient(circle at calc(100% - var(--kode-avatar-dot) / 2 + .5px) calc(100% - var(--kode-avatar-dot) / 2 + .5px),transparent calc(var(--kode-avatar-dot) / 2 + 2px),#000 calc(var(--kode-avatar-dot) / 2 + 2.5px));border-color:var(--kode-avatar-ring);-webkit-mask:var(--kode-avatar-notch);mask:var(--kode-avatar-notch)}
.kode-agent-avatar[data-avatar-state=awaiting]>.kode-agent-avatar-face{border-style:dashed}
.kode-agent-avatar-dot{position:absolute;right:-3px;bottom:-3px;width:var(--kode-avatar-dot);height:var(--kode-avatar-dot);border-radius:50%;background:var(--kode-avatar-ring)}
.kode-agent-avatar[data-avatar-state=awaiting]>.kode-agent-avatar-dot{background:transparent;box-shadow:inset 0 0 0 1.75px var(--kode-avatar-ring)}
.kode-agent-avatar[data-avatar-state=running]>.kode-agent-avatar-face{animation:kode-avatar-ring-fade 2200ms ease-in-out infinite}
.kode-agent-avatar[data-avatar-state=running]>.kode-agent-avatar-dot{animation:kode-avatar-dot-fade 2200ms ease-in-out infinite}
@keyframes kode-avatar-ring-fade{0%,100%{border-color:var(--kode-avatar-ring)}50%{border-color:color-mix(in srgb,var(--kode-avatar-ring) 50%,transparent)}}
@keyframes kode-avatar-dot-fade{0%,100%{opacity:1}50%{opacity:.55}}
.kode-status-avatar-body::after{content:none}
.kode-motion-paused .kode-agent-avatar>.kode-agent-avatar-face,.kode-motion-paused .kode-agent-avatar>.kode-agent-avatar-dot{animation-play-state:paused}
.kode-unified-workspaces [data-kode-workspace-status]{position:relative}
.kode-workspace-status{position:absolute;right:-3px;bottom:-2px;z-index:2;box-sizing:border-box;width:10px;height:10px;border:2px solid var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-base));border-radius:50%}
.kode-workspace-status[data-status=ongoing]{background:#3b82f6;animation:kode-workspace-status-pulse 2000ms ease-in-out infinite}
.kode-workspace-status[data-status=awaiting]{background:#f0bd55;animation:kode-workspace-status-pulse 2000ms ease-in-out infinite}
.kode-workspace-status[data-status=done]{background:#65c799;opacity:.85;animation:kode-workspace-status-pulse 2000ms ease-in-out infinite}
.kode-motion-paused .kode-workspace-status{animation-play-state:paused}
@keyframes kode-workspace-status-pulse{0%,100%{opacity:1}50%{opacity:.55}}
@media(prefers-reduced-motion:reduce){.kode-workspace-status,.kode-agent-avatar[data-avatar-state]>.kode-agent-avatar-face,.kode-agent-avatar[data-avatar-state]>.kode-agent-avatar-dot{animation:none}.kode-workspace-status{opacity:.85}}
.kode-tool-action{flex:none;white-space:nowrap}
.kode-tool-heading{width:100%;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.kode-tool-heading>svg{flex:none}
.kode-tool-terminal{--dsh-content-font-size-secondary:12px;--dsh-content-font-delta-secondary:0px;font-size:12px}
.kode-tool-terminal pre,.kode-tool-terminal code{font-size:12px;line-height:1.5}
.kode-tool-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-status-dot{display:block;flex:none}
.kode-motion-paused .kode-status-dot *{animation-play-state:paused}
@keyframes kode-step-complete{from{opacity:.35;transform:scale(.75)}to{opacity:1;transform:scale(1)}}
.kode-disclosure{margin:16px 0;border-top:1px solid var(--dsw-alias-border-l2);padding-top:4px;font-size:13px}
.kode-disclosure-toggle{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:44px;width:calc(100% + 16px);box-sizing:border-box;padding:10px 8px;margin:0 -8px;cursor:pointer;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-weight:500;line-height:20px;text-align:left}
.kode-disclosure-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-disclosure-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-disclosure-chevron{flex:none;color:var(--dsw-alias-label-secondary);transform:rotate(-90deg);transition:transform 160ms cubic-bezier(.16,1,.3,1)}
.kode-disclosure[data-open=true]>.kode-disclosure-toggle>.kode-disclosure-chevron{transform:rotate(0)}
.kode-disclosure-panel{display:grid;grid-template-rows:0fr;opacity:0;visibility:hidden;transition:grid-template-rows 180ms cubic-bezier(.16,1,.3,1),opacity 120ms ease-out,visibility 0s linear 180ms}
.kode-disclosure[data-open=true]>.kode-disclosure-panel{grid-template-rows:1fr;opacity:1;visibility:visible;transition-delay:0s}
.kode-disclosure-clip{min-height:0;overflow:hidden}
.kode-disclosure-content{display:grid;gap:16px;padding:8px 0 4px}
@media(prefers-reduced-motion:reduce){.kode-status-dot *,.kode-deployment-steps li[data-status=done] .kode-deployment-state{animation:none}.kode-deployment-progress>span,.kode-disclosure-chevron,.kode-disclosure-panel{transition:none}}
.kode-worktree-trigger{gap:6px;white-space:nowrap}
.kode-worktree-base{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;margin:0 0 20px;font-size:13px;color:var(--dsw-alias-label-secondary)}
.kode-worktree-base strong{font-weight:500;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.kode-worktree-base code{font-family:var(--ds-font-family-code);font-size:12px}
.kode-resume-list{display:flex;flex-direction:column;gap:8px;max-height:50vh;overflow:auto;padding:4px}
.kode-resume-list button{display:flex;flex:0 0 auto;flex-direction:column;align-items:flex-start;justify-content:center;gap:4px;width:100%;height:auto;min-height:60px;padding:10px 12px;text-align:left;white-space:normal;line-height:1.4}
.kode-resume-list button>span,.kode-resume-list small{display:block;max-width:100%;overflow-wrap:anywhere}
.kode-resume-list small{font-size:12px;line-height:1.4;color:var(--dsw-alias-label-secondary)}
.kode-session-avatar-button{display:inline-flex;align-items:center;justify-content:center;padding:2px;background:transparent;color:inherit;border:0;border-radius:6px;cursor:pointer}
.kode-session-avatar-button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-session-avatar-button:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-unified-workspaces:has([data-row-key^="workspace:"]) [data-row-key^="session:"]{padding-inline-start:calc(24px + var(--dsh-workspace-indent,0px))}
.kode-console-output{min-width:0;overflow:hidden;margin-top:8px}
.kode-agent-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;color:var(--dsw-alias-label-primary)}
.kode-agent-mask{display:block;width:100%;height:100%;background:currentColor;mask-size:contain;mask-repeat:no-repeat;mask-position:center;-webkit-mask-size:contain;-webkit-mask-repeat:no-repeat;-webkit-mask-position:center}
.kode-agent-avatar img{display:block;width:100%;height:100%;object-fit:contain}
.kode-agent-identity,.kode-agent-option{display:inline-flex;align-items:center;gap:8px;min-width:0}
.kode-agent-identity{max-width:200px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-agent-identity>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
span:has(>[data-slot="conversation.session.header.lineage"])>span:first-child{max-width:100%;font-size:16px;font-weight:600;line-height:24px}
nav[aria-label="会话层级"]{flex:1 1 auto;min-width:0}
nav[aria-label="会话层级"]~div:has(>[data-slot="conversation.session.header.actions"]){margin-left:auto;padding-left:16px}
.kode-agent-option>.kode-option{flex:1}
.kode-option{display:flex;align-items:center;justify-content:space-between;gap:24px;min-width:200px}
.kode-secondary{color:var(--dsw-alias-label-tertiary);font-size:12px}
.kode-menu-note{padding:8px 12px;max-width:260px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.kode-agent-settings{max-width:720px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.kode-agent-settings h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
.kode-agent-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}
.kode-agent-name{font-size:14px;font-weight:500;line-height:22px;overflow-wrap:anywhere;min-width:0}
.kode-agent-tag{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);padding:1px 6px;font-size:11px;line-height:16px;flex-shrink:0}
.kode-agent-models{min-width:0}
.kode-shared-conversation{display:flex;flex-direction:column;min-height:0;height:100%;color:var(--dsw-alias-label-primary)}
.kode-shared-conversation>header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-shared-conversation>header p{margin:4px 0 0}
.kode-shared-messages{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:16px;padding:24px}
.kode-shared-composer{padding:16px 24px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-shared-composer>div:last-child{display:flex;justify-content:flex-end;gap:8px}
.kode-config-form{min-width:0}
.kode-error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);margin:4px 0}
.kode-model-control{position:relative;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kode-model-control>.kode-error{position:absolute;bottom:32px;right:0;min-width:240px;padding:8px;background:var(--dsw-alias-bg-module-platform);border-radius:var(--dsw-radius-md)}
.kode-mode-control{display:inline-flex;align-items:center;position:relative}
@media(max-width:600px){.kode-option{min-width:180px}.kode-trigger{max-width:180px}.kode-agent-identity{max-width:32px}.kode-agent-identity>span:last-child{display:none}}
`
    style.textContent += `
[data-conversation-content][data-kode-scene]{
  --kode-scene-opacity:24%;
  --kode-scene-scrim:color-mix(in srgb,var(--dsw-alias-bg-base),transparent var(--kode-scene-opacity));
  background-image:linear-gradient(var(--kode-scene-scrim),var(--kode-scene-scrim)),var(--kode-scene-image,none);
  background-size:cover;
  background-position:center;
}
[data-conversation-content]:has(>.kode-scene-video){position:relative;isolation:isolate}
.kode-scene-video{position:absolute;inset:0;z-index:-1;overflow:hidden;pointer-events:none;background:var(--dsw-alias-bg-base);visibility:hidden}
.kode-scene-video:has(video[data-frame-ready]){visibility:visible}
.kode-scene-video>video{display:block;width:100%;height:100%;object-fit:cover;opacity:var(--kode-scene-opacity)}
[data-kode-scene] [data-kode-user-bubble]{background:var(--dsw-specific-bubble,var(--dsw-alias-bg-module-platform));border:.5px solid var(--dsw-alias-border-l2)}
.kode-editable-avatar{display:inline-flex;position:relative;flex:none}
.kode-avatar-edit-mark{position:absolute;right:-6px;bottom:-5px;display:flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:50%;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.kode-agent-settings .kode-session-avatar-button{min-width:40px;min-height:40px;padding:8px}
/* Settings hierarchy: section headings, option labels, then supporting copy. */
.kode-leave-page{display:grid;place-items:center;height:100%;color:var(--dsw-alias-label-secondary)}
.kode-panel-host{width:100%;height:100%}
button:has(.kode-schedules-marker,.kode-plugins-marker)>span[aria-hidden="true"]{position:relative}
button:has(.kode-schedules-marker,.kode-plugins-marker)>span[aria-hidden="true"]>*{visibility:hidden}
button:has(.kode-schedules-marker,.kode-plugins-marker)>span[aria-hidden="true"]::before{content:"";position:absolute;inset:0;background:currentColor;mask:url("data:image/svg+xml,${automationMask}") center/contain no-repeat}
button:has(.kode-plugins-marker)>span[aria-hidden="true"]::before{mask-image:url("data:image/svg+xml,${pluginMask}")}
.kode-bots-glyph{display:inline-flex}.kode-bots-nest{display:block;align-self:stretch;min-width:0}.kode-bots-trailing{display:inline-flex;align-items:center;gap:4px}.kode-bots-collapse{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:6px;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:transform 160ms ease,background 140ms ease}.kode-bots-collapse:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.kode-bots-collapse:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}.kode-bots-collapse[aria-expanded=false]>svg{transform:rotate(-90deg)}
@media(hover:hover){[class*="panelEntry"]:has(.kode-bots-collapse) [class*="panelRow"]{padding-right:38px}[class*="panelEntry"]:has(.kode-bots-collapse):is(:hover,:has(:focus-visible)) [class*="panelTrailing"]:has(.kode-bots-trailing){opacity:1}[class*="panelEntry"]:has(.kode-bots-collapse):not(:hover):not(:has(:focus-visible)) .kode-bots-collapse{opacity:0}}
.kode-bots-title{cursor:pointer}.kode-bots-collapse{transition:transform 160ms ease,background 140ms ease,opacity 140ms ease}
.kode-bots-list{display:flex;flex-direction:column;gap:4px;padding:4px 4px 6px 10px}.kode-bot-row{position:relative;overflow:hidden;display:flex;align-items:center;gap:10px;width:100%;border:.5px solid transparent;background:none;padding:6px 8px;border-radius:10px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;text-align:left;cursor:pointer;transition:background 150ms ease,border-color 150ms ease,transform 140ms ease}.kode-bot-row:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}.kode-bot-item{min-height:46px;padding:6px 10px}.kode-bot-item.has-banner,.kode-bot-nameplate-preview.has-banner{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 70%,transparent);color:var(--dsw-alias-label-primary)}.kode-bot-item.has-banner.is-gradient,.kode-bot-nameplate-preview.has-banner.is-gradient{background:var(--kode-bot-banner-bg)}.kode-bot-item.has-banner.is-image::before,.kode-bot-nameplate-preview.has-banner.is-image::before{content:"";position:absolute;inset:0;background:var(--kode-bot-banner-img) right center/cover no-repeat;opacity:.55;-webkit-mask-image:linear-gradient(90deg,rgba(0,0,0,.18) 0%,rgba(0,0,0,.62) 48%,#000 100%);mask-image:linear-gradient(90deg,rgba(0,0,0,.18) 0%,rgba(0,0,0,.62) 48%,#000 100%);pointer-events:none;transition:opacity 160ms ease}.kode-bot-item.has-banner.is-image:hover::before{opacity:.75}.kode-bot-item.has-banner>*,.kode-bot-nameplate-preview.has-banner>*{position:relative;z-index:1}.kode-bot-avatar-frame{display:inline-flex;align-items:center;justify-content:center;flex:none;padding:2px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 76%,transparent);box-shadow:0 1px 4px rgba(0,0,0,.18)}.kode-bot-meta{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}.kode-bot-sub{font-size:11px;line-height:14px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-bot-item.has-banner .kode-bot-sub{color:color-mix(in srgb,var(--dsw-alias-label-primary) 72%,transparent)}.kode-bot-nameplate-preview-wrap{max-width:280px}.kode-bot-nameplate-preview{min-height:48px;padding:7px 10px;cursor:default}.kode-bot-banner-picker{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.kode-banner-chip{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}.kode-banner-chip[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary,#3d6ff5);box-shadow:0 0 0 1px var(--dsw-alias-state-business-primary,#3d6ff5)}.kode-banner-swatch{border-color:color-mix(in srgb,var(--dsw-alias-border-l2) 80%,transparent);text-shadow:0 1px 2px rgba(0,0,0,.22)}.kode-banner-color input[type=color]{width:16px;height:16px;padding:0;border:0;border-radius:50%;background:none;cursor:pointer}.kode-wecom-card{gap:10px}.kode-wecom-auth-notice{padding:10px 12px;border-radius:var(--dsw-radius-md);border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a12) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a12) 10%,transparent);font-size:12px}.kode-wecom-notice-text{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:inherit;line-height:1.6}.kode-wecom-controls{display:flex;flex-direction:column;gap:10px}.kode-wecom-chats{display:flex;flex-direction:column;gap:8px}.kode-wecom-chats-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-wecom-chats-head>strong{margin-right:auto;font-size:13px}.kode-wecom-chat-chip{display:inline-flex;align-items:center;gap:4px}.kode-wecom-discovered{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.kode-wecom-add-form{display:flex;flex-wrap:wrap;gap:8px}.kode-wecom-add-form input{flex:1 1 160px;min-width:0;height:34px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.kode-bot-row .kode-bot-avatar{width:24px;height:24px;font-size:11px}.kode-bot-avatar-grid{max-height:200px}.kode-bot-scene-preview{position:relative;height:120px;min-height:120px}.kode-bot-scene-preview img{width:100%;height:100%;object-fit:cover}.kode-bot-scene-avatar{position:absolute;left:12px;bottom:10px;display:inline-flex;padding:4px;border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:0 2px 8px rgba(0,0,0,.18)}.kode-bot-card.has-scene{position:relative;overflow:hidden;padding-top:76px}.kode-bot-card.has-scene::before{content:"";position:absolute;inset:0 0 auto 0;height:96px;background:var(--kode-bot-scene) center/cover no-repeat;-webkit-mask-image:linear-gradient(#000 55%,transparent);mask-image:linear-gradient(#000 55%,transparent);pointer-events:none}.kode-bot-card.has-scene>*{position:relative}.kode-bot-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}.kode-bot-tag,.kode-bot-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}.kode-bot-new{color:var(--dsw-alias-label-tertiary)}.kode-bot-line{display:flex;align-items:center;gap:2px}.kode-bot-line>.kode-bot-row{flex:1;min-width:0}.kode-bot-more{flex:none;min-width:20px;height:20px;padding:0 5px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-tertiary);font-size:11px;cursor:pointer}.kode-bot-more:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}.kode-bot-session{padding-left:28px;font-size:12px}.kode-bot-release{flex:none;padding:0 4px;border:0;background:none;color:var(--dsw-alias-label-tertiary);cursor:pointer}.kode-bot-release:hover{color:var(--dsw-alias-label-primary)}.kode-bot-session-kind{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}.kode-bot-asset-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.kode-bot-badge{min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-accent-primary,#3d6ff5);color:#fff;font-size:10px;font-weight:600;line-height:16px;text-align:center}.kode-bot-busy{width:6px;height:6px;border-radius:3px;background:var(--dsw-alias-accent-primary,#3d6ff5);animation:kode-bot-pulse 1.4s ease-in-out infinite}@keyframes kode-bot-pulse{50%{opacity:.3}}.kode-bot-watches{display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l3)}.kode-bot-watches h3{margin:6px 0 0}.kode-watch-list,.kode-run-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}.kode-watch-row{display:flex;align-items:center;gap:10px}.kode-watch-row[data-enabled=false] .kode-watch-text{opacity:.55}.kode-watch-text{flex:1;min-width:0;display:flex;flex-direction:column}.kode-watch-text .kode-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-watch-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.kode-run-row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:6px;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}.kode-run-head{flex:1;min-width:0;display:flex;align-items:center;gap:8px;border:0;background:none;padding:0;color:inherit;font:inherit;text-align:left;cursor:pointer}.kode-run-status{font-size:11px;padding:0 6px;border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}.kode-run-row[data-status=completed] .kode-run-status{color:#2f9e5f}.kode-run-row[data-status=failed] .kode-run-status{color:#d1453b}.kode-run-row[data-status=needs_user] .kode-run-status{color:#c98a12}.kode-run-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-run-new{font-size:10px;color:#fff;background:#d1453b;border-radius:6px;padding:0 5px}.kode-run-body{flex-basis:100%;display:flex;flex-direction:column;gap:4px}.kode-run-body p{margin:0;white-space:pre-wrap;word-break:break-word}.kode-run-trigger{font-size:12px}
.kode-bots-page{padding:24px;box-sizing:border-box;width:100%;margin:0 auto;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}.kode-bot-avatar{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600;flex-shrink:0}.kode-bot-persona{display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}.kode-bot-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-bot-actions>.kode-secondary{margin-right:auto;font-family:ui-monospace,monospace}
.kode-bots-page{max-width:1280px}.kode-bots-hero h2{font-size:20px;line-height:28px}.kode-bots-section{display:flex;flex-direction:column;gap:10px;min-width:0}.kode-bots-section-title{margin:8px 0 0;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kode-bots-roster{position:relative}.kode-bot-rail{display:flex;gap:14px;overflow-x:auto;padding:6px 4px 10px;scrollbar-width:thin}.kode-bot-rail-item{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;width:72px;flex-shrink:0;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.kode-bot-rail-avatar{position:relative;display:grid;place-items:center;width:56px;height:56px;border-radius:50%;background:var(--dsw-alias-bg-module-platform);transition:border-radius .18s ease,transform .18s ease,box-shadow .18s ease}.kode-bot-rail-avatar>*:first-child{border-radius:inherit}.kode-bot-rail-item:hover .kode-bot-rail-avatar,.kode-bot-rail-item[aria-pressed=true] .kode-bot-rail-avatar{border-radius:18px}.kode-bot-rail-item[aria-pressed=true] .kode-bot-rail-avatar{box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary,#5865f2)}.kode-bot-rail-pill{position:absolute;left:50%;bottom:-8px;width:8px;height:4px;margin-left:-4px;border-radius:4px;background:var(--dsw-alias-label-primary);opacity:0;transform:scaleX(.5);transition:all .18s ease}.kode-bot-rail-item:hover .kode-bot-rail-pill{opacity:.5;transform:scaleX(1)}.kode-bot-rail-item[aria-pressed=true] .kode-bot-rail-pill{opacity:1;width:24px;margin-left:-12px;transform:none}.kode-bot-rail-name{max-width:72px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.kode-bot-rail-item[aria-pressed=true] .kode-bot-rail-name{color:var(--dsw-alias-label-primary);font-weight:600}.kode-bot-rail-star{position:absolute;right:-2px;bottom:-2px;display:grid;place-items:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-surface-l1,#1e1f22);color:#f5c542;font-size:11px;box-shadow:0 0 0 2px var(--dsw-alias-bg-surface-l1,#1e1f22)}.kode-bot-rail-avatar>.kode-bot-badge{position:absolute;right:-4px;top:-4px}.kode-bot-rail-add .kode-bot-rail-avatar{color:#23a55a;border:1px dashed var(--dsw-alias-border-l2);box-sizing:border-box}.kode-bot-rail-add:hover .kode-bot-rail-avatar{background:#23a55a;color:#fff;border-color:transparent}
.kode-bot-popover{position:relative;z-index:5;width:min(360px,100%);margin-left:clamp(0px,calc(var(--kode-bot-anchor) - 180px),calc(100% - 360px));border-radius:12px;background:var(--dsw-alias-bg-surface-l1,var(--dsw-alias-bg-module-platform));box-shadow:0 12px 32px rgba(0,0,0,.32),0 0 0 .5px var(--dsw-alias-border-l3);overflow:hidden;animation:kode-bot-pop .14s ease-out}@keyframes kode-bot-pop{from{opacity:0;transform:translateY(-4px)}}.kode-bot-popover.is-floating{position:fixed;z-index:120;margin-left:0;width:min(360px,calc(100vw - 16px));overflow-y:auto;overscroll-behavior:contain;box-shadow:0 16px 40px rgba(0,0,0,.44),0 0 0 .5px var(--dsw-alias-border-l2)}.kode-bot-popover-edit{display:block;cursor:pointer;outline-offset:-2px}.kode-bot-popover-edit:hover .kode-bot-nameplate-name{text-decoration:underline}.kode-bot-popover-actions{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 16px}.kode-bot-popover-actions>*{flex:1 1 auto;justify-content:center}
.kode-bot-nameplate{position:relative;min-width:0}.kode-bot-nameplate-banner{height:72px;background:var(--dsw-alias-bg-module-platform)}.kode-bot-nameplate.has-banner .kode-bot-nameplate-banner{background:var(--kode-bot-scene) center/cover no-repeat}.kode-bot-nameplate-avatar{position:absolute;left:14px;top:30px;padding:4px;border-radius:50%;background:var(--dsw-alias-bg-surface-l1,var(--dsw-alias-bg-module-platform))}.kode-bot-nameplate-body{display:flex;flex-direction:column;gap:8px;padding:46px 16px 14px}.kode-bot-nameplate-name{margin:0;font-size:18px;font-weight:700;line-height:24px}.kode-bot-nameplate-tagline{margin:-4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px}.kode-bot-nameplate-tags{display:flex;flex-wrap:wrap;gap:6px}.kode-bot-nameplate section{display:flex;flex-direction:column;gap:4px;padding-top:8px;border-top:.5px solid var(--dsw-alias-border-l3)}.kode-bot-nameplate h4{margin:0;font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}.kode-bot-nameplate-about{margin:0;display:-webkit-box;-webkit-line-clamp:4;line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap;font-size:13px}.kode-bot-skill-chips{display:flex;flex-wrap:wrap;gap:6px}.kode-bot-skill-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);font-size:12px;line-height:18px}
.kode-bot-templates{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin:0;padding:0;list-style:none}.kode-bot-template{position:relative;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3);transition:transform .15s ease,box-shadow .15s ease}.kode-bot-template:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(0,0,0,.2),0 0 0 .5px var(--dsw-alias-border-l2)}.kode-bot-template-banner{height:56px;background:var(--kode-bot-scene)}.kode-bot-template-glyph{position:absolute;left:12px;top:26px;display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--dsw-alias-bg-surface-l1,#2b2d31);box-shadow:0 0 0 4px var(--dsw-alias-bg-module-platform);font-size:18px;font-weight:700}.kode-bot-template-body{display:flex;flex-direction:column;gap:6px;padding:30px 12px 8px;flex:1}.kode-bot-template-tagline{font-size:12px}.kode-bot-template-actions{display:flex;gap:6px;padding:0 12px 12px}
.kode-bot-create{flex-direction:row;align-items:center;gap:16px;padding:18px 20px;border:1px dashed var(--dsw-alias-border-l2);border-radius:12px}.kode-bot-create-icon{display:grid;place-items:center;width:56px;height:56px;border-radius:18px;background:#23a55a;color:#fff;flex-shrink:0}.kode-bot-create-text{flex:1;min-width:0}.kode-bot-create-text h3{margin:0 0 4px;font-size:16px}.kode-bot-create-text p{margin:0}.kode-bot-start{max-width:520px}
.kode-bot-settings-nav{display:flex;flex-direction:column;gap:2px;flex-shrink:0}.kode-bot-settings-nav>button{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;text-align:left;cursor:pointer}.kode-bot-settings-nav>button:hover{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary)}.kode-bot-settings-nav>button[aria-current=page]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:600}.kode-bot-nav-count{font-size:11px;color:var(--dsw-alias-label-secondary)}.kode-bot-settings-pane{flex:1;min-width:0;display:flex;flex-direction:column}.kode-bot-advanced{display:flex;flex-direction:column;gap:10px}.kode-bot-danger{display:flex;align-items:center;gap:12px;margin-top:12px;padding:12px;border:1px solid color-mix(in srgb,#f23f43 50%,transparent);border-radius:8px}.kode-bot-danger>span{flex:1;display:flex;flex-direction:column;gap:2px}
.kode-segmented{display:inline-flex;gap:2px;padding:2px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);align-self:flex-start}.kode-segmented>button{padding:4px 12px;border:0;border-radius:6px;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}.kode-segmented>button[aria-selected=true]{background:var(--dsw-alias-bg-surface-l1,var(--dsw-alias-bg-module-platform));color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.2)}.kode-skill-search{display:flex;align-items:center;gap:8px;padding:4px 4px 4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}.kode-skill-search input{flex:1;min-width:0;border:0;background:none;color:inherit;font:inherit;outline:none}.kode-skill-categories{flex-wrap:wrap}.kode-skill-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}.kode-skill-card{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-module-platform)}.kode-skill-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 24%,transparent);font-weight:700;flex-shrink:0}.kode-skill-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.kode-skill-desc{display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:12px}.kode-skill-stats{font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-bot-proposal{max-width:380px;margin:8px 0;border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-module-platform);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3)}.kode-bot-proposal.is-loading{display:flex;align-items:center;gap:8px;padding:14px 16px;color:var(--dsw-alias-label-secondary)}.kode-bot-proposal>.kode-config-note,.kode-bot-proposal>.kode-error{margin:0 16px 12px}.kode-bot-proposal-actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:0 16px 16px}
.kode-bot-inbox{padding:14px 16px;border-radius:12px;background:color-mix(in srgb,#f0b232 10%,var(--dsw-alias-bg-module-platform));box-shadow:0 0 0 .5px color-mix(in srgb,#f0b232 40%,transparent)}.kode-inbox-list{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}.kode-inbox-item{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-surface-l1,var(--dsw-alias-bg-module-platform))}.kode-inbox-who{display:flex;align-items:center;gap:6px;font-size:12px}.kode-inbox-text{margin:0;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:6;line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}.kode-inbox-steps{margin:0;padding-left:20px;font-size:13px}.kode-inbox-note,.kode-inbox-draft{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:none;color:inherit;font:inherit}.kode-inbox-draft{resize:vertical}
.kode-bot-settings{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;container-type:inline-size}.kode-bot-settings-head{display:flex;align-items:center;gap:10px;padding:16px clamp(16px,3vw,32px);border-bottom:1px solid var(--dsw-alias-border-l1)}.kode-bot-settings-head>h2{margin:0;font-size:17px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-bot-settings-body{flex:1;min-height:0;display:flex;overflow-y:auto;overscroll-behavior:contain;padding:24px clamp(16px,3vw,32px)}.kode-bot-settings-nav{position:sticky;top:0;align-self:flex-start}.kode-bot-settings-foot{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:12px clamp(16px,3vw,32px);border-top:1px solid var(--dsw-alias-border-l1)}.kode-bot-settings-body{gap:24px}.kode-bot-settings-nav{width:168px}.kode-bot-settings-pane{gap:16px;max-width:1200px}.kode-bot-pane-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:16px;align-items:start}.kode-bot-pane-card{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);min-width:0}.kode-bot-pane-card>h4{margin:0;font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--dsw-alias-label-secondary)}.kode-bot-pane-card .kode-field{margin:0}.kode-bot-run-form{display:flex;flex-direction:column;gap:16px;max-width:640px}.kode-bot-media-field{gap:10px}.kode-bot-asset-previews{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:8px;align-items:stretch}.kode-bot-nameplate-preview-wrap{max-width:none;align-self:center}.kode-bot-scene-preview{height:100%;min-height:96px}.kode-bot-banner-picker{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}.kode-bot-banner-picker .kode-banner-chip{justify-content:center;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-bot-banner-color{justify-content:center}.kode-bot-avatar-grid{grid-template-columns:repeat(auto-fill,minmax(76px,1fr));max-height:min(240px,30vh);gap:6px;padding:2px}.kode-bot-avatar-grid .kode-avatar-choice{padding:6px 4px;gap:4px}.kode-bot-subhead{margin-top:2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}.kode-bot-asset-actions{gap:6px}.kode-bot-settings-pane .kode-bot-actions{margin-top:4px}
.kode-task-board{display:flex;flex-direction:column;gap:12px}.kode-task-columns{display:flex;flex-direction:column;gap:14px}.kode-task-column h4{margin:0 0 6px;font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary)}.kode-task-card{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-module-platform);border-left:3px solid var(--dsw-alias-border-l2)}.kode-task-card[data-status=needs_user]{border-left-color:#f0b232}.kode-task-card[data-status=in_progress]{border-left-color:var(--dsw-alias-state-business-primary,#5865f2)}.kode-task-card[data-status=waiting]{border-left-color:#949ba4}.kode-task-card[data-status=done]{border-left-color:#23a55a;opacity:.75}.kode-task-head{display:flex;align-items:flex-start;gap:8px}.kode-task-head>.kode-agent-name{flex:1}.kode-task-remove{border:0;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:16px}.kode-task-reason{font-size:12px}.kode-task-meta{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.kode-task-meta .kode-field{margin:0;min-width:110px}.kode-agent-tag.is-late{color:#f23f43;border-color:#f23f43}
.kode-bot-routine-picks{display:flex;flex-wrap:wrap;align-items:center;gap:6px}.kode-bot-routine-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px;font-size:13px}.kode-bot-template-routines{font-size:12px}.kode-bot-quiet{display:flex;flex-direction:column;gap:8px}
.kode-bots-hero-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.kode-bots-hero-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-bot-quick-create{display:flex;flex-direction:column;gap:12px;padding:0 18px 18px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);overflow:hidden}.kode-bot-quick-create-band{margin:0 -18px 2px;padding:12px 18px;display:flex;align-items:center;justify-content:space-between;background:var(--kode-bot-scene,linear-gradient(125deg,#5865f2,#7c3aed))}.kode-bot-quick-create-badge{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:12px;background:rgba(255,255,255,.22);color:#fff;font-size:18px;font-weight:700;backdrop-filter:blur(6px)}.kode-bot-quick-create-band .kode-task-remove{color:#fff;opacity:.9}.kode-bot-quick-create-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.kode-bot-quick-create-head h4{margin:0 0 2px;font-size:15px}.kode-bot-quick-create-head p{margin:0;font-size:12px}
.kode-tone-picker{display:flex;flex-direction:column;gap:8px}.kode-tone-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.kode-tone-picker.is-compact .kode-tone-grid{grid-template-columns:repeat(auto-fill,minmax(108px,1fr))}.kode-tone-card{display:flex;flex-direction:column;gap:3px;padding:9px 10px;border:1px solid var(--dsw-alias-border-l3);border-radius:9px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:border-color 140ms ease,background-color 140ms ease}.kode-tone-card strong{font-size:12px;line-height:1.3}.kode-tone-card .kode-secondary{font-size:11px;line-height:1.4}.kode-tone-card:hover{border-color:var(--dsw-alias-state-business-primary,#5865f2)}.kode-tone-card.is-active{border-color:var(--dsw-alias-state-business-primary,#5865f2);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 10%,var(--dsw-alias-bg-base))}.kode-tone-example{margin:0;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-base);border:.5px solid var(--dsw-alias-border-l3);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.kode-tone-example-tag{display:inline-block;margin-right:6px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:700;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 15%,transparent);color:var(--dsw-alias-state-business-primary,#5865f2)}@media (max-width:640px){.kode-tone-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.kode-kanban{display:flex;flex-direction:column;gap:12px}.kode-kanban-header{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}.kode-kanban-header p{margin:2px 0 0;font-size:12px}.kode-kanban-search{display:flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);min-width:200px}.kode-kanban-search input{flex:1;min-width:0;border:0;background:none;color:inherit;font:inherit;font-size:12px;outline:none}
.kode-kanban-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center}.kode-kanban-filter-count{font-size:10px;padding:0 5px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 20%,transparent);color:var(--dsw-alias-label-primary)}
.kode-kanban-add{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-kanban-add>.kode-field{margin:0;min-width:140px}.kode-kanban-add-input{flex:1 1 240px}
.kode-kanban-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:start}
.kode-kanban-col{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:12px;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3);min-height:160px;min-width:0}
.kode-kanban-col.is-amber{background:color-mix(in srgb,#f0b232 7%,var(--dsw-alias-bg-module-platform));border-color:color-mix(in srgb,#f0b232 32%,transparent)}
.kode-kanban-col.is-blue{background:color-mix(in srgb,#3d6ff5 6%,var(--dsw-alias-bg-module-platform));border-color:color-mix(in srgb,#3d6ff5 24%,transparent)}
.kode-kanban-col.is-green{background:color-mix(in srgb,#23a55a 6%,var(--dsw-alias-bg-module-platform));border-color:color-mix(in srgb,#23a55a 24%,transparent)}
.kode-kanban-col-head{display:flex;align-items:center;gap:6px;padding:2px 2px 4px}.kode-kanban-col-head h4{margin:0;font-size:12px;font-weight:700;letter-spacing:.02em;flex:1;min-width:0}
.kode-kanban-col-dot{width:8px;height:8px;border-radius:50%;flex:none;background:#949ba4}.kode-kanban-col.is-amber .kode-kanban-col-dot{background:#f0b232}.kode-kanban-col.is-blue .kode-kanban-col-dot{background:#3d6ff5}.kode-kanban-col.is-green .kode-kanban-col-dot{background:#23a55a}
.kode-kanban-col-count{font-size:11px;font-weight:600;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kode-kanban-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.kode-kanban-empty{margin:auto 0;padding:18px 8px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.kode-kanban-card{display:flex;flex-direction:column;gap:6px;padding:10px;border-radius:9px;background:var(--dsw-alias-bg-surface-l1,var(--dsw-alias-bg-base));box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 .5px var(--dsw-alias-border-l3);min-width:0}
.kode-kanban-card.is-live{box-shadow:0 0 0 1px color-mix(in srgb,#3d6ff5 45%,transparent)}
.kode-kanban-card-head{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}.kode-kanban-who{display:inline-flex;align-items:center;gap:5px;min-width:0;font-weight:500;color:var(--dsw-alias-label-primary)}.kode-kanban-who>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-kanban-time{margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap}
.kode-kanban-pill{display:inline-flex;align-items:center;gap:5px;align-self:flex-start;padding:1px 7px;border-radius:999px;font-size:11px;font-weight:600;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.kode-kanban-pill.is-amber{background:color-mix(in srgb,#f0b232 20%,transparent);color:#c98a12}.kode-kanban-pill.is-blue{background:color-mix(in srgb,#3d6ff5 18%,transparent);color:#3d6ff5}.kode-kanban-pill.is-green{background:color-mix(in srgb,#23a55a 18%,transparent);color:#23a55a}.kode-kanban-pill.is-rose{background:color-mix(in srgb,#f23f43 18%,transparent);color:#f23f43}
.kode-kanban-live-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:kode-bot-pulse 1.4s ease-in-out infinite}
.kode-kanban-title{font-size:13px;line-height:1.4;overflow-wrap:anywhere}.kode-kanban-desc{margin:0;font-size:12px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}.kode-kanban-steps{margin:0;padding-left:18px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-kanban-card-foot{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;padding-top:2px}.kode-kanban-card-foot .kode-field{margin:0;min-width:96px;flex:1 1 96px}.kode-kanban-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kode-connectors-panel{display:flex;flex-direction:column;gap:14px}.kode-connector-env-bar{display:flex;flex-wrap:wrap;gap:8px}.kode-connector-env-pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px 3px 6px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}.kode-connector-env-pill.is-ok{border-color:color-mix(in srgb,#23a55a 45%,transparent);color:#23a55a}
.kode-connectors-active h4,.kode-connectors-catalog h4{margin:0 0 8px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.kode-connector-list{display:flex;flex-direction:column;gap:10px;margin:0;padding:0;list-style:none}
.kode-connector-card{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3)}.kode-connector-card.is-paused{opacity:.72}
.kode-connector-card-head{display:flex;align-items:center;gap:10px}.kode-connector-card-title{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-connector-status{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-tertiary)}.kode-connector-status.is-on{color:#23a55a;background:color-mix(in srgb,#23a55a 14%,transparent)}
.kode-connector-icon{display:inline-grid;place-items:center;border-radius:8px;flex-shrink:0;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.16),0 1px 2px rgba(0,0,0,.16)}.kode-connector-icon>svg{display:block}.kode-connector-icon.is-compact{border-radius:5px;box-shadow:inset 0 0 0 .5px rgba(255,255,255,.18)}.kode-connector-icon.is-light{box-shadow:inset 0 0 0 1px rgba(15,23,42,.12),0 1px 2px rgba(0,0,0,.08)}
.kode-connector-badge{display:inline-flex;align-items:center;justify-content:center;min-width:36px;height:24px;padding:0 7px;border-radius:7px;font-size:11px;font-weight:700;color:#fff;flex-shrink:0;background:#64748b}
.kode-connector-badge.is-green{background:#16a34a}.kode-connector-badge.is-purple{background:#7c3aed}.kode-connector-badge.is-blue{background:#2563eb}.kode-connector-badge.is-amber{background:#d97706}.kode-connector-badge.is-indigo{background:#4f46e5}.kode-connector-badge.is-rose{background:#e11d48}.kode-connector-badge.is-slate{background:#475569}
.kode-connector-how{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-radius:7px;background:var(--dsw-alias-bg-base);font-size:12px;line-height:1.5;overflow-wrap:anywhere}.kode-connector-how-label{font-size:11px;font-weight:700;color:var(--dsw-alias-label-secondary);flex-shrink:0}
.kode-connector-webhook-box{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border-radius:8px;border:.5px dashed var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}.kode-connector-webhook-row,.kode-connector-secret-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.kode-connector-url{flex:1;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-connector-card-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:12px}.kode-connector-card-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kode-connector-catalog-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px}.kode-connector-catalog-head h4{margin:0}.kode-connector-group-label{margin:12px 0 6px;font-size:11px;font-weight:700;letter-spacing:.03em;color:var(--dsw-alias-label-secondary)}
.kode-connector-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}
.kode-connector-tile{display:flex;flex-direction:column;gap:6px;padding:12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:border-color 140ms ease,transform 140ms ease}.kode-connector-tile:hover{border-color:var(--dsw-alias-state-business-primary,#5865f2);transform:translateY(-1px)}.kode-connector-tile.is-added{border-color:color-mix(in srgb,#23a55a 45%,var(--dsw-alias-border-l3))}
.kode-connector-tile-head{display:flex;align-items:center;gap:9px}.kode-connector-tile-count{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-secondary)}.kode-connector-tile-count.is-added{color:#23a55a;font-weight:600}.kode-connector-tile-desc{font-size:12px;line-height:1.45}
.kode-connector-editor{display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform)}.kode-connector-editor-head{display:flex;align-items:center;gap:9px}.kode-connector-check{display:inline-flex;align-items:center;gap:6px;font-size:13px;cursor:pointer}.kode-connector-services{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.kode-connector-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 9px 2px 3px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3);font-size:12px;line-height:18px}.kode-connector-chip.is-paused{opacity:.55}
.kode-connector-quick-picks{display:flex;flex-wrap:wrap;gap:6px}.kode-connector-pick-chip{display:inline-flex;align-items:center;gap:6px;padding-left:6px}
.kode-watch-name-row{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
.kode-session-bot-board,.kode-session-bot-connectors{display:flex;flex-direction:column;gap:8px}
.kode-session-bot-counts{display:flex;flex-wrap:wrap;gap:6px}
.kode-session-bot-items{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}
.kode-session-bot-item{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:7px;background:var(--dsw-alias-bg-module-platform);font-size:12px;min-width:0}
.kode-session-bot-item-dot{width:6px;height:6px;border-radius:50%;flex:none;background:#949ba4}.kode-session-bot-item.is-needs_user .kode-session-bot-item-dot{background:#f0b232}.kode-session-bot-item.is-in_progress .kode-session-bot-item-dot{background:#3d6ff5}
.kode-session-bot-item-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-session-bot-item-act{border:0;background:color-mix(in srgb,#3d6ff5 16%,transparent);color:#3d6ff5;border-radius:5px;padding:1px 6px;font-size:11px;font-weight:600;cursor:pointer;flex:none}
.kode-session-bot-empty{margin:0;font-size:12px}
.kode-session-bot-add{display:flex;align-items:center;gap:6px}.kode-session-bot-add input{flex:1;min-width:0;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;font-size:12px}
.kode-git-tab-icon{margin-right:5px;flex:none;color:#f97316}
.kode-git-pane{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);font-size:12px}
.kode-git-header{display:flex;flex-direction:column;gap:8px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none}
.kode-git-branch-row{display:flex;align-items:center;gap:6px;min-width:0}
.kode-git-branch-row>svg{flex:none;color:#f97316}
.kode-git-branch-name{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.kode-git-pill{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:600;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3)}
.kode-git-header-actions{display:flex;align-items:center;gap:4px;margin-left:auto;flex:none}
.kode-git-mode-tabs{display:inline-flex;align-items:center;padding:1px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-border-l3)}
.kode-git-mode-tab{border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;padding:2px 7px;border-radius:5px;cursor:pointer}
.kode-git-mode-tab.is-active{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.kode-git-graph{display:flex;flex-direction:column;padding:2px 0 8px}
.kode-git-graph-block{min-width:0}
.kode-git-graph-row{position:relative;display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px;width:100%;min-height:52px;padding:0 8px 0 0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer}
.kode-git-graph-row:hover,.kode-git-graph-row.is-selected{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.kode-git-rail{position:relative;display:flex;justify-content:center;min-height:100%}
.kode-git-svg{position:absolute;inset:0;display:block;height:100%;overflow:visible}
.kode-git-line{fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}
.kode-git-node{position:absolute;z-index:1;top:50%;width:9px;height:9px;transform:translate(-50%,-50%);border:2px solid currentColor;border-radius:50%;background:var(--dsw-alias-bg-base,#1e1e1e)}
.kode-git-node.is-working{width:12px;height:12px;background:currentColor}
.kode-git-node.is-merge{width:11px;height:11px}
.kode-git-lane-0{color:#f97316}.kode-git-lane-1{color:#3b82f6}.kode-git-lane-2{color:#22c55e}.kode-git-lane-3{color:#a855f7}.kode-git-lane-4{color:#ef4444}.kode-git-lane-5{color:#06b6d4}
.kode-git-graph-content{min-width:0;display:flex;flex-direction:column;gap:3px;padding:8px 0}
.kode-git-working-card{margin:4px 0;padding:7px 9px;border:1px solid color-mix(in srgb,#f97316 28%,transparent);border-radius:8px;background:color-mix(in srgb,#f97316 8%,transparent)}
.kode-git-graph-main{min-width:0;display:flex;align-items:center;gap:7px}
.kode-git-graph-main strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12px}
.kode-git-graph-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10.5px}
.kode-git-ref-chips{display:flex;flex-wrap:wrap;gap:4px}
.kode-git-ref-chip{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;font-weight:600;line-height:17px;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border:.5px solid var(--dsw-alias-border-l3)}
.kode-git-ref-chip.is-head{background:color-mix(in srgb,#f97316 18%,transparent);color:#f97316;border-color:color-mix(in srgb,#f97316 40%,transparent)}
.kode-git-ref-chip.is-branch{background:color-mix(in srgb,#22c55e 14%,transparent);color:#22c55e;border-color:color-mix(in srgb,#22c55e 36%,transparent)}
.kode-git-ref-chip.is-remote{background:color-mix(in srgb,#3b82f6 14%,transparent);color:#60a5fa;border-color:color-mix(in srgb,#3b82f6 34%,transparent)}
.kode-git-ref-chip.is-tag{background:color-mix(in srgb,#eab308 16%,transparent);color:#eab308;border-color:color-mix(in srgb,#eab308 38%,transparent)}
.kode-git-expansion{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:7px;padding-right:6px}
.kode-git-expanded-rail{position:relative;align-self:stretch}
.kode-git-expanded-line{position:absolute;top:0;bottom:0;width:2px;transform:translateX(-50%);background:currentColor}
.kode-git-expanded{min-width:0;margin:0 0 8px;padding:4px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l3)}
.kode-git-commit-detail{display:flex;flex-direction:column;gap:6px}
.kode-git-commit-msg{margin:0;padding:6px 8px;max-height:92px;overflow:auto;border-radius:6px;background:var(--dsw-alias-bg-module-platform);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.kode-git-commit-bar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 4px;font-size:11px}
.kode-git-commit-files{display:flex;flex-direction:column}
.kode-git-commit-file{cursor:pointer;padding-left:6px}
.kode-git-search{display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:7px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.kode-git-search input{flex:1;min-width:0;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none}
.kode-git-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.kode-git-lists{flex:1 1 auto;min-height:0;overflow:auto;padding:6px 0}
.kode-git-body.has-diff .kode-git-lists{flex:0 1 46%;min-height:110px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-git-section{display:flex;flex-direction:column}
.kode-git-section-head{display:flex;align-items:center;justify-content:space-between;gap:6px;padding:4px 10px 4px 8px}
.kode-git-section-toggle{display:flex;align-items:center;gap:5px;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;cursor:pointer;padding:2px 0}
.kode-git-section-toggle:hover{color:var(--dsw-alias-label-primary)}
.kode-git-count{padding:0 6px;border-radius:999px;font-size:10px;font-weight:600;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kode-git-tree{display:flex;flex-direction:column}
.kode-git-row{display:flex;align-items:center;gap:5px;min-height:26px;padding:2px 10px 2px calc(12px + var(--kode-git-depth,0) * 14px);box-sizing:border-box;width:100%;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;text-align:left}
.kode-git-row.is-dir{cursor:pointer;color:var(--dsw-alias-label-secondary);font-weight:500}
.kode-git-row.is-dir:hover,.kode-git-row.is-file:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-git-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 14%,transparent)}
.kode-git-folder-icon{flex:none;color:#eab308}
.kode-git-dir-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.kode-git-row-main{flex:1 1 auto;min-width:0;display:flex;align-items:baseline;gap:6px;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer;padding:2px 0;overflow:hidden}
.kode-git-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;max-width:100%}
.kode-git-file-dir{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.kode-git-stat{display:inline-flex;align-items:center;gap:4px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:10px;font-variant-numeric:tabular-nums;flex:none}
.kode-git-stat .is-add{color:#22c55e}.kode-git-stat .is-del{color:#ef4444}
.kode-git-row-actions{display:inline-flex;align-items:center;gap:2px;flex:none;opacity:0;transition:opacity 100ms ease}
.kode-git-row:hover .kode-git-row-actions,.kode-git-row.is-selected .kode-git-row-actions,.kode-git-row:focus-within .kode-git-row-actions{opacity:1}
.kode-git-mini-btn{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 5px;border:.5px solid var(--dsw-alias-border-l3);border-radius:5px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:600;line-height:1;cursor:pointer}
.kode-git-mini-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.kode-git-mini-btn.is-danger:hover:not(:disabled){color:#ef4444;border-color:color-mix(in srgb,#ef4444 45%,transparent)}
.kode-git-mini-btn:disabled{opacity:.45;cursor:default}
.kode-git-badge{width:16px;text-align:center;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;font-weight:700;flex:none;color:#94a3b8}
.kode-git-badge.is-M{color:#f59e0b}.kode-git-badge.is-A,.kode-git-badge.is-U{color:#22c55e}.kode-git-badge.is-D{color:#ef4444}.kode-git-badge.is-R,.kode-git-badge.is-C{color:#3b82f6}
.kode-git-empty{margin:0;padding:10px 14px;font-size:12px}
.kode-git-commits{list-style:none;margin:0;padding:0;display:flex;flex-direction:column}
.kode-git-commit-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 8px;width:100%;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;padding:6px 12px;cursor:pointer}
.kode-git-commit-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-git-commit-row.is-selected{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#5865f2) 14%,transparent)}
.kode-git-commit-hash{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:#f97316;grid-row:1 / span 2;align-self:center}
.kode-git-commit-subject{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-git-commit-meta{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-git-more-btn{width:calc(100% - 16px);margin:4px 8px 2px;padding:7px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:600;cursor:pointer;text-align:center}
.kode-git-more-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.kode-git-more-btn:disabled{opacity:.5;cursor:default}
.kode-git-more-error{margin:4px 12px 0;font-size:11px;color:#ef4444}
.kode-git-diff{flex:1 1 54%;min-height:140px;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base)}
.kode-git-diff-head{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);flex:none}
.kode-git-scope-pill{flex:none;padding:1px 6px;border-radius:999px;font-size:10px;font-weight:700;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.kode-git-scope-pill.is-staged{color:#22c55e;background:color-mix(in srgb,#22c55e 14%,transparent)}
.kode-git-scope-pill.is-unstaged{color:#f59e0b;background:color-mix(in srgb,#f59e0b 14%,transparent)}
.kode-git-scope-pill.is-untracked{color:#3b82f6;background:color-mix(in srgb,#3b82f6 14%,transparent)}
.kode-git-diff-path{flex:1 1 auto;min-width:0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-git-diff-body{flex:1 1 auto;min-height:0;overflow:auto}
.kode-git-diff-pre{margin:0;padding:6px 0;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:1.5;tab-size:2;white-space:pre;min-width:max-content}
.kode-git-diff-line{display:block;padding:0 10px}
.kode-git-diff-line.is-add{background:color-mix(in srgb,#22c55e 15%,transparent);color:color-mix(in srgb,#22c55e 85%,var(--dsw-alias-label-primary))}
.kode-git-diff-line.is-del{background:color-mix(in srgb,#ef4444 15%,transparent);color:color-mix(in srgb,#ef4444 85%,var(--dsw-alias-label-primary))}
.kode-git-diff-line.is-hunk{background:color-mix(in srgb,#3b82f6 12%,transparent);color:#60a5fa}
.kode-git-diff-line.is-meta{color:var(--dsw-alias-label-tertiary)}
@media (max-width:1040px){.kode-kanban-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:620px){.kode-kanban-grid{grid-template-columns:minmax(0,1fr)}}
@container (max-width:820px){.kode-bot-settings-body{flex-direction:column;gap:12px;min-height:0}.kode-bot-settings-nav{flex-direction:row;width:auto;overflow-x:auto;padding-bottom:4px}.kode-bot-settings-nav{align-self:stretch;background:var(--dsw-alias-bg-base,inherit);z-index:1}.kode-bot-settings-nav>button{padding:6px 12px;white-space:nowrap}.kode-bot-settings-pane{gap:12px;max-height:none;overflow-x:hidden}}@container (max-width:600px){.kode-bot-pane-columns{grid-template-columns:minmax(0,1fr)}.kode-bot-asset-previews{grid-template-columns:minmax(0,1fr)}}@media (max-width:640px){.kode-bot-create{flex-direction:column;align-items:flex-start}}

.kode-memory-header-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}.kode-memory-host-picker{min-width:150px;margin-right:auto}.kode-memory-host-picker .kode-field{margin:0}
.kode-memory-stats{display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--dsw-alias-label-secondary)}.kode-memory-stat strong{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.kode-memory-energy-strip{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-memory-energy-pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-settings-card-fill);font-size:12px;color:var(--dsw-alias-label-secondary)}.kode-memory-energy-pill[data-low=true]{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a12) 55%,transparent);color:var(--dsw-alias-state-warning-primary,#c98a12)}.kode-memory-energy-author{max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}.kode-memory-energy-bar{width:44px;height:5px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;flex:none}.kode-memory-energy-bar>span{display:block;height:100%;border-radius:inherit;background:var(--dsw-alias-state-business-primary,#3d6ff5)}.kode-memory-energy-pill[data-low=true] .kode-memory-energy-bar>span{background:var(--dsw-alias-state-warning-primary,#c98a12)}.kode-memory-energy-val{font-family:ui-monospace,monospace;font-variant-numeric:tabular-nums;font-size:11px}
.kode-memory-content{display:flex;flex-direction:column;gap:12px}
.kode-memory-batch-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:8px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill);border:.5px solid var(--dsw-alias-settings-card-stroke)}.kode-memory-check{display:inline-flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}.kode-memory-batch-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-memory-card{gap:10px}.kode-memory-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.kode-memory-scope{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#3d6ff5) 12%,transparent);color:var(--dsw-alias-label-primary);border-color:transparent}.kode-memory-title{font-size:14px;font-weight:600;overflow-wrap:anywhere}.kode-memory-meta{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.kode-memory-body{margin:0;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;max-height:260px;overflow:auto}.kode-memory-rationale{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary)}.kode-memory-supersedes{margin:0;color:var(--dsw-alias-state-warning-primary,#c98a12)}.kode-memory-tags{display:flex;flex-wrap:wrap;gap:6px}.kode-memory-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}.kode-memory-reason-form{display:flex;flex-direction:column;gap:8px;padding-top:4px}.kode-memory-empty{align-items:flex-start;padding:20px 16px}.kode-memory-notice{margin:0;font-size:13px}
.kode-memory-search-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.kode-memory-search-bar input{flex:1 1 220px;min-width:0;height:36px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.kode-memory-search-bar select{height:36px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
html[data-kode-embed] body{-webkit-user-select:none;user-select:none;cursor:default}html[data-kode-embed] :is(input,textarea,[contenteditable]:not([contenteditable=false]),[data-chat-flow],pre,code){-webkit-user-select:text;user-select:text;cursor:auto}
.kode-brand-mark{position:relative;flex:none;display:block;color:var(--dsw-alias-label-primary,#EDEFEB);user-select:none}
.kode-brand-mark>*{position:absolute;inset:0;display:block;width:100%;height:100%}
.kode-brand-ink{background:currentColor;-webkit-mask:var(--kode-brand-ink) center/contain no-repeat;mask:var(--kode-brand-ink) center/contain no-repeat}
.kode-brand-mark>img{object-fit:contain;-webkit-user-drag:none}
.kode-brand-name{display:inline-flex;align-items:center;box-sizing:border-box;height:18px;font-size:13px;font-weight:600;line-height:16px;transform:none;letter-spacing:-0.01em;white-space:nowrap;user-select:none;color:var(--dsw-alias-label-secondary,#A8AEA7);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","Avenir Next",system-ui,sans-serif}
/* The 512px app tile has 43px transparent margins; match its visible face to the 16px wordmark. */
.kode-sidebar-app-icon{display:block;flex:none;transform:scale(1.2)}
.kode-sidebar-brand-mark{display:inline-flex;align-items:center;gap:5px;margin-inline-start:0}
[class*="brandIdentity"]:has(.kode-brand-name){gap:4px;height:20px}
[class*="brandName"]:has(>.kode-brand-name){height:20px}
[data-sidebar-toggle] .kode-sidebar-brand-mark{width:24px!important;height:24px!important;margin-inline-start:0;border-radius:6px;background:url("/api/kode/avatars/media?type=kode&state=idle") center/contain no-repeat}
[data-sidebar-toggle] .kode-sidebar-brand-mark>*{display:none}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]){padding:12px 10px 8px}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="logoRow"],
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="newSessionRow"],
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="panelList"]{margin-bottom:8px}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="panelList"]{gap:4px}
[class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="panelEntry"] [class*="panelRow"]{padding:0}
[class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="panelTrailing"]{right:2px;top:2px;pointer-events:none}
[class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="panelTrailing"] .kode-bot-badge{box-sizing:border-box;min-width:15px;height:15px;padding:0 4px;border-radius:999px;font-size:9.5px;line-height:15px;box-shadow:0 0 0 1.5px var(--dsw-specific-sidebar-fill)}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="scrollArea"]{min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;margin-inline:-10px;padding-inline:10px}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="scrollArea"]::-webkit-scrollbar{display:none}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="regionArea"]{flex:0 0 auto}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [data-sidebar-workspace-header]{margin-bottom:4px}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [data-sidebar-workspace-header]+[class*="search"]{margin-bottom:8px}
html:not([data-windows-titlebar]) [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) [class*="footArea"]{gap:4px;padding-top:6px}
.kode-brand-name-badge{transform:none;color:var(--dsw-alias-label-primary,#EDEFEB)}.kode-harness-badge{display:block;flex:none;margin-inline:1px;overflow:hidden}
/* Kode hosts the web layout on macOS. Keep the top bar unified with the sidebar chrome (matching Kode GUI), place the compact brand below the traffic lights in a slimmer expanded sidebar, keep the collapsed rail at its icon width, and round the content surface below the top bar so the window buttons never touch it. */
html[data-kode-platform=macos] :has(> [data-shell-overlay]) {
  --kode-macos-topbar-height:38px;
  --kode-macos-sidebar-trim:48px;
  background:var(--dsw-specific-sidebar-fill);
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]):is([data-sidebar-collapsed],[data-sidebar-drawer]) {
  --kode-macos-sidebar-trim:0px;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]):not([data-sidebar-drawer]) {
  & > [class$="_sidebarCol"] {
    width:calc(100% - var(--kode-macos-sidebar-trim));
    border-right:0;
  }
  & > [class$="_centerCol"] {
    margin-inline-start:calc(-1 * var(--kode-macos-sidebar-trim));
  }
  & > [data-side=sidebar] {
    transform:translateX(calc(-1 * var(--kode-macos-sidebar-trim)));
  }
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]):not([data-sidebar-collapsed]):not([data-sidebar-drawer]) > [class$="_sidebarCol"] [data-slot=sidebar] > [class*="root"]:not([class*="collapsed"]) {
  width:100%!important;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay])[data-animating]:not([data-dragging]) {
  & > [class$="_sidebarCol"] {
    transition:width var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
  & > [class$="_centerCol"] {
    transition:margin-inline-start var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
}
@media(prefers-reduced-motion:reduce){
  html[data-kode-platform=macos] :has(> [data-shell-overlay])[data-animating]:not([data-dragging]) {
    & > [class$="_sidebarCol"],
    & > [class$="_centerCol"] {
      transition:none;
    }
  }
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) [data-slot=sidebar] > [class*="root"]:not([class*="collapsed"]) {
  padding-block-start:0;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) [data-slot=sidebar] > [class*="root"]:not([class*="collapsed"]) [class*="logoRow"][data-window-drag] {
  box-sizing:border-box;
  height:auto;
  padding:var(--kode-macos-topbar-height) 2px 6px 8px;
  margin-block-end:4px;
  gap:6px;
}
html[data-kode-platform=macos] [data-sidebar-collapsed]:not([data-sidebar-drawer]) [data-slot=sidebar] > [class*="root"][class*="collapsed"]:has([data-sidebar-toggle]) {
  padding-block-start:0;
}
html[data-kode-platform=macos] [data-sidebar-collapsed]:not([data-sidebar-drawer]) [data-slot=sidebar] > [class*="root"][class*="collapsed"] [data-window-drag]:has([data-sidebar-toggle]) {
  box-sizing:border-box;
  height:auto;
  padding-block-start:var(--kode-macos-topbar-height);
  margin-block-start:0;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) > [class$="_centerCol"] {
  background:var(--dsw-specific-sidebar-fill);
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) > [class$="_centerCol"] [data-phase] {
  background:transparent;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) > [class$="_centerCol"] [data-phase] header[data-window-drag] {
  box-sizing:border-box;
  background:var(--dsw-specific-sidebar-fill);
  border-bottom:0;
  min-height:var(--kode-macos-topbar-height);
  padding:3px 20px 5px 14px;
  align-items:center;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]) > [class$="_centerCol"] [data-phase] header[data-window-drag]:has([data-conversation-tabs]) {
  padding-bottom:0;
}
html[data-kode-platform=macos] :has(> [data-shell-overlay])[data-sidebar-collapsed]:not([data-sidebar-drawer]) > [class$="_centerCol"] [data-phase] header[data-window-drag],
html[data-kode-platform=macos] :has(> [data-shell-overlay])[data-sidebar-collapsed]:not([data-sidebar-drawer]) > [class$="_centerCol"] .kode-shared-conversation > header {
  padding-inline-start:calc(var(--kode-traffic-lights-inset,78px) - 56px + 10px);
}
html[data-kode-platform=macos] :has(> [data-shell-overlay]):not([data-sidebar-drawer]) {
  & > [class$="_centerCol"] [data-phase] > [data-conversation-content],
  & > [class$="_centerCol"] [data-global-panel] {
    box-sizing:border-box;
    background:var(--dsw-alias-bg-base);
    border:1px solid var(--dsw-alias-border-l3);
    border-right:0;
    border-radius:16px 0 0 16px;
    margin-bottom:4px;
    overflow:clip;
    isolation:isolate;
  }
  & > [class$="_centerCol"] [data-global-panel] {
    margin-top:var(--kode-macos-topbar-height);
  }
  & > [class$="_centerCol"] .kode-shared-conversation {
    background:var(--dsw-specific-sidebar-fill);
  }
  & > [class$="_centerCol"] .kode-shared-conversation > header {
    box-sizing:border-box;
    min-height:var(--kode-macos-topbar-height);
    padding:3px 20px 5px 14px;
    border-bottom:0;
    background:var(--dsw-specific-sidebar-fill);
  }
  & > [class$="_centerCol"] .kode-shared-conversation > .kode-shared-messages {
    background:var(--dsw-alias-bg-base);
    border-top:1px solid var(--dsw-alias-border-l3);
    border-left:1px solid var(--dsw-alias-border-l3);
    border-radius:16px 0 0 0;
  }
  & > [class$="_centerCol"] .kode-shared-conversation > .kode-shared-composer {
    background:var(--dsw-alias-bg-base);
    border-left:1px solid var(--dsw-alias-border-l3);
    border-bottom:1px solid var(--dsw-alias-border-l3);
    border-radius:0 0 0 16px;
    margin-bottom:4px;
  }
}
html[data-kode-platform=macos] :has(> [data-shell-overlay])[data-sidebar-drawer] {
  --dsh-frame-leading-clearance:calc(var(--kode-traffic-lights-inset,78px) + 44px);
  & > [class$="_centerCol"] [data-phase] > [data-conversation-content],
  & > [class$="_centerCol"] [data-global-panel] {
    box-sizing:border-box;
    background:var(--dsw-alias-bg-base);
    border-top:1px solid var(--dsw-alias-border-l3);
    overflow:clip;
    isolation:isolate;
  }
  & > [class$="_centerCol"] [data-global-panel] {
    margin-top:var(--kode-macos-topbar-height);
  }
}
html[data-kode-platform=macos] [data-sidebar-drawer] > [data-shell-leading] {
  top:5px;
  left:var(--kode-traffic-lights-inset,78px);
}
html[data-kode-embed] .kode-token-notch{display:none}
.kode-handoff-trigger{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px!important;padding:0 10px!important;white-space:nowrap}
.kode-model-control{min-width:0;max-width:min(360px,45cqw)}
.kode-model-control>.kode-trigger{max-width:100%}
.kode-model-menu{min-width:240px}
.kode-model-menu .kode-option{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.kode-model-menu .kode-option>.kode-secondary{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px}
[role=menu]:has(>[role=presentation]>*>[role=menuitem] .kode-model-choice){min-width:200px;animation:kode-model-submenu-in 140ms cubic-bezier(.3,.9,.25,1)}

.kode-model-choice-mark{display:inline-block;width:16px;height:16px}
@keyframes kode-model-submenu-in{from{opacity:0;translate:0 3px}}
@media(prefers-reduced-motion:reduce){[role=menu]:has(>[role=presentation]>*>[role=menuitem] .kode-model-choice){animation:none}}
[data-slot="conversation.input.right"] [data-composer-stat="activity"]{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;gap:0;min-width:0;width:24px;max-width:24px;margin-right:-8px;padding:0}
[data-slot="conversation.input.right"] [data-composer-stat="activity"] button{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;gap:0;width:24px;min-width:24px;height:24px;min-height:24px;margin:0;padding:0}
[data-slot="conversation.input.right"] [data-composer-stat="activity"] [class*="label"]{display:none}
@media(max-width:720px){.kode-handoff-trigger{width:32px;padding:0!important}.kode-handoff-trigger>span{display:none}.kode-model-control{max-width:48cqw}[data-slot="conversation.input.right"] [data-composer-stat="activity"]{max-width:24px}[data-slot="conversation.input.right"] [data-composer-stat="activity"] [class*="label"]{display:none}}
/* Settings polish: one type ramp, hairline rows, native control heights and a fixed dialog action layer. */
/* Kode dialogs: the body scrolls between a fixed header and the native action row. */
/* Kode settings and dialogs. */
.kode-project-source>.kode-field{width:100%;margin-bottom:8px}
.kode-hub-settings h4{margin:16px 0 0}
.kode-goal-sidebar .kode-field{flex:1;min-height:0}
.kode-goal-bar .kode-field{flex:1;min-width:160px}
.kode-hub-targets{display:flex;flex-wrap:wrap;gap:12px;border:0;padding:8px 0;margin:0}
.kode-hub-targets label{display:flex;align-items:center;gap:4px}
.kode-agent-row p{margin:0;overflow-wrap:anywhere}
.kode-relay-detail>.kode-config-note{margin:4px 0 0}
.kode-deployment-progress{height:4px;width:100%;overflow:hidden;border-radius:2px;background:var(--dsw-alias-border-l2)}
.kode-deployment-progress>span{display:block;width:100%;height:100%;background:var(--dsw-alias-label-primary);transform-origin:left center;transition:transform 280ms cubic-bezier(.16,1,.3,1)}
.kode-deployment-steps{list-style:none;padding:0;margin:20px 0;display:flex;flex-direction:column;gap:12px}
.kode-deployment-steps li{display:flex;gap:12px;align-items:flex-start;font-size:13px;line-height:1.5}
.kode-deployment-state{display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:20px}
.kode-deployment-steps li[data-status=pending]{color:var(--dsw-alias-label-tertiary)}
.kode-deployment-steps small{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kode-deployment-steps li[data-status=running]>div>span{font-weight:500}
.kode-deployment-steps li[data-status=done] .kode-deployment-state{animation:kode-step-complete 220ms cubic-bezier(.16,1,.3,1)}
.kode-disclosure-content>.kode-field{margin:0}
.kode-settings-group-title{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);margin:4px 0 -4px;display:flex;align-items:center;gap:6px}
.kode-settings-group-title>svg{flex:none;color:var(--dsw-alias-label-secondary)}
/* One-word facts beside a label: kind/custom outline, monospace versions, soft state tints (tuned per theme for AA on 11px). */
.kode-settings-tag{--kode-tag:var(--dsw-alias-label-secondary);display:inline-flex;align-items:center;flex:none;box-sizing:border-box;padding:0 6px;border-radius:5px;font-size:11px;font-weight:400;line-height:18px;white-space:nowrap;color:var(--kode-tag);background:color-mix(in srgb,var(--kode-tag) 13%,transparent)}
.kode-settings-tag[data-tone=kind]{background:none;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.kode-settings-tag[data-tone=version]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500;font-variant-numeric:tabular-nums;background:var(--dsw-alias-bg-module-platform)}
.kode-settings-tag[data-tone=custom],.kode-settings-tag[data-tone=update],.kode-settings-tag[data-tone=info]{--kode-tag:#0969da}
.kode-settings-tag[data-tone=update]{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:500}
.kode-settings-tag[data-tone=success]{--kode-tag:#1a7f37}.kode-settings-tag[data-tone=warning]{--kode-tag:#9a6700}.kode-settings-tag[data-tone=error]{--kode-tag:#cf222e}
body[data-ds-dark-theme] .kode-settings-tag{background:color-mix(in srgb,var(--kode-tag) 22%,transparent)}
body[data-ds-dark-theme] .kode-settings-tag[data-tone=kind]{background:none}body[data-ds-dark-theme] .kode-settings-tag[data-tone=version]{background:var(--dsw-alias-bg-module-platform)}
body[data-ds-dark-theme] .kode-settings-tag:is([data-tone=custom],[data-tone=update],[data-tone=info]){--kode-tag:#4493f8}
body[data-ds-dark-theme] .kode-settings-tag[data-tone=success]{--kode-tag:#3fb950}body[data-ds-dark-theme] .kode-settings-tag[data-tone=warning]{--kode-tag:#d29922}body[data-ds-dark-theme] .kode-settings-tag[data-tone=error]{--kode-tag:#f85149}
.kode-settings-page .kode-integration-row strong,.kode-agent-name,.kode-service-status>strong{display:inline-flex;align-items:center;flex-wrap:wrap;gap:4px 6px}
.kode-agent-name>.kode-settings-tag,.kode-settings-group-title>.kode-settings-tag{margin-left:2px}
.kode-pairing-head{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
.kode-avatar-dialog>:has(>.kode-avatar-editor){min-height:0;overflow-y:auto;overscroll-behavior:contain}
.kode-avatar-choice>span:last-child{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px}
.kode-avatar-choice:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-avatar-choice[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}
.kode-avatar-choice:disabled{opacity:.5;cursor:default}
.kode-avatar-choice:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-fast-switch{position:relative;box-sizing:border-box;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:10px;background:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background-color 160ms ease}
.kode-fast-switch[aria-checked=true]{background:var(--dsw-alias-state-business-primary)}
.kode-fast-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);box-shadow:0 1px 3px rgb(0 0 0 / 20%);transform:translateX(0);transition:transform 160ms ease}
.kode-fast-switch[aria-checked=true]>.kode-fast-switch-thumb{transform:translateX(16px)}
.kode-fast-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-fast-switch:disabled{opacity:.5;cursor:default}
.kode-default-models{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) auto;gap:12px 16px;align-items:end;padding:12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.kode-default-models>.kode-field{min-width:0;margin:0}
.kode-default-models>.kode-config-note{grid-column:1/-1;margin:0}
.kode-default-fast{display:flex;align-items:center;justify-content:space-between;gap:16px;min-height:40px;font-size:14px}
.kode-default-fast>span{white-space:nowrap}
.kode-agent-rows{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.kode-agent-row{border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-xl);padding:12px 14px;display:flex;flex-direction:column;gap:12px}
.kode-agent-row-head{display:flex;align-items:center;gap:10px;min-width:0}
.kode-agent-edit{margin-left:auto;flex-shrink:0}
.kode-agent-model-editor{min-width:0}
.kode-agent-model-editor .kode-default-models{background:var(--dsw-alias-bg-module-platform)}
.kode-agent-add{width:100%;gap:6px}
.kode-agent-editor{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);padding:14px 16px;min-width:0}
.kode-agent-editor .kode-field{gap:6px;margin-bottom:14px}
.kode-agent-editor .kode-field>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.kode-shared-composer .kode-field{margin-bottom:12px}
.kode-service-connected-icon{flex:none;color:var(--dsw-alias-state-success-primary)}
.kode-mobile-pairing,.kode-host-service{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.kode-mobile-pairing>.kode-settings-group-title,.kode-mobile-pairing>.kode-config-note,.kode-host-service>.kode-settings-group-title{margin:0}
.kode-mobile-pairing-form{display:flex;flex-direction:column;gap:12px}
.kode-mobile-pairing-form .kode-field{margin:0}
.kode-mobile-pairing-actions{display:flex;align-items:center;justify-content:flex-end;gap:12px}
.kode-mobile-pairing-actions>.kode-service-status{margin:0 auto 0 0}
.kode-mobile-pairing-actions>button{width:auto;min-width:160px}
.kode-pairing-result{display:flex;flex-direction:column;gap:16px;margin:4px 0 0;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-pairing-result>.kode-field,.kode-pairing-result>.kode-config-note{margin:0}
.kode-pairing-qr{display:flex;flex-direction:column;align-items:center;gap:12px;margin:0;text-align:center}
.kode-pairing-qr img{display:block;width:280px;max-width:100%;height:auto;aspect-ratio:1;image-rendering:pixelated}
.kode-pairing-qr figcaption{margin:0}
.kode-integration-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-integration-row>span{display:grid;gap:6px;min-width:0}
.kode-integration-row .kode-config-note{margin:0}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]::before{content:"";position:absolute;left:2px;top:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgb(0 0 0/.25);transition:transform 160ms ease}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]:checked{background:var(--dsw-alias-state-business-primary);border-color:transparent}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]:checked::before{transform:translateX(16px)}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]:disabled{opacity:.45;cursor:default}
.kode-field input::placeholder{color:var(--dsw-alias-label-caption)}
.kode-config-note{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px;margin:0 0 16px}
.kode-saved{margin-right:auto;color:var(--dsw-alias-label-secondary);font-size:13px}
.kode-field-select:hover{border-color:var(--dsw-alias-border-l1)}
.kode-delete{color:var(--dsw-alias-state-error-primary);margin-right:auto}
.kode-source-summary{display:flex;align-items:center;gap:10px;flex:1 1 220px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kode-source-summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:4px}
.kode-source-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;overflow:hidden;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.kode-source-avatar-fallback{font-size:16px;font-weight:600}
.kode-source-avatar img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:cover}
.kode-source-copy{display:flex;flex:1;flex-direction:column;min-width:0}
.kode-hub-sources-card .kode-source-avatar{width:32px;height:32px;border-radius:var(--dsw-radius-md)}
.kode-hub-sources-card .kode-source-avatar-fallback{font-size:14px}
.kode-source-description{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kode-source-meta{margin-top:2px;color:var(--dsw-alias-label-tertiary)}
.kode-source-dialog>:has(.kode-source-preview){min-height:0;overflow:hidden}
.kode-source-dialog :has(>.kode-source-preview){min-height:0;overflow-y:auto;overscroll-behavior:contain}
.kode-source-preview{display:flex;flex-direction:column;gap:16px;min-width:0}
.kode-source-preview-detail{display:flex;flex-direction:column;gap:16px;min-width:0}
.kode-source-undeclared{margin:0}
@media(min-width:900px){.kode-source-preview[data-layout=split]{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:24px;align-items:start}.kode-source-preview[data-layout=split]>.kode-package-inventory{position:sticky;top:0}.kode-source-preview[data-layout=split] .kode-package-list{grid-template-columns:minmax(0,1fr)}}
.kode-source-preview-header{display:flex;align-items:center;gap:12px;min-width:0}
.kode-source-preview-header>div{min-width:0}
.kode-source-preview-header strong{font-size:15px;font-weight:600}
.kode-source-preview-header p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.kode-source-preview-section>h3,.kode-mcp-head>h3{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:14px;font-weight:600;line-height:20px}
.kode-source-preview-section>h3>span,.kode-mcp-head>h3>span{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;padding:0 6px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500}
.kode-source-preview-list{margin:0;padding:0 12px;list-style:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.kode-source-preview-list>li{padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.kode-source-preview-list>li:last-child{border-bottom:0}
.kode-source-preview-list strong{font-size:13px;font-weight:500;line-height:20px;overflow-wrap:anywhere}
.kode-source-sync-list strong{display:flex;align-items:center;gap:6px}
.kode-source-sync-icon{flex:none;color:var(--dsw-alias-state-success-primary)}
.kode-source-sync-icon.is-pending{color:var(--dsw-alias-label-tertiary)}
.kode-source-preview-list p{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.kode-package-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:8px;margin:0;padding:0;list-style:none}
.kode-package-inventory{min-height:0}
.kode-package-item{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.kode-package-item[data-selected=true]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,var(--dsw-alias-settings-card-fill))}
.kode-package-select{display:flex;flex:1;flex-direction:column;gap:3px;min-width:0;padding:0;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kode-package-select>strong{font-size:13px;font-weight:600;line-height:20px;overflow-wrap:anywhere}
.kode-package-select>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.kode-package-select:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:3px}
.kode-package-toggle{display:flex;align-items:center;gap:8px;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.kode-package-sync-note{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 12px;margin-bottom:10px}.kode-package-sync-note>.kode-config-note{flex:1 1 280px;margin:0}
.kode-mcp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 8px}.kode-mcp-head>h3{margin:0}
.kode-mcp-bulk-result{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.kode-mcp-bulk-result[data-failed=true]{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.kode-mcp-agents{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.kode-source-target-option.kode-mcp-agent{min-height:28px;padding:3px 10px;font-size:12px;line-height:18px;cursor:default}
.kode-mcp-agent-action{color:var(--dsw-alias-label-secondary)}
span.kode-mcp-agent:hover{background:transparent}span.kode-mcp-agent:active{transform:none}
.kode-mcp-agent[data-status=ok]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}.kode-mcp-agent[data-status=ok]>svg{color:var(--dsw-alias-state-success-primary)}
button.kode-mcp-agent{cursor:pointer}button.kode-mcp-agent[data-status=login]{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 55%,transparent)}button.kode-mcp-agent[data-status=login]>svg{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
button.kode-mcp-agent[data-status=login] .kode-mcp-agent-action{color:var(--dsw-alias-state-warn-primary,#f59e0b);font-weight:500}
button.kode-mcp-agent[data-status=login][data-failed=true],.kode-mcp-agent[data-status=read-failed]{border-color:var(--dsw-alias-state-error-primary)}button.kode-mcp-agent[data-status=login][data-failed=true]>svg,button.kode-mcp-agent[data-status=login][data-failed=true] .kode-mcp-agent-action,.kode-mcp-agent[data-status=read-failed]>svg,.kode-mcp-agent[data-status=read-failed] .kode-mcp-agent-action{color:var(--dsw-alias-state-error-primary)}
.kode-mcp-agent[data-status=not-required]{color:var(--dsw-alias-label-secondary)}
.kode-mcp-agent[data-status=manual]>svg,.kode-mcp-agent[data-status=manual] .kode-mcp-agent-action{color:var(--dsw-alias-state-warn-primary,#f59e0b)}
.kode-mcp-agent:is([data-status=unknown],[data-status=unreported],[data-status=reading]){border-style:dashed;color:var(--dsw-alias-label-secondary)}
.kode-mcp-status-detail{display:block;margin:6px 0 0}
.kode-mcp-item-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:2px 10px;min-width:0}
.kode-mcp-item-head>span{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.kode-mcp-status-detail{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.kode-mcp-status-detail[data-failed=true]{color:var(--dsw-alias-state-error-primary)}
.kode-source-about dl{margin:0}
.kode-source-about dl>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;padding:9px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.kode-source-about dl>div:last-child{border-bottom:0}
.kode-source-about dt{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.kode-source-about dd{margin:0;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere}
.kode-source-actions>button{width:auto;min-width:0}
/* Same tokens as dsh's plugin manager uninstall button (outline + .danger): red label, red outline, red-tinted hover. */
.kode-source-remove{--dsw-alias-button-primary-fill:var(--dsw-alias-state-error-primary);--dsw-alias-button-primary-hover:var(--dsw-alias-state-error-primary)}
.kode-delete:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}
.kode-avatar-editor{display:flex;flex-direction:column;gap:12px;padding:8px 0}
.kode-avatar-content{display:flex;flex-direction:column;gap:12px}
.kode-avatar-content>*{flex-shrink:0}
.kode-avatar-content>.kode-config-note{margin:0}
.kode-avatar-grid{display:grid;overflow:auto;padding:4px;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));max-height:min(240px,28vh);gap:8px}
.kode-avatar-choice{display:flex;flex-direction:column;align-items:center;min-width:0;background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;gap:8px;padding:10px 6px}
.kode-avatar-caption{display:flex;align-items:center;justify-content:center;gap:4px;max-width:100%;min-width:0;font-size:12px;line-height:16px;white-space:nowrap}
.kode-avatar-caption>span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.kode-avatar-caption>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.kode-avatar-preview{display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-secondary);font-size:12px;min-height:112px;background:var(--dsw-alias-bg-module-platform);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);overflow:hidden;flex:none}
.kode-avatar-preview[data-has-background=true]{display:block;min-height:0}
.kode-avatar-preview>img,.kode-avatar-preview>video{display:block;width:100%;aspect-ratio:16/9;max-height:min(240px,28vh);object-fit:cover}
.kode-avatar-preview-identity{display:flex;align-items:center;gap:12px;color:var(--dsw-alias-label-primary);font-size:14px;min-width:0}
.kode-avatar-preview-identity>span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-avatar-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-avatar-actions>button:last-child{margin-left:auto}
.kode-background-controls{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.kode-background-mode{display:inline-flex;gap:2px;padding:3px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.kode-background-mode>button{min-width:48px;min-height:28px;padding:2px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.kode-background-mode>button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}
.kode-background-mode>button:not(:disabled):hover{color:var(--dsw-alias-label-primary)}
.kode-background-mode>button:disabled{opacity:.45;cursor:default}
.kode-background-filename{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-avatar-preview-name{display:flex;align-items:center;gap:6px;min-width:0}
.kode-avatar-preview-name>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-avatar-name-edit{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:32px;min-height:32px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.kode-avatar-name-edit:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-avatar-name-edit:focus-visible{outline:2px solid var(--dsw-focus-ring-color)}
.kode-avatar-rename{display:flex;align-items:center;flex:1;min-width:0;gap:4px}
.kode-avatar-rename input{min-width:0;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}
.kode-avatar-rename input:focus-visible{outline:2px solid var(--dsw-focus-ring-color)}
.kode-avatar-rename button{flex:none}
.kode-personalization{height:100%;min-height:0;box-sizing:border-box;overflow:hidden}
.kode-personalization-session{display:flex;align-items:baseline;gap:8px;min-width:0;padding:0 2px}
.kode-personalization-session-label{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-personalization-session strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.kode-personalization>.kode-config-note{margin:0}
.kode-personalization>.kode-avatar-editor{flex:1;min-height:0;padding-bottom:0}
.kode-personalization .kode-avatar-content{flex:1;min-height:0;overflow-y:auto;padding:0 4px 4px 0}
.kode-personalization .kode-avatar-footer{position:static;flex:none}
.kode-personalization .kode-avatar-grid{max-height:min(320px,32vh)}
.kode-settings-main .kode-settings-page{max-width:960px;margin:0 auto;padding-bottom:0}
.kode-settings-brand-meta{display:flex;flex-direction:column;gap:2px;min-width:0}
.kode-settings-page .kode-settings-brand h2{margin:0;font-size:16px;font-weight:600;line-height:24px}
.kode-settings-scope{display:block;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.kode-settings-scope .kode-field{margin:0;width:100%;max-width:none;min-width:0}
.kode-settings-brand-avatar{display:inline-flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);overflow:hidden}
.kode-settings-brand-avatar>img{display:block;width:100%;height:100%;object-fit:cover}
.kode-settings-layout{display:block;margin-top:16px}
.kode-settings-nav{position:static;display:flex;flex-direction:row;flex-wrap:wrap;gap:4px;min-width:0;margin:0 0 16px;padding:0}
.kode-settings-nav button{min-height:32px;padding:6px 10px;text-align:center;font:inherit;font-size:13px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid transparent;border-radius:var(--dsw-radius-md);cursor:pointer;white-space:nowrap}
.kode-settings-nav button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.kode-settings-nav button[aria-current=page]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill);border-color:var(--dsw-alias-border-l2);font-weight:500}
.kode-settings-nav button:focus-visible,.kode-settings-section:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:3px}
.kode-settings-section{display:flex;flex-direction:column;gap:12px;min-width:0;padding:0;margin:0}
.kode-settings-section .kode-agent-settings>.kode-field:first-child{margin-bottom:0}
.kode-settings-group{display:flex;flex-direction:column;gap:12px;width:100%;min-width:0;box-sizing:border-box}
.kode-settings-group>.kode-integration-row:last-of-type{border-bottom:0}
.kode-settings-group+.kode-settings-group{margin-top:16px;padding-top:24px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-settings-group>h3,.kode-settings-section>h3{font-size:15px;font-weight:600;margin:0 0 4px}
.kode-settings-page .kode-personalization{height:auto;overflow:visible}
.kode-settings-page .kode-personalization .kode-avatar-editor{flex:none}
.kode-settings-page .kode-avatar-footer{background:transparent}
.kode-settings-page .kode-integration-row{padding:12px 0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);gap:24px}
.kode-settings-page .kode-integration-row strong{font-size:14px;font-weight:500;line-height:22px}
.kode-settings-page .kode-settings-group+.kode-settings-group{margin-top:0;padding-top:0;border-top:0}
.kode-settings-page .kode-settings-card{display:flex;flex-direction:column;min-width:0;padding:0 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.kode-settings-page .kode-settings-card-padded,.kode-settings-page .kode-settings-card:is(.kode-host-service,.kode-mobile-pairing){padding:16px}
.kode-settings-page .kode-settings-card>.kode-settings-scope{padding:0;border:0;background:transparent}
.kode-settings-card>.kode-integration-row{padding:14px 0;border:0}
.kode-settings-card>.kode-integration-row+.kode-integration-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.kode-settings-card>.kode-config-note{margin:0 0 14px}
.kode-settings-card>.kode-config-note:only-child{margin:14px 0}
.kode-messaging-settings{border-bottom:.5px solid var(--dsw-alias-border-l2)}
.kode-messaging-settings>.kode-integration-row{border:0}
.kode-session-naming{display:grid;gap:8px;padding:0 0 14px;min-width:0}
.kode-session-naming>.kode-field,.kode-session-naming .kode-config-note{margin:0}
.kode-session-naming textarea{resize:vertical}
.kode-settings-page .kode-settings-select-row{flex-wrap:wrap;gap:10px 20px}
.kode-settings-select-row>span{flex:1 1 180px}
.kode-settings-row-control{flex:0 1 180px;min-width:0}
.kode-settings-row-control .kode-field{margin:0}
.kode-settings-card:is(.kode-agent-list-card,.kode-hub-sources-card,.kode-ssh-hosts-card)>.kode-agent-rows{gap:0}
.kode-settings-card:is(.kode-agent-list-card,.kode-hub-sources-card,.kode-ssh-hosts-card)>.kode-agent-rows>.kode-agent-row+.kode-agent-row{border-top:.5px solid var(--dsw-alias-border-l2)}
.kode-settings-card>.kode-personalization{height:auto;overflow:visible}
.kode-handoff-body .kode-field{margin-bottom:12px}
.kode-handoff-model{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 12px}.kode-handoff-model>.kode-field:only-child{grid-column:1/-1}
@media(max-width:480px){.kode-handoff-model{grid-template-columns:minmax(0,1fr)}}
.kode-handoff-body>.kode-config-note{margin:0}
.kode-settings-main{height:100%;min-height:0;overflow:auto;box-sizing:border-box;padding:24px clamp(16px,4vw,48px) 32px;width:100%;min-width:0}
.kode-settings-page .kode-settings-section .kode-agent-settings{width:100%;max-width:none;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-agent-rows,.kode-settings-page .kode-agent-row{width:100%;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-agent-editor{gap:12px;padding:14px;width:100%;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-source-summary,.kode-settings-page .kode-source-copy{min-width:0}
.kode-settings-page .kode-personalization .kode-avatar-content{flex:none;overflow:visible;width:100%;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-personalization .kode-avatar-grid{max-height:320px;width:100%;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-personalization .kode-avatar-preview{width:100%;min-width:0;box-sizing:border-box}
.kode-settings-page .kode-personalization .kode-avatar-preview>img{max-width:100%}
.kode-agent-version-identity{flex:1 1 120px;min-width:0;display:flex;flex-direction:column;gap:4px}
.kode-agent-version-line{display:flex;flex-wrap:wrap;gap:2px 8px;font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.kode-agent-row-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-inline-start:auto;justify-content:flex-end}
.kode-agent-row-actions>button{inline-size:72px;max-inline-size:100%;white-space:nowrap}
.kode-source-editor{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px;align-items:start}
.kode-source-editor>.kode-field{min-width:0;margin:0}
.kode-source-editor>.kode-field input{box-sizing:border-box;width:100%;min-width:0}
.kode-source-field-location,.kode-source-field-subdir{grid-column:1/-1}
.kode-source-target-picker{grid-column:1/-1;min-width:0;margin:0;padding:0;border:0}
.kode-source-target-picker>legend{margin-bottom:8px;padding:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.kode-source-target-options{display:flex;flex-wrap:wrap;gap:8px}
.kode-source-target-option{display:inline-flex;align-items:center;gap:6px;min-height:32px;max-width:100%;padding:4px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:start;overflow-wrap:anywhere;cursor:pointer}
.kode-source-target-option>svg{flex:none;color:var(--dsw-alias-label-secondary)}
.kode-source-target-option:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-source-target-option[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent)}
.kode-source-target-option[aria-pressed=true]>svg{color:var(--dsw-alias-state-business-primary)}
.kode-source-target-option:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.kode-source-target-option:disabled{opacity:.6;cursor:default}
.kode-source-target-picker .kode-config-note{margin:8px 0 0}
.kode-source-editor-actions>button{width:auto;min-width:88px}
.kode-settings-page{gap:0;padding-bottom:16px;max-width:720px;width:100%;min-height:0;--kode-settings-hairline:.5px solid var(--dsw-alias-border-l2)}
.kode-settings-page>header.kode-settings-brand{display:flex;align-items:center;gap:12px;margin:0;padding:0 0 4px}
.kode-settings-page .kode-settings-layout{margin-top:20px}
.kode-settings-page .kode-settings-nav{display:inline-flex;flex-wrap:nowrap;gap:2px;max-width:100%;box-sizing:border-box;margin:0 0 24px;padding:3px;overflow-x:auto;scrollbar-width:none;border:var(--kode-settings-hairline);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform)}
.kode-settings-page .kode-settings-nav::-webkit-scrollbar{display:none}
.kode-settings-page .kode-settings-nav button{flex:none;min-height:30px;padding:4px 12px;border:0;border-radius:var(--dsw-radius-sm);font-size:13px;line-height:20px;transition:background-color 120ms ease,color 120ms ease}
.kode-settings-page .kode-settings-nav button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-settings-page .kode-settings-nav button[aria-current=page]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l2);font-weight:500}
.kode-settings-page .kode-settings-nav button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.kode-settings-page .kode-settings-section:focus-visible{outline:none}
.kode-settings-page .kode-settings-section{display:flex;flex-direction:column;width:100%;gap:28px}
.kode-settings-general{display:flex;flex-direction:column;gap:28px}
.kode-settings-page .kode-settings-group{gap:8px}
.kode-settings-page .kode-settings-group>.kode-settings-group-title,.kode-settings-page .kode-settings-group-title{margin:0;font-size:14px;font-weight:600;line-height:22px}
.kode-settings-page .kode-settings-group>.kode-config-note{margin:-4px 0 4px;color:var(--dsw-alias-label-secondary)}
.kode-settings-page .kode-config-note{font-size:12px;font-weight:400;line-height:18px}
.kode-settings-page .kode-integration-row>span{gap:2px}
.kode-settings-page .kode-settings-card>.kode-integration-row+.kode-integration-row,.kode-settings-page .kode-messaging-settings{border-color:var(--dsw-alias-border-l2)}
.kode-settings-page .kode-settings-card:has(>.kode-settings-scope),.kode-settings-page .kode-settings-card.kode-settings-scope{padding:0;border:0;background:transparent}
.kode-field{display:grid;margin-bottom:18px;color:var(--dsw-alias-label-primary);gap:6px;font-size:13px;line-height:20px}
.kode-field input,.kode-field select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);min-height:36px;padding:7px 12px;transition:border-color 120ms ease}
.kode-field-select{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;line-height:20px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;min-height:36px;padding:7px 12px;transition:border-color 120ms ease}
.kode-field textarea{box-sizing:border-box;width:100%;min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);font:inherit;font-size:14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:8px 12px;line-height:20px}
.kode-field :focus-visible,.kode-field-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.kode-field-select:disabled{opacity:.5;cursor:default}
:is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]{appearance:none;-webkit-appearance:none;flex:none;position:relative;box-sizing:border-box;width:36px;min-width:36px;height:20px;min-height:20px;margin:0;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);cursor:pointer;transition:background-color 160ms ease}
.kode-settings-card:is(.kode-agent-list-card,.kode-hub-sources-card,.kode-ssh-hosts-card)>.kode-agent-rows>.kode-agent-row{border:0;border-radius:0;background:transparent;padding:12px 0}
.kode-ssh-hosts-card .kode-agent-row>.kode-secondary{padding-left:30px}
.kode-ssh-hosts-card>.kode-agent-add,.kode-hub-sources-card>.kode-agent-add{margin-top:8px}
.kode-settings-footer{display:flex;align-items:center;justify-content:flex-end;margin-top:14px;gap:8px}
.kode-session-naming-actions{display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px}
.kode-source-editor-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2);gap:8px}
:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog){max-height:calc(100dvh - 48px)}
:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog)>:first-child{display:flex;flex-direction:column;flex:1 1 auto;min-height:0}
:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog)>:first-child>:last-child:not(:first-child){min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;padding-bottom:2px}
:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog,.kode-source-dialog,.kode-avatar-dialog)>:last-child:not(:first-child){flex:none;flex-wrap:wrap}
.kode-project-dialog .kode-field{margin-bottom:14px}
.kode-project-dialog .kode-disclosure{margin:4px 0 0}
.kode-avatar-footer{position:sticky;bottom:0;z-index:1;display:flex;justify-content:flex-end;gap:8px;padding:12px 0 4px;background:var(--dsw-alias-bg-layer-2);border-top:.5px solid var(--dsw-alias-border-l2)}
.kode-service-recovery{display:grid;gap:8px;min-width:0}
.kode-service-row{display:flex;align-items:center;gap:12px 16px;min-width:0}
.kode-service-row-main{flex:1 1 auto;min-width:0;display:grid;gap:4px}
.kode-service-row-main>.kode-service-status,.kode-service-progress{margin:0}
.kode-service-hint{margin:0;max-width:56ch}
.kode-service-recovery-actions{display:flex;flex:none;flex-wrap:wrap;justify-content:flex-end;gap:8px;margin-left:auto}
.kode-service-status{display:flex;align-items:center;gap:6px;margin:0;font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary)}
.kode-service-status>svg{flex:none}
.kode-service-status[data-state=error]>svg,.kode-service-error-icon{color:var(--dsw-alias-state-error-primary)}
.kode-service-status[data-state=checking]>svg{color:var(--dsw-alias-label-tertiary)}
.kode-spin{animation:kode-loading-spin 850ms linear infinite}
.kode-session-naming-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.kode-session-naming-head>button{margin-left:auto}
.kode-session-naming-title{display:inline-flex;align-items:center;gap:8px;min-width:0}
.kode-session-naming-title>strong{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}

.kode-session-naming-rule{margin:0;max-height:180px;overflow:auto;overscroll-behavior:contain;padding:10px 12px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform);font:12px/18px var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere}
.kode-session-naming-rule:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.kode-session-naming[data-editing]>.kode-field>.kode-session-naming-title{margin-bottom:2px}
.kode-session-naming[data-editing] textarea{font:12px/18px var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}
.kode-session-naming-reset{margin-right:auto}
.kode-settings-page .kode-notification-permission{align-items:center;flex-wrap:wrap;gap:8px 20px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-notification-state{flex:1 1 260px;min-width:0;display:grid;gap:4px}
.kode-notification-state>strong{display:flex;align-items:center;gap:6px;font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary)}
.kode-notification-state>strong>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
.kode-notification-permission[data-tone=on] .kode-notification-state>strong>svg,.kode-notification-permission[data-tone=system] .kode-notification-state>strong>svg{color:var(--dsw-alias-state-success-primary)}
.kode-notification-permission[data-tone=error] .kode-notification-state>strong>svg{color:var(--dsw-alias-state-error-primary)}
.kode-notification-actions{display:flex;flex:none;flex-wrap:wrap;gap:8px;margin-left:auto}
.kode-agent-update-status{display:flex;align-items:flex-start;gap:6px;margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.kode-agent-update-status>svg{flex:none;margin-top:2px}
.kode-agent-update-status[data-phase=updated]>svg{color:var(--dsw-alias-state-success-primary)}
.kode-agent-update-status[data-phase=failed]{color:var(--dsw-alias-state-error-primary)}
:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog,.kode-source-dialog,.kode-avatar-dialog){width:fit-content;min-width:min(var(--kode-dialog-min),100%);max-width:min(var(--kode-dialog-max),100%)}
.kode-confirm-dialog{--kode-dialog-min:360px;--kode-dialog-max:440px}
.kode-handoff-dialog{--kode-dialog-min:400px;--kode-dialog-max:520px}
.kode-project-dialog{--kode-dialog-min:440px;--kode-dialog-max:560px}
.kode-subagent-dialog{--kode-dialog-min:480px;--kode-dialog-max:760px}
.kode-source-dialog{--kode-dialog-min:480px;--kode-dialog-max:960px;max-height:min(720px,calc(100dvh - 64px))}
.kode-source-dialog.kode-source-dialog{width:min(960px,calc(100vw - 48px))}
.kode-avatar-dialog{--kode-dialog-min:560px;--kode-dialog-max:720px;max-height:calc(100dvh - 48px)}
@media(min-width:1440px){.kode-subagent-dialog{--kode-dialog-max:960px}.kode-source-dialog{--kode-dialog-max:1120px;max-height:min(800px,calc(100dvh - 64px))}.kode-source-dialog.kode-source-dialog{width:1120px}}
@media(max-width:600px){.kode-source-dialog.kode-source-dialog{width:100%}:is(.kode-project-dialog,.kode-handoff-dialog,.kode-subagent-dialog,.kode-confirm-dialog,.kode-source-dialog,.kode-avatar-dialog){width:100%;min-width:0}.kode-service-row{flex-direction:column;align-items:stretch}.kode-service-recovery-actions{margin-left:0;justify-content:stretch}.kode-service-recovery-actions>button,.kode-notification-actions>button{flex:1}.kode-notification-actions{margin-left:0;width:100%}.kode-session-naming-actions>button{flex:1 1 auto}.kode-session-naming-reset{margin-right:0}}
@media(prefers-reduced-motion:reduce){.kode-spin{animation:none}}
@media(max-width:600px){.kode-default-models{grid-template-columns:minmax(0,1fr)}.kode-default-models>.kode-config-note{grid-column:1}.kode-source-about dl>div{grid-template-columns:1fr;gap:4px}.kode-agent-row-head{flex-wrap:wrap}.kode-agent-editor{padding:12px}.kode-mobile-pairing-actions{align-items:stretch;flex-direction:column}.kode-mobile-pairing-actions>.kode-service-status{margin:0}.kode-mobile-pairing-actions>button{width:100%}.kode-avatar-grid{grid-template-columns:repeat(auto-fill,minmax(76px,1fr))}.kode-settings-row-control{flex:1 1 100%}.kode-source-editor{grid-template-columns:minmax(0,1fr)}.kode-source-editor-actions>button{flex:1;min-width:0}.kode-settings-page .kode-settings-section,.kode-settings-general{gap:24px}.kode-delete{margin-right:0}}
@media(prefers-reduced-motion:reduce){.kode-fast-switch,.kode-fast-switch-thumb{transition:none}.kode-settings-page *,.kode-field-select,.kode-field input,.kode-settings-page :is(.kode-integration-row,.kode-package-toggle) input[type="checkbox"][role="switch"]::before{transition:none}}
@media(max-width:520px){.kode-agent-row-actions{justify-content:flex-start;margin-inline-start:0}}
@media(max-width:720px){.kode-settings-scope{grid-template-columns:1fr;align-items:start;gap:8px}.kode-settings-layout{display:block;margin-top:16px}.kode-settings-nav{position:static;flex-direction:row;overflow-x:auto;overscroll-behavior-x:contain;padding:0 0 4px;margin:0 0 16px;scrollbar-width:thin}.kode-settings-nav button{flex:0 0 auto;min-height:44px}.kode-settings-page .kode-settings-nav{display:flex;width:100%}.kode-settings-page .kode-settings-nav button{min-height:32px}}
@media(hover:hover){.kode-field input:hover:not(:disabled,:focus),.kode-field textarea:hover:not(:disabled,:focus),.kode-field-select:hover:not(:disabled){border-color:var(--dsw-alias-border-l1)}}
@media(hover:hover) and (prefers-reduced-motion:no-preference){.kode-settings-page .kode-settings-nav button:active,.kode-background-mode>button:active,.kode-avatar-choice:active:not(:disabled),.kode-source-target-option:active:not(:disabled){transform:scale(.97)}.kode-settings-page .kode-settings-nav button,.kode-background-mode>button,.kode-avatar-choice,.kode-source-target-option{transition:background-color 120ms ease,color 120ms ease,border-color 120ms ease,transform 120ms ease}}
@media(pointer:coarse){.kode-settings-page .kode-settings-nav button{min-height:40px}}
.kode-account-launcher{width:100%}
.kode-dsh-native-host{position:fixed;width:0;height:0;overflow:hidden;opacity:0;pointer-events:none}
.kode-account-trigger{display:flex;align-items:center;gap:10px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;text-align:left;transition:background-color 120ms ease,border-color 120ms ease}
.kode-account-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-account-trigger[data-collapsed="true"]{justify-content:center;padding:6px}
.kode-account-avatar{position:relative;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 22%,var(--dsw-alias-bg-layer2));color:var(--dsw-alias-label-primary);font-size:12px;font-weight:700;flex:none;overflow:visible}
.kode-account-avatar>img{width:100%;height:100%;border-radius:999px;object-fit:cover}
.kode-account-avatar-lg{width:40px;height:40px;font-size:15px}
.kode-account-dot{display:inline-block;width:8px;height:8px;border-radius:999px;flex:none;background:var(--dsw-alias-label-quaternary,#6b7280)}
.kode-account-avatar>.kode-account-dot{position:absolute;right:-1px;bottom:-1px;border:1.5px solid var(--dsw-alias-bg-layer1,#14161a)}
.kode-dot-online{background:#22c55e}
.kode-dot-warn{background:#f59e0b}
.kode-dot-error{background:#ef4444}
.kode-dot-idle,.kode-dot-off{background:#6b7280}
.kode-account-copy{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px}
.kode-account-name{font-size:13px;font-weight:600;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-account-sub{font-size:11px;line-height:1.25;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-account-settings{display:flex;flex-direction:column;gap:20px}
.kode-account-profile-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.kode-account-profile-meta{flex:1 1 220px;min-width:0;display:flex;flex-direction:column;gap:4px}
.kode-account-title-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-account-profile-actions,.kode-secondary-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.kode-account-linked-row{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-inline-edit{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.kode-inline-edit input{padding:5px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer1);color:var(--dsw-alias-label-primary);font-size:13px}
.kode-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600;background:var(--dsw-alias-bg-layer2);color:var(--dsw-alias-label-secondary)}
.kode-pill-online{background:color-mix(in srgb,#22c55e 16%,transparent);color:#22c55e}
.kode-pill-warn{background:color-mix(in srgb,#f59e0b 16%,transparent);color:#f59e0b}
.kode-pill-error{background:color-mix(in srgb,#ef4444 16%,transparent);color:#ef4444}
.kode-method-tabs{display:inline-flex;gap:4px;padding:3px;border-radius:10px;background:var(--dsw-alias-bg-layer2);margin:10px 0 12px}
.kode-method-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 11px;border-radius:8px;font-size:12.5px;font-weight:500;cursor:pointer}
.kode-method-tab.is-active{background:var(--dsw-alias-bg-layer1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.kode-account-form{display:flex;flex-direction:column;gap:10px}
.kode-field-row{display:flex;align-items:center;gap:8px}
.kode-field-row>input{flex:1;min-width:0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer1);color:var(--dsw-alias-label-primary);font-size:13px}
.kode-qr-box{display:flex;flex-direction:column;align-items:center;gap:10px;padding:16px;margin-top:10px;border-radius:12px;background:var(--dsw-alias-bg-layer2)}
.kode-qr-image{width:176px;height:176px;border-radius:10px;background:#fff;padding:6px}
.kode-group-head-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.kode-device-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.kode-device-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2)}
.kode-device-row.is-selected{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 7%,transparent)}
.kode-device-row-main{display:flex;align-items:center;gap:10px;min-width:0}
.kode-device-row-main strong{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.kode-secondary-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.kode-success-note{color:var(--dsw-alias-state-success-primary,#22c55e)}
.kode-device-switcher{padding:0 8px 8px}
.kode-device-switcher-btn{display:flex;align-items:center;gap:7px;width:100%;padding:6px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer2);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600;cursor:pointer;text-align:left}
.kode-device-switcher[data-remote="true"] .kode-device-switcher-btn{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 10%,transparent)}
.kode-device-switcher-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-remote-device-sidebar{display:flex;flex-direction:column;gap:10px;padding:0 8px 16px}
.kode-remote-device-banner{display:flex;flex-direction:column;gap:8px;padding:10px;border-radius:10px;background:var(--dsw-alias-bg-layer2);border:1px solid var(--dsw-alias-border-l2)}
.kode-remote-device-banner-title{display:flex;align-items:center;gap:7px;font-size:13px}
.kode-remote-device-banner-actions{display:flex;gap:6px}
.kode-remote-empty{padding:8px 6px}
.kode-remote-group{display:flex;flex-direction:column;gap:3px}
.kode-remote-group-head{display:flex;align-items:center;gap:6px;padding:4px 6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.kode-remote-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-remote-session-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 8px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer}
.kode-remote-session-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-remote-session-row.is-active{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 40%,transparent)}
.kode-remote-session-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.kode-remote-session-copy>strong{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-remote-session-copy>small{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-remote-sidebar-compact{display:flex;flex-direction:column;align-items:center;gap:6px;padding:4px}
.kode-remote-compact-item{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:9px;border:1px solid transparent;background:transparent;cursor:pointer;padding:0}
.kode-remote-compact-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-remote-compact-item.is-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary,#5b8def) 14%,transparent)}
.kode-remote-empty-stage{display:flex;align-items:center;justify-content:center;height:100%;min-height:320px;padding:24px}
.kode-remote-empty-card{display:flex;flex-direction:column;gap:12px;max-width:440px;padding:22px 24px;border-radius:14px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer2)}
.kode-remote-conv-title{display:flex;align-items:center;gap:10px;min-width:0}
`

    document.head.append(style)
    ctx.effect(() => () => style.remove(), 'kode.agent-styles')
