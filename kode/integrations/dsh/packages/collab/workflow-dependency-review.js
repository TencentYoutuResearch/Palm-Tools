import React from 'react'
const h = React.createElement
export function WorkflowDependencyReview({ binding }) {
  const stages = (binding.workflow?.pack?.stages ?? []).filter(stage => stage.execution?.dependencies?.length)
  if (!stages.length) return null
  return h('section', { className: 'kode-collab-dependencies', 'aria-label': '流程指令资源' },
    h('h4', null, '流程指令资源'),
    ...stages.map(stage => h('div', { key: stage.id }, h('p', null, '阶段 ', stage.id),
      ...stage.execution.dependencies.map(reference => {
        const row = binding.workflow_dependencies?.[stage.id]?.find(row => row.id === reference.id && row.version === reference.version && row.hash === reference.hash)
        const artifact = row?.config?.spec?.artifact
        return h('article', { key: reference.id },
          h('p', null, reference.id, ' · ', reference.version), h('p', null, '版本哈希 ', reference.hash),
          artifact ? h(React.Fragment, null,
            h('p', null, artifact.kind === 'plugin' ? 'Plugin 指令资源' : 'Skill 指令资源', ' · ', artifact.source, ' · ', artifact.source_version),
            h('p', null, '指令内容哈希 ', artifact.content_hash),
            h('p', null, '可用 Host ', artifact.hosts.join('、')),
            h('p', null, '所需工具 ', artifact.tools.join('、') || '无', ' · 所需能力 ', artifact.capabilities.join('、') || '无', ' · 网络 ', artifact.network ? '需要' : '无需'),
            h('details', null, h('summary', null, '查看冻结的指令'), h('pre', null, artifact.instructions)))
            : h('p', { role: 'status' }, '资源尚未解析，请补齐后重新预检。'))
      }))))
}
