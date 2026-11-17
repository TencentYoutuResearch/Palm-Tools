/** The existing Kode session canvas and settings tokens are the visual authority. */
import { settingsHierarchyStyles } from './resource-settings-styles.js'
export const builderConversationStyles=settingsHierarchyStyles+`
.kode-collab-builder.kode-builder-conversation-layout{height:100%;min-height:0;width:100%;max-width:none;margin:0;padding:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);box-sizing:border-box}
.kode-builder-conversation-layout [hidden]{display:none!important}
.kode-builder-topbar{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:48px;padding:8px 16px 8px 24px;flex-shrink:0;border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.kode-builder-topbar.kode-builder-topbar-with-tabs{border-bottom:0}
.kode-builder-view-tabs{box-sizing:border-box;flex:none;padding:0 28px 0 20px;border-bottom:.5px solid var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}
.kode-builder-title{margin:0;min-width:0;font-size:14px;line-height:20px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-builder-header-actions{display:flex;gap:4px;align-items:center;flex-shrink:0}
.kode-builder-thread{flex:1;min-height:0;display:flex;flex-direction:column;width:min(100%,800px);margin:0 auto;padding:0 24px 20px;box-sizing:border-box}
.kode-builder-welcome{margin:auto 0 24px;padding:0 4px}.kode-builder-welcome h2{font-size:22px;line-height:1.4;font-weight:600;margin:0 0 8px}.kode-builder-welcome p{font-size:14px;line-height:1.7;color:var(--dsw-alias-label-secondary);margin:0;max-width:56ch}
.kode-builder-messages{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:16px;padding:16px 0 24px}
.kode-builder-message{font-size:14px;line-height:1.7;overflow-wrap:anywhere}
.kode-builder-message[data-role=user]{align-self:flex-end;max-width:min(85%,640px);background:var(--dsw-alias-settings-card-fill);border-radius:var(--dsw-radius-lg);padding:10px 14px;box-sizing:border-box}
.kode-builder-goal-text{white-space:pre-wrap}.kode-builder-goal-text[data-collapsed]{display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.kode-builder-goal-toggle{display:block;margin:6px 0 0 auto;padding:0;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}.kode-builder-goal-toggle:hover{color:var(--dsw-alias-label-primary)}
.kode-builder-goal-toggle:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px;border-radius:4px}
.kode-builder-event{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:64ch}
.kode-builder-session-link{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);font-size:13px}
.kode-builder-session-link>div{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}.kode-builder-session-link>div>span{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.kode-builder-session-link[data-planning-state=uncertain]{align-items:flex-start}.kode-builder-session-link[data-planning-state=uncertain]>div>span{white-space:normal;line-height:1.5;text-wrap:pretty}.kode-builder-session-link[data-planning-state=uncertain]>svg{margin-top:2px}
.kode-builder-prestart-composer,.kode-collab-builder-create{flex-shrink:0;width:100%}
.kode-builder-composer-note{margin:8px 4px 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.kode-builder-location-note{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:4px}.kode-builder-location-note>span{min-width:0;text-wrap:pretty}.kode-builder-location-note>button{flex-shrink:0}
.kode-builder-seat-note{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.kode-builder-page{flex:1;min-height:0;overflow:auto;box-sizing:border-box;width:100%;max-width:none;margin:0;padding:24px clamp(16px,4vw,48px) 32px}
.kode-builder-page-content{box-sizing:border-box;width:100%;max-width:960px;margin:0 auto}
.kode-builder-page-heading{margin-bottom:16px}.kode-builder-page-heading>button{margin-left:-8px;margin-bottom:8px}.kode-builder-page-heading h2{font-size:18px;line-height:26px;font-weight:600;margin:0}
.kode-builder-tabs{display:flex;gap:4px;margin:0 0 20px;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-builder-tabs button{font:inherit;font-size:13px;padding:8px 10px;border:0;border-bottom:2px solid transparent;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-bottom:-1px}
.kode-builder-tabs button[aria-current=page]{color:var(--dsw-alias-label-primary);border-bottom-color:currentColor}.kode-builder-tabs button:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:-2px}
.kode-builder-page .kode-settings-section{font-size:13px;line-height:1.7}
.kode-builder-page label{display:flex;flex-direction:column;gap:6px;font-size:13px;margin:8px 0}.kode-builder-page label:has(input[type=checkbox]),.kode-builder-page label:has(input[type=radio]){flex-direction:row;align-items:center;gap:8px}
.kode-builder-page input:not([type=checkbox]):not([type=radio]),.kode-builder-page select,.kode-builder-page textarea{font:inherit;line-height:1.5;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);box-sizing:border-box;width:100%;min-height:36px}
.kode-builder-page textarea{min-height:96px;resize:vertical}.kode-builder-page :is(input,select,textarea):focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:1px}
.kode-builder-page .kode-collab-composer{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}.kode-builder-page h3{font-size:14px;font-weight:600;margin:0}
.kode-builder-page .kode-collab-button{width:auto;align-self:flex-start;padding:7px 12px;min-height:32px}
.kode-builder-page details{margin:12px 0}.kode-builder-page details>summary{cursor:pointer;line-height:32px}
.kode-builder-radio-group{border:0;padding:0;margin:0 0 20px}.kode-builder-radio-group legend{font-size:13px;font-weight:600;padding:0;margin-bottom:4px}.kode-builder-radio-group label .kode-config-note{margin-left:auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%}.kode-builder-radio-group>p.kode-config-note{margin:4px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.kode-builder-team-links{font-size:13px;line-height:1.7;overflow-wrap:anywhere}
.kode-builder-filter-bar{display:flex;align-items:center;gap:10px;padding:6px 24px;font-size:12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex-wrap:wrap}.kode-builder-inline-error{margin:8px 24px;font-size:13px}
.kode-builder-thread:has(>.kode-builder-native-session-frame){width:100%;max-width:none;padding:0}
.kode-builder-native-session-frame{flex:1;min-height:0;display:flex;flex-direction:column}
.kode-builder-session-bar{display:flex;align-items:center;gap:4px;padding:0 16px 0 24px;min-height:32px;font-size:12px;color:var(--dsw-alias-label-secondary)}.kode-builder-session-bar>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kode-builder-session-bar>button{flex-shrink:0;white-space:nowrap}
.kode-builder-native-session{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.kode-builder-embed-yield{padding:4px 24px 0;margin:0}.kode-builder-native-session[data-writer-yielded]{opacity:.5}
.kode-builder-embed-status{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:min(100%,800px);margin:24px auto 0;padding:0 24px;box-sizing:border-box}
@media(max-width:760px){.kode-builder-topbar{padding:8px 8px 8px 16px}.kode-builder-thread{padding:0 12px 12px}.kode-builder-welcome h2{font-size:20px}.kode-builder-message[data-role=user]{max-width:92%}}
`
