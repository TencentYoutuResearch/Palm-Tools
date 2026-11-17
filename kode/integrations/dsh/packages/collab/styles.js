import { collaborationLayout } from './collaboration-layout.js'
export const styles = `
.kode-collab-mode-switch.kode-collab-brand-switch{flex:1;min-width:0;padding:0;-webkit-app-region:no-drag}.kode-collab-mode-switch.kode-collab-brand-switch button{min-height:36px;padding:4px 0;font-weight:600}.kode-collab-brand-switch button>span{white-space:nowrap;text-overflow:ellipsis;overflow:hidden}.kode-collab-brand-switch svg{flex:none}
.kode-brand-identity{display:inline-flex;align-items:center;gap:8px;min-width:0}.kode-brand-mark{flex:none;object-fit:contain}.kode-brand-wordmark{display:inline-flex;align-items:center;gap:7px;font-family:Montserrat,var(--ds-font-family,sans-serif);font-size:21px;font-weight:500;letter-spacing:-.035em;line-height:26px;font-synthesis:none}.kode-brand-product{font-family:Montserrat,var(--ds-font-family,sans-serif);font-size:9px;font-weight:500;letter-spacing:.12em;line-height:17px;padding:0 5px 0 6px;border-radius:3px;text-transform:uppercase;color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-label-primary)}

.kode-collab-mode-switch{padding:4px 8px 8px;flex:none}.kode-collab-mode-switch button{display:flex;align-items:center;gap:8px;width:100%;justify-content:flex-start;background:transparent;border:0;box-shadow:none}.kode-collab-mode-switch button>span{flex:1;text-align:left}

.kode-collab-dependencies{min-width:0;overflow-wrap:anywhere}.kode-collab-dependencies article{border-top:1px solid var(--dsw-alias-border-l2);padding-block:8px}.kode-collab-dependencies pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;font:inherit}.kode-collab-dependencies summary{cursor:pointer}.kode-collab-dependencies summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.kode-collab-process:has(.kode-collab-trace-reader){max-height:70%}.kode-collab-trace{margin-block:16px}.kode-collab-trace-reader{padding-block:12px;min-width:0}.kode-collab-trace-reader h4{margin:0}.kode-collab-trace-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-block:12px}.kode-collab-trace-filters label{display:flex;flex-direction:column;gap:6px;flex:1 1 12rem;min-width:0}.kode-collab-trace-filters input,.kode-collab-trace-filters select{box-sizing:border-box;min-width:0;width:100%;padding:8px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm)}.kode-collab-trace-filters input:focus-visible,.kode-collab-trace-filters select:focus-visible{outline:2px solid currentColor;outline-offset:2px}.kode-collab-trace-records{list-style:none;margin:12px 0;padding:0}.kode-collab-trace-record{border-top:1px solid var(--dsw-alias-border-l2);padding-block:8px;overflow-wrap:anywhere}.kode-collab-trace-reader summary{cursor:pointer;overflow-wrap:anywhere}.kode-collab-trace-reader summary:focus-visible{outline:2px solid currentColor;outline-offset:2px}.kode-collab-trace-reader pre{box-sizing:border-box;max-width:100%;max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);font-size:13px}.kode-collab-trace-export{border-top:1px solid var(--dsw-alias-border-l2);margin-top:16px;padding-top:12px}

.kode-collab-delivery-decision textarea,.kode-collab-delivery-decision select{box-sizing:border-box;width:100%;max-width:48rem;padding:8px;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);font:inherit}
.kode-collab-delivery-decision textarea:focus-visible,.kode-collab-delivery-decision select:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.kode-collab-delivery-decision form{display:grid;gap:12px}
.kode-collab-unread{display:inline-block;margin-inline-start:0;padding:1px 6px;border:1px solid currentColor;border-radius:10px;font-size:12px;font-variant-numeric:tabular-nums;}
.kode-collab-contacts,.kode-collab-conversation,.kode-collab-empty{box-sizing:border-box;color:var(--dsw-alias-label-primary);font:inherit;background:var(--dsw-alias-bg-base);min-width:0}
.kode-collab-contacts{background:var(--dsw-specific-sidebar-fill);display:flex;flex-direction:column;height:100%;max-width:100%;padding:12px 8px;gap:12px}
.kode-collab-toolbar,.kode-collab-footer,.kode-collab-header{display:flex;align-items:center;gap:8px;min-width:0}
.kode-collab-footer{margin-top:auto;flex-wrap:wrap}.kode-collab-toolbar strong{overflow:hidden;text-overflow:ellipsis}
.kode-collab-contact-list{overflow:auto;min-height:0;flex:1}.kode-collab-contact{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;width:100%;padding:10px 12px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kode-collab-contact>.kode-collab-note{grid-column:1/-1}.kode-collab-contact-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-collab-contact:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}.kode-collab-contact[aria-current=page]{background:var(--dsw-specific-sidebar-nav-item-active)}
.kode-collab-button{font:inherit;color:inherit;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:transparent;padding:6px 10px;cursor:pointer;flex-shrink:0}.kode-collab-button:disabled{cursor:default;color:var(--dsw-alias-label-secondary)}
.kode-collab-button:focus-visible,.kode-collab-contact:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.kode-collab-conversation{height:100%;display:flex;flex-direction:column}.kode-collab-header{justify-content:space-between;padding:20px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-collab-header h1,.kode-collab-empty h1{font-size:20px;font-weight:600;line-height:1.4;margin:0;overflow-wrap:anywhere}
.kode-collab-messages{flex:1;min-height:0;overflow:auto;padding:24px;scrollbar-gutter:stable}.kode-collab-message{max-width:72ch;margin:0 auto 28px}.kode-collab-message strong{display:block;font-size:13px;margin-bottom:8px;color:var(--dsw-alias-label-secondary)}.kode-collab-message-content{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.65}
.kode-collab-note{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:4px 12px}.kode-collab-preview{margin:0;padding:12px 24px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-collab-empty{height:100%;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:clamp(24px,6vw,80px);gap:16px}.kode-collab-empty p{max-width:60ch;line-height:1.6;margin:0}
.kode-collab-composer{border-top:1px solid var(--dsw-alias-border-l2);padding:16px 24px;display:flex;flex-direction:column;gap:10px}.kode-collab-input-label{display:flex;flex-direction:column;gap:6px;font-size:13px}.kode-collab-composer textarea{box-sizing:border-box;width:100%;resize:vertical;max-height:220px;min-height:72px;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:10px;line-height:1.6}.kode-collab-composer textarea:focus-visible{outline:2px solid currentColor;outline-offset:2px}.kode-collab-pending{white-space:pre-wrap;overflow-wrap:anywhere;max-height:80px;overflow:auto;font-size:13px;margin:6px 0}
.kode-collab-process{max-height:40%;overflow:auto;padding:12px 24px;border-bottom:1px solid var(--dsw-alias-border-l2)}.kode-collab-process h2{font-size:16px;margin:0}.kode-collab-run{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.kode-collab-run h3{font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.kode-collab-run p{font-size:13px}.kode-collab-run small{overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
@media(max-width:640px){.kode-collab-header{padding:16px;flex-wrap:wrap}.kode-collab-messages{padding:16px}.kode-collab-preview{padding:12px 16px}}

.kode-collab-search{display:flex;flex-direction:column;gap:8px;padding:12px}.kode-collab-search input{box-sizing:border-box;min-width:0;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px}.kode-collab-search input:focus-visible{outline:2px solid currentColor;outline-offset:2px}

/* Operate surface: one conversation column and an independent evidence inspector. */
.kode-collab-header{flex-wrap:wrap;gap:12px;padding:16px 24px;flex-shrink:0}
.kode-collab-header h1{flex:1 1 12rem;font-size:18px}
.kode-collab-header-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.kode-collab-workspace{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.kode-collab-thread{display:flex;flex:1;flex-direction:column;min-height:0;min-width:0;overflow:hidden}
.kode-collab-workspace>.kode-collab-process{flex:0 1 auto;min-height:0;max-height:45%;overscroll-behavior:contain;scrollbar-gutter:stable}
.kode-collab-button{min-height:32px;line-height:1.5;white-space:normal;max-width:100%;overflow-wrap:anywhere}
.kode-collab-button:not(:disabled):hover{background:var(--dsw-specific-sidebar-nav-item-hover)}
.kode-collab-button:not(:disabled):active{background:var(--dsw-specific-sidebar-nav-item-active)}
.kode-collab-button[aria-expanded=true]{background:var(--dsw-specific-sidebar-nav-item-active)}
.kode-collab-button-primary:not(:disabled){color:var(--dsw-alias-bg-base);background:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-primary)}
.kode-collab-button-primary:not(:disabled):hover{background:var(--dsw-alias-label-secondary)}
.kode-collab-button:disabled{opacity:.65}
.kode-collab-attention{display:flex;flex-shrink:0;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:8px 24px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary);font-size:13px}
.kode-collab-contact{row-gap:4px;min-height:44px}
.kode-collab-contact>.kode-collab-note{padding:0;grid-column:1/-1;text-align:start}
.kode-collab-contact[aria-current=page] .kode-collab-contact-name{font-weight:600}
.kode-collab-search{padding:0 4px}
.kode-collab-search>div{display:flex;flex-wrap:wrap;gap:8px}
.kode-collab-contacts>.kode-collab-toolbar .kode-collab-button{padding-inline:4px}
.kode-collab-messages{overscroll-behavior:contain;min-width:0}
.kode-collab-message{padding:0;line-height:1.65}
.kode-collab-message[data-author=human] .kode-collab-message-content{background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);padding:12px 16px}
.kode-collab-message-navigation{display:flex;flex-shrink:0;justify-content:center;padding:4px 16px 8px;background:var(--dsw-alias-bg-base)}
.kode-collab-composer{flex-shrink:0;padding:12px 24px;gap:8px}
.kode-collab-composer .kode-collab-note{padding:0;margin:0}
.kode-collab-composer textarea{min-height:64px;max-height:min(220px,25dvh)}
.kode-collab-process>.kode-collab-toolbar{justify-content:space-between;flex-wrap:wrap;padding-block:4px 12px}
.kode-collab-run{padding-block:16px}
.kode-collab-run>small{display:block;margin-block:8px;font-variant-numeric:tabular-nums}
.kode-collab-run-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-block:8px;color:var(--dsw-alias-label-primary)}
.kode-collab-run-status>svg{flex:none}
.kode-collab-run-status[data-tone=success]>svg{color:var(--dsw-alias-state-success-primary)}
.kode-collab-run-status[data-tone=error]>svg{color:var(--dsw-alias-state-error-primary)}
.kode-collab-run-status[data-tone=warning]>svg{color:var(--dsw-alias-state-warn-label)}
.kode-collab-run-status[data-tone=active]>svg{color:var(--dsw-alias-state-business-primary)}
.kode-collab-delivery-label{flex-basis:100%;color:var(--dsw-alias-label-secondary);padding-inline-start:22px}
.kode-collab-run-detail{margin-top:16px;min-width:0;overflow-wrap:anywhere}
.kode-collab-run-detail h4{margin-block:24px 8px;font-weight:600}
.kode-collab-run-detail ol{padding-inline-start:20px}
.kode-collab-run-detail li{margin-block:12px}
.kode-collab-run-detail .kode-collab-button{margin-block:4px}
.kode-collab-run-detail .kode-collab-note{padding-inline:0}
.kode-collab-delivery-decision{padding-block:12px;border-block:1px solid var(--dsw-alias-border-l2)}
.kode-collab-builder{height:100%;box-sizing:border-box;max-width:72rem;margin-inline:auto;overflow-wrap:anywhere}
.kode-collab-builder h1{font-size:22px;font-weight:600}
.kode-collab-builder h2{font-size:18px;line-height:1.5}
.kode-collab-builder h3{font-size:16px;margin-block:24px 12px}
.kode-collab-builder form{display:grid;gap:12px;min-width:0}
.kode-collab-builder input,.kode-collab-builder textarea,.kode-collab-builder select{box-sizing:border-box;max-width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px}

.kode-collab-conversation{container-type:inline-size;container-name:kode-collab;min-height:0}
@media(max-width:640px){
  .kode-collab-header{padding:12px 16px;gap:8px}
  .kode-collab-header-actions{gap:6px;width:100%}
  .kode-collab-header-actions .kode-collab-button{flex:1 1 auto;padding:6px}
  .kode-collab-composer,.kode-collab-workspace>.kode-collab-process{padding:12px 16px}
  .kode-collab-attention{padding-inline:16px}
}
@media(forced-colors:active){.kode-collab-contact[aria-current=page]{outline:1px solid Highlight;outline-offset:-2px}.kode-collab-run-status>svg{color:CanvasText}}

.kode-collab-icon-button{display:inline-flex;align-items:center;justify-content:center;position:relative;width:36px;height:36px;min-width:36px;min-height:36px;padding:0;border-color:transparent;flex-shrink:0}
.kode-collab-icon-button>svg{flex:none;pointer-events:none}
.kode-collab-icon-button.kode-collab-icon-button-sm,.kode-sidebar-empty .kode-collab-icon-button,[role=status] .kode-collab-icon-button,.kode-config-note .kode-collab-icon-button{width:22px;height:22px;min-width:22px;min-height:22px;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);vertical-align:middle}
.kode-collab-icon-button.kode-collab-icon-button-sm>svg,.kode-sidebar-empty .kode-collab-icon-button>svg,[role=status] .kode-collab-icon-button>svg,.kode-config-note .kode-collab-icon-button>svg{width:14px;height:14px}
.kode-collab-icon-button.kode-collab-icon-button-sm:hover:not(:disabled),.kode-sidebar-empty .kode-collab-icon-button:hover:not(:disabled),[role=status] .kode-collab-icon-button:hover:not(:disabled),.kode-config-note .kode-collab-icon-button:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.kode-collab-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap;border:0}
.kode-collab-header-actions{flex-wrap:nowrap;gap:4px;margin-inline-start:auto}
.kode-collab-header h1{flex:1 1 8rem}
.kode-collab-search{position:relative;padding:0 4px}
.kode-collab-search>div{justify-content:flex-end}
.kode-collab-search .kode-collab-icon-button{width:32px;min-width:32px;height:32px;min-height:32px}
.kode-collab-composer>.kode-collab-toolbar{justify-content:flex-end}
.kode-collab-composer .kode-collab-button-primary{border-radius:50%}
.kode-collab-run-heading{display:flex;align-items:flex-start;gap:8px;justify-content:space-between}
.kode-collab-run-heading h3{flex:1;padding-block:7px}
.kode-collab-run>small{font-size:11px;margin-block:4px 8px}
@media(max-width:640px){.kode-collab-header{flex-wrap:nowrap}.kode-collab-header h1{flex:1 1 auto;font-size:16px}.kode-collab-header-actions{width:auto}.kode-collab-header-actions .kode-collab-button{padding:0;flex:0 0 auto}.kode-collab-icon-button{width:40px;height:40px;min-width:40px;min-height:40px}}

.kode-collab-search{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:6px}
.kode-collab-search>.kode-collab-input-label{grid-column:1}
.kode-collab-search>div{grid-column:2;gap:2px;align-items:center}
.kode-collab-search>p{grid-column:1/-1}

/* Mode changes the sidebar; the central dsh shell and selected view stay put. */
.kode-collab-contact{grid-template-columns:32px minmax(0,1fr) auto;column-gap:10px}
.kode-collab-contact-identity{display:flex;align-items:center;justify-content:center;grid-column:1;grid-row:1 / span 3;width:32px;height:32px;background:var(--dsw-alias-bg-layer-1);border-radius:var(--dsw-radius-sm);font-size:14px;font-weight:600}
.kode-collab-contact-name{grid-column:2}
.kode-collab-contact>.kode-collab-note{grid-column:2/-1}
.kode-collab-contact>.kode-collab-unread{grid-column:3}

/* QQ reference: taller two-line contacts and opposing bubbles, using dsh surfaces. */
.kode-collab-contact{box-sizing:border-box;min-height:76px;padding:12px 10px;grid-template-columns:44px minmax(0,1fr) auto;grid-template-rows:22px 20px;align-content:center;row-gap:2px}
.kode-collab-contact-identity{width:44px;height:44px;grid-row:1 / span 2;border-radius:50%;font-size:17px}
.kode-collab-contact-name,.kode-collab-builder-contact-name{grid-column:2;grid-row:1;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-collab-contact-time{grid-column:3;grid-row:1;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.kode-collab-contact-preview{grid-column:2 / -1;grid-row:2;color:var(--dsw-alias-label-secondary);font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-collab-contact>.kode-collab-unread{grid-column:3;grid-row:2;background:var(--dsw-specific-sidebar-nav-item-active);border:0}
.kode-collab-contact:has(>.kode-collab-unread) .kode-collab-contact-preview{grid-column:2}
.kode-collab-contact>.kode-collab-note{grid-column:2 / -1;font-size:11px;line-height:1.4}
.kode-collab-contact>small{grid-column:2 / -1;font-size:11px;color:var(--dsw-alias-label-secondary)}
.kode-collab-message{display:flex;gap:12px;align-items:flex-start;max-width:none;margin:0 0 28px}
.kode-collab-message-avatar{display:flex;align-items:center;justify-content:center;width:34px;height:34px;flex:0 0 34px;border-radius:50%;font-size:13px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-label-primary) 8%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.kode-collab-message-body{display:flex;flex-direction:column;align-items:flex-start;min-width:0;max-width:min(72ch,calc(100% - 46px))}
.kode-collab-message strong{font-size:12px;font-weight:500;margin:0 0 6px}
.kode-collab-message-content{box-sizing:border-box;min-width:0;max-width:100%;padding:10px 14px;border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-label-primary) 5%,var(--dsw-alias-bg-base));border:1px solid var(--dsw-alias-border-l2)}
.kode-collab-message[data-author=human]{flex-direction:row-reverse}
.kode-collab-message[data-author=human] .kode-collab-message-body{align-items:flex-end}
.kode-collab-message[data-author=human] .kode-collab-message-content{padding:10px 14px;border-radius:12px;background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary)}
@media(max-width:640px){.kode-collab-message{gap:8px}.kode-collab-message-avatar{width:28px;height:28px;flex-basis:28px}.kode-collab-message-body{max-width:calc(100% - 36px)}}



/* dsh owns the sidebar shell. Only its workspace region is an IM list. */
.kode-collab-contacts{box-sizing:border-box;width:100%;min-height:0;height:100%;padding:8px;gap:8px;background:transparent}
.kode-collab-contacts[data-wide=false]{align-items:center;padding:4px 0}
.kode-collab-contact-list{min-height:0;overflow:auto;flex:1}
.kode-collab-contact{width:100%;border:0;background:transparent;text-align:start;border-radius:var(--dsw-radius-md)}
.kode-collab-search{padding:0;margin:0 0 2px;grid-template-columns:minmax(0,1fr) auto}
.kode-collab-search>.kode-collab-input-label{display:block;min-width:0}
.kode-collab-search input{font:inherit}
.kode-collab-composer{margin:10px 24px 18px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,18px);background:var(--dsw-alias-bg-base)}
.kode-collab-composer textarea{min-height:52px;resize:none;border:0;padding:4px 2px;background:transparent}
.kode-collab-composer>.kode-collab-toolbar{margin:0}
.kode-collab-composer .kode-collab-send{border-radius:50%}
.kode-collab-appearance{padding:16px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.kode-collab-appearance h2{font-size:15px;margin:0}
.kode-collab-appearance>label{display:flex;align-items:center;gap:6px;font-size:13px}
.kode-collab-header-avatar{display:flex;align-items:center;justify-content:center;flex:none;width:32px;height:32px}
.kode-collab-message-content>div>p:first-child{margin-top:0}.kode-collab-message-content>div>p:last-child{margin-bottom:0}
@media(max-width:640px){.kode-collab-composer{margin:8px 12px 12px;padding:10px 12px}.kode-collab-appearance{padding:12px 16px}.kode-collab-header-avatar{display:none}}

/* Native Input owns its border and padding; MarkdownText owns paragraph rhythm. */
.kode-collab-search input{border:0;background:transparent;box-shadow:none;padding:0;outline:none;min-width:0}
.kode-collab-message-content{white-space:normal}

.kode-collab-message[data-author=human] .kode-collab-message-content{white-space:pre-wrap}

/* One native project tree. Extras live inside canonical real workspace groups. */
.kode-collab-unified-sidebar{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding:0}
.kode-collab-unified-sidebar [hidden]{display:none!important}
.kode-sidebar-section{margin:0;min-width:0;flex:none}
/* Touch and other non-hover inputs must not depend on discovering a hover state. */
@media(hover:none),(pointer:coarse){.kode-native-tree [data-row-actions]{display:inline-flex}}
.kode-native-css-missing{margin:0;padding:4px 8px 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.kode-sidebar-section-body{min-width:0}
.kode-workspace-sessions-toggle{margin-top:4px;justify-content:flex-start}
.kode-collab-unified-sidebar>.kode-sidebar-section{flex:none;margin-right:12px}
.kode-collab-unified-sidebar[data-wide=false]>.kode-sidebar-section>summary{display:none}
.kode-collab-unified-sidebar[data-wide=false] .kode-collab-direct{padding-inline:4px}
/* Additional targets follow the native Session row's 32px/14px rhythm.
   SessionRow itself is private; never borrow its identity, drag or menu state. */
.kode-sidebar-row{box-sizing:border-box;display:flex;align-items:center;gap:0;min-height:32px;height:32px;width:100%;padding:0 8px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:20px;text-align:start;cursor:pointer}
.kode-sidebar-row:hover,.kode-sidebar-row[aria-current=page]{background:var(--dsw-alias-interactive-bg-hover)}
.kode-sidebar-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.kode-sidebar-row .kode-collab-contact-name,.kode-sidebar-row .kode-collab-builder-contact-name,.kode-sidebar-row .kode-sidebar-app-label{flex:1;min-width:0;margin:0 6px 0 4px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:14px;font-weight:400;line-height:20px}
.kode-sidebar-row[aria-current=page] .kode-collab-contact-name{font-weight:400}
.kode-collab-channel-mark,.kode-sidebar-row .kode-collab-contact-identity,.kode-sidebar-app-icon{display:flex;align-items:center;justify-content:center;width:20px;height:20px;flex:none;background:transparent;color:var(--dsw-alias-label-secondary)}
.kode-collab-channel-mark{font-size:16px}
.kode-sidebar-row>.kode-collab-note,.kode-sidebar-row>small{flex:none;padding:0;margin:0 0 0 4px;font-size:10px;line-height:16px;white-space:nowrap}
.kode-sidebar-row>.kode-collab-unread{flex:none;margin-left:4px;font-size:10px;min-width:16px;height:16px;line-height:16px}

/* Size against the conversation pane: an expanded sidebar can leave a narrow pane on a wide window. */
.kode-collab-conversation{min-width:0;container-type:inline-size}
.kode-collab-header h1{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@container(max-width:280px){
  .kode-collab-header{flex-wrap:wrap;padding:12px;gap:8px}
  .kode-collab-header h1{flex:1 1 100%;min-width:0}
  .kode-collab-header-avatar{display:none}
  .kode-collab-header-actions{width:100%;justify-content:flex-start;gap:4px;margin-inline-start:0}
  .kode-collab-header-actions .kode-collab-icon-button{width:32px;height:32px;min-width:32px;min-height:32px}
}

.kode-collab-narrow-hint{display:none;padding:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
@container(max-width:220px){
  .kode-collab-narrow-hint{display:block}
  .kode-collab-conversation>.kode-collab-workspace{display:none}
}

/* Orbit tabs inside the native right Sidebar: the tab chip is the header, the pane sets the width. */
.kode-sidebar-messages{height:100%;background:transparent}
.kode-sidebar-messages>.kode-collab-workspace{display:flex}
.kode-sidebar-messages .kode-collab-composer{margin:8px 12px 12px;padding:10px 12px}
.kode-sidebar-writer-yield{margin:8px 12px 12px;padding:10px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,18px)}
.kode-sidebar-tab-status{padding:16px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.kode-sidebar-tab-status p{margin:0}
.kode-sidebar-session{height:100%;display:flex;flex-direction:column;min-height:0}
.kode-sidebar-session>.kode-builder-native-session{flex:1;min-height:0;display:flex;flex-direction:column}
` + collaborationLayout
