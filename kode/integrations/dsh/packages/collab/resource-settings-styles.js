/** Native settings hierarchy (dsh settings-general rows, settings-models section titles) for
 * every collaboration settings surface: section 16/500, row title 14 regular, description
 * 12/18 secondary, .5px row dividers and spacing — not borders — between sections. */
export const settingsHierarchyStyles = `
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-group{gap:12px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-group+.kode-settings-group{margin-top:28px;padding-top:0;border-top:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) :is(.kode-settings-group>h3,.kode-settings-group-title){margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-config-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-integration-row{gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-integration-row:not(:has(~.kode-integration-row)){border-bottom:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-integration-row>span{gap:0}
/* Image-4 hierarchy: section title, then one card of rows with thin inset dividers. */
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-card{display:flex;flex-direction:column;min-width:0;padding:0 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-card>.kode-integration-row:not(:last-child){border-bottom:.5px solid var(--dsw-alias-border-l2)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-card>.kode-integration-row:last-child{border-bottom:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-card>:is(p,.kode-config-note){margin:12px 0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-group>.kode-config-note{margin:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-row-control{flex:none;min-width:0;max-width:60%}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-row-control .kode-field{margin:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-row-control .kode-field>span:first-child{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-row-control .kode-field-select{width:auto;max-width:100%;padding:6px 10px;gap:8px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-settings-row-control .kode-field-select>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-integration-row>span>strong{display:block;font-size:14px;font-weight:400;line-height:20px;color:var(--dsw-alias-label-primary)}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-integration-row>span>.kode-config-note{margin-top:4px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) :is(.kode-integration-row,.kode-collab-row-actions)>button{flex:none;white-space:nowrap}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-team-role-row{flex-wrap:wrap;row-gap:8px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-team-role-row>span{flex:1 1 180px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-team-role-pickers{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:4px;margin-left:auto;margin-right:-6px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-builder-appearance{justify-content:flex-start;gap:12px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-builder-appearance>span:nth-child(2){flex:1;min-width:0}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-builder-appearance-avatar{display:inline-flex;flex:none}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-builder-prompt-actions{display:flex;justify-content:flex-end;gap:8px}
:is(.kode-collab-settings,.kode-superagent-settings,.kode-builder-page) .kode-builder-prompt-settings .kode-role-prompt{margin:0}
`
/** Only what the native Kode settings rules (groups, rows, switches) do not already cover. */
export const collaborationSettingsStyles = settingsHierarchyStyles + `
.kode-collab-settings{display:flex;flex-direction:column;min-width:0;color:var(--dsw-alias-label-primary)}
.kode-collab-settings .kode-settings-group>.kode-config-note{margin:0;max-width:75ch}
.kode-collab-settings .kode-settings-scope{margin:0}
.kode-user-avatar-actions,.kode-collab-row-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;flex-shrink:0}
.kode-user-avatar-actions>img,.kode-user-avatar-actions>svg{flex:none}
.kode-collab-settings .kode-integration-row>span>.kode-error{margin:0}
.kode-collab-interop-group>.kode-agent-editor{display:flex;flex-direction:column;gap:12px;border:0;background:none;padding:0;border-radius:0}
.kode-collab-interop-group>.kode-agent-editor>h3{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}
.kode-collab-interop-group>.kode-agent-editor>p:not([role]){font-size:12px!important;line-height:18px!important}
.kode-collab-interop-group>.kode-agent-editor>p{margin:0;max-width:75ch;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-collab-interop-group .kode-config-note{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-collab-interop-group fieldset{min-width:0;margin:4px 0 0;padding:4px 16px 16px!important;border:1px solid var(--dsw-alias-border-l2)!important;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.kode-collab-interop-group fieldset h4{font-size:14px;line-height:22px;font-weight:500;margin:12px 0 2px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-interop-grants{display:grid;gap:10px;margin-top:4px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-interop-grants>summary{cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);list-style:none}
.kode-interop-grants>summary::-webkit-details-marker{display:none}
.kode-interop-grants>summary:hover{color:var(--dsw-alias-label-primary)}
.kode-collab-interop-group fieldset>div{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.kode-collab-interop-group fieldset label{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:32px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.kode-collab-interop-group input[type=checkbox]{width:16px;height:16px;flex:none;margin:0;accent-color:var(--dsw-alias-brand-primary)}
.kode-collab-interop-group :is(select,input:not([type=checkbox]):not([type=file])){box-sizing:border-box;min-width:0;max-width:100%;min-height:36px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;padding:6px 10px;flex:1}
.kode-collab-interop-group button{align-self:flex-start;max-width:100%;white-space:normal}
.kode-collab-interop-group :is(input,select,button):focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-collab-interop-group [role=alert]{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-primary))}
@media(max-width:600px){.kode-collab-settings .kode-integration-row{flex-direction:column;align-items:stretch;gap:10px}.kode-collab-settings .kode-integration-row:has(>input[role=switch]){flex-direction:row;align-items:center}.kode-user-avatar-actions,.kode-collab-row-actions{justify-content:flex-start}.kode-collab-interop-group fieldset label:has(select),.kode-collab-interop-group fieldset label:has(input:not([type=checkbox])){align-items:stretch;flex-direction:column;gap:6px}}
`
