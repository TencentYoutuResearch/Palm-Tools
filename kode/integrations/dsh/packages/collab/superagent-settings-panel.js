import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { ContactPreferenceControls } from './contact-preference-controls.js'
import { HubTeamAgentDefaults } from './team-agent-defaults.js'
import { TeamManagementView } from './team-management-view.js'
import { SuperagentRoleInstructions } from './superagent-role-instructions.js'
import { IconButton } from './icons.js'
import { settingsHierarchyStyles } from './resource-settings-styles.js'
const h = React.createElement

const row = (title, note, action) => h('div', { className: 'kode-integration-row' },
  h('span', null, h('strong', null, title), note && h('span', { className: 'kode-config-note' }, note)), action)

/**
 * A SuperAgent DM's settings, opened from its header gear as the native right-Sidebar
 * settings tab (`variant: 'tab'`), or the right inspector seat when that Sidebar has no hosts.
 * Native settings groups only; every control writes to an existing store:
 * appearance (team appearance store + global background preference), local Agent/model
 * defaults (kodeAgentControls), role instructions edited in place (a new draft revision),
 * contact preference and the team configuration/authority forms.
 * The panel is scoped to this DM's exact team: it never offers another team, so the stable
 * superagent_id / conversation_id stay where they are.
 */
export function SuperagentSettingsPanel({ team, request, storage, controls, appearance, TeamAppearance, TeamAvatar, onRefreshContacts, onClose, variant = 'inspector' }) {
  const [revision, setRevision] = React.useState(0)
  const [background, setBackground] = appearance?.useBackgroundPreference?.() ?? [false, () => {}]
  const heading = React.useRef(null)
  // A right-Sidebar tab: the native tab chip carries the title and close; the tab never steals focus.
  const tab = variant === 'tab'
  React.useEffect(() => { if (!tab) heading.current?.focus() }, [])
  const name = team.spec?.name || 'Superagent', interactive = team.spec?.execution_mode === 'interactive_native'
  const saved = () => { setRevision(value => value + 1); onRefreshContacts?.() }
  return h(tab ? 'section' : 'aside', { className: tab ? 'kode-superagent-settings kode-superagent-settings-tab' : 'kode-collab-inspector kode-superagent-settings', 'aria-label': `${name} 设置`,
    onKeyDown: tab ? undefined : event => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); onClose() } } },
    h('style', null, superagentSettingsStyles),
    !tab && h('header', null, h('strong', { ref: heading, tabIndex: -1 }, '设置'), h(IconButton, { icon: 'close', label: '关闭设置', onClick: onClose })),
    h('div', { className: 'kode-settings-main kode-superagent-settings-body' }, h('div', { className: 'kode-settings-page' },
      h('div', { className: 'kode-settings-group', 'aria-label': '身份与外观' },
        h('h3', { className: 'kode-settings-group-title' }, '身份与外观'),
        h('div', { className: 'kode-settings-card' },
        h('div', { className: 'kode-integration-row kode-superagent-identity' },
          h('span', { className: 'kode-superagent-identity-avatar', 'aria-hidden': true }, TeamAvatar && h(TeamAvatar, { team, size: 40 })),
          h('span', null, h('strong', null, name), h('span', { className: 'kode-config-note' }, '这个私信固定属于该团队。在别处选择其他团队，不会移动或改绑这段对话。'))),
        TeamAppearance && h(TeamAppearance, { team, row: true, showBackground: false }),
        h('label', { className: 'kode-integration-row' },
          h('span', null, h('strong', null, '显示头像配套背景'), h('span', { className: 'kode-config-note' }, '这是本浏览器的全局偏好，对所有私信与会话生效，不是这个 SuperAgent 单独的设置。')),
          h('input', { type: 'checkbox', role: 'switch', checked: background, onChange: event => setBackground(event.target.checked) })))),
      controls?.readAgentConfiguration && h(HubTeamAgentDefaults, { controls, request, team }),
      h(SuperagentRoleInstructions, { team, request, storage, onSaved: saved }),
      !interactive && h('div', { className: 'kode-settings-group', 'aria-label': '当前会话' },
        h('h3', { className: 'kode-settings-group-title' }, '当前会话'),
        h('p', { className: 'kode-config-note' }, '这里只说明实际绑定情况；上面的本机默认和团队配置都不会改动它。'),
        h('div', { className: 'kode-settings-card' }, row('运行会话', 'SuperAgent 的运行会话由团队运行时托管。目前没有可读取它实际 Agent 与模型的接口，这里不作推测。'),
        row('换用其他 Agent', '受控 SuperAgent 的继任交接尚未接通，暂不可用。不会用一个普通新会话冒充身份已交接，也不会绕过托管保护。普通会话可在会话标题栏使用原生“交接”。',
          h(Button, { variant: 'outline', disabled: true, 'aria-label': '交接 SuperAgent（暂不可用）' }, '交接')))),
      h('div', { className: 'kode-settings-group', 'aria-label': '高级' },
        h('h3', { className: 'kode-settings-group-title' }, '高级'),
        h('div', { className: 'kode-superagent-advanced' },
          h('details', { className: 'kode-superagent-advanced-group' },
            h('summary', null, '私信置顶与归档'),
            h('div', { className: 'kode-superagent-advanced-content' }, h(ContactPreferenceControls, { team, storage, onChanged: onRefreshContacts }))),
          h('details', { className: 'kode-superagent-advanced-group' },
            h('summary', null, '工作范围'),
            h('div', { className: 'kode-superagent-advanced-content' }, h(WorkScope, { team }))),
          h('details', { className: 'kode-superagent-advanced-group' },
            h('summary', null, '完整职责、资源与版本确认'),
            h('div', { className: 'kode-superagent-advanced-content' }, h(TeamManagementView, { key: `${team.id}:${revision}`, team, request, storage, controls, onSaved: onRefreshContacts }))))))))
}

