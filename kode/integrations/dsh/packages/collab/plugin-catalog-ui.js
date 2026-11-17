/** Native Plugins tab, with no install, connect, enable or configuration authority. */
import React from 'react'
import {IconButton} from './icons.js'
import {Button} from '@deepseek-ai/dsh-client-ui-primitives'
import {readPluginCatalog, requestPluginCatalogJson, runtimeLabel, evidenceLabel} from './plugin-catalog-model.js'
const h = React.createElement
const sectionStyle = {display:'flex', flexDirection:'column', gap:12}
const note = text => h('p', {className:'kode-config-note'}, text)
export function PluginCatalog({inventory, request = requestPluginCatalogJson}) {
  const [state, setState] = React.useState(null)
  const [revision, refresh] = React.useReducer(value => value + 1, 0)
  React.useEffect(() => {
    const abort = new AbortController()
    setState(null)
    void readPluginCatalog({inventory, request, signal:abort.signal}).then(value => {if (!abort.signal.aborted) setState(value)})
    return () => abort.abort()
  }, [inventory, request, revision])
  const catalog = state?.catalog, kode = catalog?.kode
  return h('div', {className:'kode-agent-settings', style:sectionStyle, 'aria-label':'Kode 插件与连接'},
    h('div', {className:'kode-integration-row'}, h('h3', null, 'Kode'), h(IconButton, {icon:'refresh', label:'刷新状态', disabled:!state, onClick:refresh})),
    note('Kode 是一个插件套件。下方汇总其运行模块、同步到 Agent 的来源，以及 TAPD / 工蜂连接能力。安装和启用仍使用原有插件管理。'),
    !state ? h('p', {role:'status'}, '正在读取插件与连接…') : h(React.Fragment, null,
      state.unavailable.length > 0 && h('p', {role:'alert', className:'kode-config-note'}, '部分状态暂不可读取：' + state.unavailable.map(key => ({inventory:'原生插件清单', agentHub:'同步来源', externalStatus:'连接目录'}[key])).join('、') + '。请确认当前账户权限或稍后刷新。'),
      h('section', {style:sectionStyle, 'aria-label':'Kode 插件套件'},
        h('h4', null, '插件套件'),
        note(catalog.authorities.runtime === 'unavailable' ? 'Kode 是否加载：未知' : kode.present ? `@kode/dsh · ${kode.enabled ? '已启用' : '已停用'} · ${runtimeLabel(kode.runtime_phase)}` : '当前原生清单未找到 @kode/dsh 主模块。'),
        h('details', null, h('summary', null, `查看 ${kode.module_count} 个 Kode 模块`),
          ...kode.modules.map(row => h('div', {key:row.entry_id, className:'kode-integration-row'}, h('span', null, row.module_name), h('span', null, `${row.enabled ? '已启用' : '已停用'} · ${runtimeLabel(row.runtime_phase)}`)))),
        note('模块状态来自原生运行清单，不代表安装历史。其他插件请查看同页的原生清单。')),
      h('section', {style:sectionStyle, 'aria-label':'同步来源'}, h('h4', null, '同步到 Agent 的来源'),
        note('来源同步与原生插件运行是不同状态。链接或安装记录不等于 Agent 已实际加载。'),
        catalog.synchronized_sources.length === 0 && note(catalog.authorities.synchronization === 'unavailable' ? '同步来源状态未知。' : '暂无同步来源。'),
        ...catalog.synchronized_sources.map(source => h('details', {key:source.source_id},
          h('summary', null, `${source.source_id} · ${source.skill_count} 项技能 · ${source.link_count} 条链接 · ${source.sync_state === 'failed' ? '同步失败' : source.sync_state === 'links_recorded' ? '有链接记录' : '尚未同步'}`),
          ...source.targets.map(target => h('p', {key:target.target, className:'kode-config-note'}, `${target.target} · ${evidenceLabel(target.evidence_basis)} · 实际加载未验证`))))),
      h('section', {style:sectionStyle, 'aria-label':'外部连接'}, h('h4', null, 'TAPD 与工蜂'),
        note('这两项是 Kode 的外部资源连接能力，不等同于独立安装的原生插件。'),
        ...catalog.external_capabilities.map(row => h('div', {key:row.provider, className:'kode-integration-row'},
          h('strong', null, row.provider === 'tapd' ? 'TAPD' : '工蜂 Git'),
          h('span', null, `${row.connection_state === 'not_connected' ? '未连接' : row.connection_state === 'not_projected' ? '连接归属未验证' : '连接状态未知'} · 连通性未验证`))),
        note(catalog.connections.authorized_connections === null ? '授权连接数量未知。' : `当前授权连接共 ${catalog.connections.authorized_connections} 个；总数不证明任何具体服务已连接。`),
        note('授权与绑定继续由现有连接体系管理；本页只展示状态，不创建凭据或发起连接。'))))
}
export function installPluginCatalog(ctx) {
  // Deferred native dependency and slot injection: absent inventory/tab does not block collaboration.
  ctx.inject(['remote.pluginInventory'], scope => {
    const inventory = async () => {
      const result = await scope.remote.pluginInventory.list()
      if (!result.ok) throw Error('Inventory unavailable')
      return result.value
    }
    for (const name of ['plugins.tab', 'settings.plugins.tab']) {
      scope.slots.inject(name, () => scope.slots.register({
        name, id:'kode', order:5, label:() => 'Kode', inject:() => ({inventory}),
      }, PluginCatalog))
    }
  })
}
