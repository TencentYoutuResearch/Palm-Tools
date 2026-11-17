import React from 'react'
import { collaborationSettingsStyles } from './resource-settings-styles.js'
import { SessionInteropSettings } from './session-interop-settings.js'
const h = React.createElement

/**
 * Kode settings · 协作, on the native settings hierarchy: a section title, then one card of
 * rows (title + note on the left, control on the right, thin dividers). Every control delegates
 * to an existing store (view mode, appearance, account avatar, session interop); this page owns
 * no separate preferences. Team configuration lives in each Superagent's own settings tab.
 */
export function createCollaborationSettings({ appearance, view, navigation, UserAvatarSettings, sessionInteropRequest, controls }) {
  return function CollaborationSettings() {
    const current = React.useSyncExternalStore(view.subscribe, view.getSnapshot)
    const [background, setBackground] = appearance.useBackgroundPreference()
    const SelectField = controls?.SelectField
    return h('div', { className: 'kode-collab-settings' },
      h('style', null, collaborationSettingsStyles),
      h('div', { className: 'kode-settings-group', 'aria-label': '界面' },
        h('h3', { className: 'kode-settings-group-title' }, '界面'),
        h('div', { className: 'kode-settings-card' },
          h('div', { className: 'kode-integration-row' },
            h('span', null, h('strong', null, '侧边栏组织方式'), h('span', { className: 'kode-config-note' }, '只改变侧边栏的组织方式，不会新建会话，也不会打断正在执行的任务。')),
            SelectField ? h('div', { className: 'kode-settings-row-control' }, h(SelectField, { label: '侧边栏组织方式', value: current.mode === 'im' ? 'im' : 'session',
              options: [{ value: 'session', label: '会话：按工作区' }, { value: 'im', label: '协作：私信、频道与团队' }],
              onChange: mode => navigation.selectMode(mode, { showPanel: false }) }))
              : h('span', { className: 'kode-config-note', role: 'status' }, '原生设置控件不可用，请更新 Kode 插件。')),
          h('div', { className: 'kode-integration-row' },
            h('span', null, h('strong', null, '团队设置'), h('span', { className: 'kode-config-note' }, '团队头像、成员的 Agent 与模型、执行配置和角色指令，都在每个 Superagent 私信右上角的设置里调整，这里不再重复。'))))),
      h('div', { className: 'kode-settings-group', 'aria-label': '头像与外观' },
        h('h3', { className: 'kode-settings-group-title' }, '头像与外观'),
        h('div', { className: 'kode-settings-card' },
          UserAvatarSettings && h(UserAvatarSettings),
          h('label', { className: 'kode-integration-row' },
            h('span', null, h('strong', null, '显示头像配套背景'), h('span', { className: 'kode-config-note' }, '与“外观 · 头像与背景”共用同一偏好，影响所有支持配套背景的会话。')),
            h('input', { type: 'checkbox', role: 'switch', checked: background, onChange: event => setBackground(event.target.checked) })))),
      h('div', { className: 'kode-settings-group kode-collab-interop-group' }, h(SessionInteropSettings, { request: sessionInteropRequest })))
  }
}