/** Directory row scope only; the authoritative grant is read by “核对激活条件” below. */
function WorkScope({ team }) {
  const refs = Array.isArray(team.spec?.workspace_refs) ? team.spec.workspace_refs : []
  return h('section', { className: 'kode-superagent-scope', 'aria-label': '工作范围' },
    refs.length ? h('ul', null, ...refs.map(ref => h('li', { key: `${ref.host_id}:${ref.workspace_id}` }, h('strong', null, ref.workspace_id), h('span', { className: 'kode-config-note' }, `${ref.host_id} · ${ref.root_ref ?? ''}`))))
      : h('p', { className: 'kode-config-note' }, '团队配置中没有登记工作区。'),
    h('p', { className: 'kode-config-note' }, '这是团队配置登记的工作区。真正生效的目录、权限与工具以团队授权为准，可在下方“核对激活条件”中读取。'))
}

export const superagentSettingsStyles = settingsHierarchyStyles + `
.kode-superagent-settings{container:kode-superagent-settings/inline-size}
.kode-superagent-settings-tab{display:flex;flex-direction:column;flex:1;min-height:0;height:100%;overflow:hidden}
.kode-superagent-settings>.kode-settings-main{box-sizing:border-box;flex:1;min-height:0;height:100%;overflow-y:auto;padding:24px clamp(16px,4vw,48px) 32px}
.kode-superagent-settings .kode-settings-page{box-sizing:border-box;width:100%;max-width:960px;margin:0 auto}
.kode-superagent-settings:not(.kode-superagent-settings-tab) .kode-settings-page{max-width:100%}
.kode-superagent-identity{justify-content:flex-start;gap:12px}
.kode-superagent-identity-avatar{display:inline-flex;flex:none}
.kode-superagent-advanced{display:flex;flex-direction:column;gap:12px;min-width:0}
.kode-superagent-advanced-group{min-width:0;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-settings-card-fill)}
.kode-superagent-advanced-group>summary{padding:12px 16px;cursor:pointer;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.kode-superagent-advanced-group>summary:focus-visible{outline:2px solid var(--dsw-focus-ring-color);outline-offset:2px}
.kode-superagent-advanced-content{padding:4px 16px 16px;border-top:1px solid var(--dsw-alias-border-l2)}
.kode-superagent-advanced .kode-collab-team-configuration,.kode-superagent-advanced .kode-collab-team-management{padding:0;max-width:none}
.kode-superagent-advanced h2{margin:8px 0 0;font-size:15px;font-weight:600;line-height:22px}
.kode-superagent-settings .kode-superagent-advanced h3,.kode-superagent-scope h4{margin:0 0 4px;font-size:14px;font-weight:600;line-height:20px}
.kode-superagent-advanced h4{font-size:13px;font-weight:600}
.kode-superagent-advanced p{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.kode-superagent-advanced p[role=status],.kode-superagent-advanced p[role=alert]{color:var(--dsw-alias-label-primary)}
.kode-superagent-scope ul{list-style:none;margin:0 0 8px;padding:0;display:grid;gap:8px}
.kode-superagent-scope li{display:grid;gap:2px;overflow-wrap:anywhere}
.kode-superagent-settings .kode-config-note{overflow-wrap:anywhere}
@container kode-superagent-settings (max-width:560px){
 .kode-superagent-settings .kode-integration-row{gap:16px}
 .kode-superagent-settings .kode-collab-row-actions{justify-content:flex-start}
}
`
