/** Shared DSH Operate surface: conversation first, details on demand. */
export const collaborationLayout = `
.kode-collab-composer,.kode-discussion-native-composer{--dsh-composer-text-max-height:min(220px,25dvh);--dsh-composer-side-clearance:0px;--dsh-composer-card-max-width:780px;--dsh-composer-dock-inset:0px}
.kode-discussion-reading-column,.kode-collab-reading-column{box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto}
.kode-collab-question-empty{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}.kode-collab-question-empty button{font-size:11px;padding:0}
.kode-managed-limit{font-size:11px;padding:4px 6px;margin:4px 0}.kode-managed-limit summary{cursor:pointer}.kode-managed-limit p{margin:6px 0}.kode-managed-limit summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-discussions{min-width:0;container-type:inline-size;container-name:kode-discussions}
.kode-discussion-heading,.kode-collab-header{min-height:68px;padding:12px 24px;box-sizing:border-box;gap:12px;flex:none}
.kode-discussion-heading.kode-discussion-heading-with-tabs,.kode-collab-header.kode-collab-header-with-tabs{border-bottom:0}
.kode-discussion-view-tabs,.kode-collab-view-tabs{box-sizing:border-box;flex:none;padding:0 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.kode-discussion-heading-icon{display:flex;flex:none;color:var(--dsw-alias-label-secondary)}
.kode-discussion-heading-copy,.kode-collab-heading-copy{flex:1;min-width:0}
.kode-discussion-heading h2,.kode-collab-heading-copy h1{font-size:17px;line-height:24px;margin:0;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kode-discussion-heading small,.kode-collab-heading-copy small{display:block;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-discussion-heading-actions{gap:8px;flex:none}
.kode-discussion-split{min-width:0;overflow:hidden}
.kode-discussion-timeline{flex:1}
.kode-discussion-detail{flex:0 0 clamp(380px,40%,480px);max-width:none;background:var(--dsw-alias-bg-base)}
.kode-discussion-detail-native{flex:1 1 auto;width:100%;height:100%;max-width:none;border-left:0}
.kode-discussion-detail>header{flex:none;gap:12px;padding:12px 20px;min-height:64px;box-sizing:border-box}
.kode-discussion-detail>header>div:first-child{flex-direction:column;gap:3px;min-width:0}
.kode-discussion-detail>header>div:last-child{flex:none}
.kode-discussion-detail>header strong{font-size:15px}.kode-discussion-detail>header strong:focus{outline:none}
.kode-discussion-detail>header small{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-discussion-split[data-full=true]>.kode-discussion-detail{flex:1}
.kode-discussion-messages{min-height:0;overscroll-behavior:contain;padding:12px 24px;scrollbar-gutter:stable}
.kode-discussion-message{padding:16px 0}
.kode-discussion-message>.kode-discussion-avatar{width:32px;height:32px;border-radius:var(--dsw-radius-md)}
.kode-discussion-message header{gap:10px;font-size:13px;line-height:20px;flex-wrap:wrap}
.kode-discussion-message time{font-variant-numeric:tabular-nums}
.kode-discussion-prose{font-size:14px;line-height:1.65;overflow-wrap:anywhere;max-width:72ch}
.kode-discussion-prose p{margin:6px 0 10px}.kode-discussion-prose p:last-child{margin-bottom:8px}
.kode-discussion-prose pre{white-space:pre-wrap;overflow-wrap:anywhere}
.kode-discussion-delivery{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.kode-discussion-mentions{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:0 0 4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px}
.kode-discussion-mention{display:inline;padding:0;border:0;background:transparent;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));font:inherit;cursor:pointer;text-underline-offset:3px}
.kode-discussion-mention:hover{text-decoration:underline}
.kode-discussion-reply{display:inline-flex;align-items:center;margin-top:8px;padding:4px 8px;min-height:30px}
.kode-discussion-reply[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}
.kode-discussion-message[data-thread-root=true]{padding-bottom:20px}
.kode-discussion-detail .kode-discussion-messages{padding:8px 20px}
.kode-discussion-task-tools{flex:none;border-block:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.kode-discussion-task-tools>summary{display:flex;align-items:center;gap:8px;padding:10px 20px;min-height:20px;font-size:12px;cursor:pointer;list-style:none}
.kode-discussion-task-tools>summary::-webkit-details-marker{display:none}
.kode-discussion-task-tools>summary>svg:last-child{margin-left:auto}
.kode-discussion-task-tools[open]>summary>svg:last-child{transform:rotate(180deg)}
.kode-discussion-task-tools>.kode-discussion-task-panel{max-height:min(260px,32dvh);padding:4px 20px 16px;border-bottom:0;overflow:auto}
.kode-discussion-task-tools>summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.kode-discussion-native-composer{box-sizing:border-box;width:calc(100% - 40px);max-width:var(--dsh-composer-card-max-width,780px);margin:12px auto 16px;flex:none;min-width:0}
.kode-discussion-native-composer>small{line-height:18px}
.kode-discussion-recipient{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0;margin:0 0 8px;color:var(--dsw-alias-label-secondary)}
.kode-discussion-row{min-height:32px}
.kode-discussion-empty{padding:28px 8px;font-size:14px;line-height:1.6}
.kode-discussion-empty h3{margin:0 0 8px;color:var(--dsw-alias-label-primary);font-size:16px}
.kode-discussion-empty p{max-width:48ch;margin:0}
.kode-discussion-home{box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:16px;height:100%;padding:clamp(24px,7vw,88px);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.kode-discussion-home h1{font-size:24px;font-weight:600;margin:0}
.kode-discussion-home p{font-size:14px;line-height:1.7;max-width:48ch;margin:0;color:var(--dsw-alias-label-secondary)}
.kode-discussion-home-links{display:flex;flex-wrap:wrap;gap:8px}
.kode-discussion-home-links button{display:flex;align-items:center;gap:6px}
.kode-discussions :is(button,select,summary):focus-visible,.kode-discussion-home button:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-discussions ::selection{color:var(--dsw-alias-label-primary);background:var(--dsw-specific-sidebar-nav-item-active)}
.kode-collab-channel-hint{display:flex;flex:none;align-items:center;justify-content:space-between;gap:12px;padding:8px 24px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-collab-channel-hint button{font-size:12px;min-height:28px;flex:none}
.kode-collab-workspace{flex-direction:row}
.kode-collab-thread{flex:1}
.kode-collab-inspector{display:flex;flex-direction:column;flex:0 0 clamp(380px,42%,520px);min-height:0;min-width:0;border-left:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base)}
.kode-collab-inspector>header{display:flex;align-items:center;justify-content:space-between;padding:12px 20px;min-height:60px;box-sizing:border-box;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-collab-inspector>header strong{font-size:15px}.kode-collab-inspector>header strong:focus{outline:none}
.kode-collab-inspector>.kode-collab-process{flex:1;min-height:0;max-height:none;padding:16px 20px;border:0;overflow:auto;overscroll-behavior:contain}
.kode-collab-inspector .kode-collab-process{overflow-wrap:anywhere}.kode-collab-inspector .kode-collab-process>small{display:block;max-width:100%;overflow-wrap:anywhere}.kode-collab-inspector .kode-collab-process pre{white-space:pre-wrap;overflow-wrap:anywhere;max-width:100%}
.kode-collab-messages{padding:24px 32px}
.kode-collab-message-body{max-width:min(72ch,calc(100% - 46px));flex:1}
.kode-collab-message-content{background:transparent;border:0;border-radius:0;padding:0;line-height:1.7;font-size:14px}
.kode-collab-message strong{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.kode-collab-message[data-author=human]{flex-direction:row}
.kode-collab-message[data-author=human] .kode-collab-message-body{align-items:flex-start}
.kode-collab-message[data-author=human] .kode-collab-message-content{background:transparent;padding:0;border-radius:0}
.kode-collab-message-avatar{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1)}
.kode-collab-excerpt-label{display:block;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.kode-collab-excerpt{white-space:pre-wrap;margin:0}
.kode-collab-text-link{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);border:0;background:transparent;padding:6px 0;cursor:pointer;text-align:start;line-height:20px;text-underline-offset:3px}
.kode-collab-text-link:hover{text-decoration:underline}
.kode-collab-text-link:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-collab-composer{box-sizing:border-box;width:calc(100% - 48px);max-width:var(--dsh-composer-card-max-width,780px);margin:12px auto 16px;padding:0;border:0;border-radius:0;background:transparent;gap:6px}
.kode-collab-composer-hint{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.kode-collab-composer .kode-collab-draft-status:empty{display:none}
.kode-collab-composer .kode-collab-draft-status{font-size:11px;line-height:18px}
@container kode-discussions (max-width:840px){.kode-discussion-split:has(.kode-discussion-detail)>.kode-discussion-timeline{display:none}.kode-discussion-detail{flex:1;max-width:none;border-left:0}.kode-discussion-detail>header>div:last-child>.kode-collab-icon-button:first-child{display:none}}
@container kode-collab (max-width:840px){.kode-collab-workspace:has(.kode-collab-inspector)>.kode-collab-thread{display:none}.kode-collab-inspector{flex:1;max-width:none;border-left:0}}
@container kode-discussions (max-width:480px){.kode-discussion-heading{padding:12px 16px;gap:8px}.kode-discussion-heading h2{font-size:16px}.kode-discussion-heading small{font-size:11px}.kode-discussion-heading-actions{gap:4px}.kode-discussion-heading-actions>button{font-size:12px;padding:6px}.kode-discussion-messages,.kode-discussion-detail .kode-discussion-messages{padding:8px 16px}.kode-discussion-native-composer{margin:10px auto 12px}.kode-discussion-recipient{gap:8px}.kode-discussion-detail>header{padding:10px 16px}.kode-discussion-message{gap:10px}.kode-discussion-task-tools>summary{padding-inline:16px}.kode-discussion-task-tools>.kode-discussion-task-panel{padding-inline:16px}}
@container kode-collab (max-width:480px){.kode-collab-header{padding:12px 16px}.kode-collab-channel-hint{padding:8px 16px;align-items:flex-start}.kode-collab-messages{padding:20px 16px}.kode-collab-composer{margin:10px auto 12px}.kode-collab-heading-copy h1{font-size:16px}}

/* Emil design-engineering pass: quiet hierarchy, immediate navigation, pointer-only feedback.
   Preserve native DSH tokens/composer and never animate channel, thread or keyboard navigation. */
.kode-discussion-message{position:relative;padding-block:14px}
.kode-discussion-message+.kode-discussion-message{border-top:0}
.kode-discussion-message header time{font-size:11px;letter-spacing:.01em}
.kode-discussion-reply{min-height:32px;margin-top:6px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary)}
.kode-discussion-reply[aria-expanded=true]{color:var(--dsw-alias-label-primary);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}
.kode-discussion-detail>header{background:var(--dsw-alias-bg-base)}
.kode-discussion-task-tools>summary{user-select:none}
.kode-discussion-task-tools>summary:focus-visible{outline-offset:-3px}
.kode-discussion-reply,.kode-collab-icon-button{touch-action:manipulation}
@media(hover:hover) and (pointer:fine){
 .kode-discussion-reply:not(:disabled),.kode-collab-icon-button:not(:disabled){transition:transform 120ms cubic-bezier(.23,1,.32,1)}
 .kode-discussion-reply:not(:disabled):active:not(:focus-visible),.kode-collab-icon-button:not(:disabled):active:not(:focus-visible){transform:scale(.97)}
 .kode-discussion-reply:not(:disabled):hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
}
@media(pointer:coarse){
 .kode-discussion-reply{min-height:44px;padding-inline:12px}
 .kode-discussion-heading-actions .kode-collab-icon-button,.kode-discussion-detail>header .kode-collab-icon-button,.kode-collab-inspector>header .kode-collab-icon-button{min-width:44px;width:44px;min-height:44px;height:44px}
 .kode-discussion-task-tools>summary{min-height:44px;box-sizing:border-box}
 }
@media(prefers-reduced-motion:reduce){
 .kode-discussion-reply:not(:disabled),.kode-collab-icon-button:not(:disabled){transition:none}
 .kode-discussion-reply:not(:disabled):active,.kode-collab-icon-button:not(:disabled):active{transform:none}
}

/* Slack-style thread entry: pointer action at right, persistent reply summary below. */
.kode-discussion-message .kode-discussion-reply-action{position:absolute;right:0;top:0;margin:0;z-index:1;min-height:32px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);box-shadow:0 2px 6px #0000000a}
.kode-discussion-thread-summary{display:inline-flex;align-items:center;gap:8px;max-width:100%;min-height:32px;padding:3px 0;margin-top:4px;font-size:12px;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));background:transparent;border:0;cursor:pointer;touch-action:manipulation}
.kode-discussion-reply-avatars{display:inline-flex;align-items:center;gap:3px;flex:none}
.kode-discussion-reply-avatars .kode-discussion-avatar{width:22px;height:22px;border-radius:var(--dsw-radius-sm);overflow:hidden}
.kode-discussion-reply-avatars img{width:100%;height:100%;object-fit:cover}
@media(hover:hover) and (pointer:fine){.kode-discussion-message .kode-discussion-reply-action{opacity:0;pointer-events:none}.kode-discussion-message:hover .kode-discussion-reply-action,.kode-discussion-message:focus-within .kode-discussion-reply-action{opacity:1;pointer-events:auto}.kode-discussion-thread-summary:hover{background:var(--dsw-alias-interactive-bg-hover)}}
@media(hover:none),(pointer:coarse){.kode-discussion-message .kode-discussion-reply-action{position:static;min-height:44px;margin-top:6px}.kode-discussion-thread-summary{min-height:44px}}
`
