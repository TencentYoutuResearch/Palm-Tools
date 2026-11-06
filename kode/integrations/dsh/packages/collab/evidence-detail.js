import React from 'react'
const h = React.createElement
export function validateSelectedEvidence(value, run, stage, output) {
  if (value.home_hub !== run.home_hub || value.team_id !== run.team_id || value.run_id !== run.id
    || value.stage_id !== stage.stage_id || value.stage_attempt !== stage.attempt || value.assignment_id !== stage.assignment_id
    || value.output !== output.name || value.sequence !== output.seq || value.completion_authorized !== false
    || !['artifact', 'review', 'verification'].includes(value.evidence?.payload?.kind)
    || value.evidence.payload.kind !== output.kind) throw Error('Evidence identity changed')
  return value.evidence.payload
}
export function EvidenceDetail({ run, stage, output, request }) {
  const [open, setOpen] = React.useState(false), [payload, setPayload] = React.useState(null)
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    setBusy(true); setError(''); setPayload(null)
    const query = new URLSearchParams({ run_id: run.id, stage_id: stage.stage_id, output: output.name })
    void request(`/api/kode/collab/evidence?${query}`, { signal: controller.signal }).then(value => {
      const body = validateSelectedEvidence(value, run, stage, output)
      if (!controller.signal.aborted) setPayload(body)
    }).catch(() => { if (!controller.signal.aborted) setError('证据暂时不可用或已发生变化，请刷新任务详情后重试。') })
      .finally(() => { if (!controller.signal.aborted) setBusy(false) })
    return () => controller.abort()
  }, [open, run.id, run.revision, stage.stage_id, stage.attempt, stage.assignment_id, output.name, output.seq])
  const field = (name, value) => h('p', { key: name }, name, '：', String(value ?? '未记录'))
  const verdict = { passed: '通过', failed: '失败', inconclusive: '无法判定' }
  return h('div', { className: 'kode-collab-evidence-detail' },
    h('button', { type: 'button', className: 'kode-collab-button', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, open ? '收起证据' : '查看证据'),
    open && h('div', null, busy && h('p', { role: 'status' }, '正在读取证据…'), error && h('p', { role: 'status' }, error),
      payload && h(React.Fragment, null,
        payload.kind === 'artifact' ? h(React.Fragment, null,
          field('仓库', payload.snapshot.repository_id), field('基线', payload.snapshot.base_revision), field('目录树哈希', payload.snapshot.tree_hash), field('补丁哈希', payload.snapshot.patch_hash),
          ...Object.entries(payload.snapshot.artifact_hashes).map(([name, hash]) => field(name, hash))) : h(React.Fragment, null,
          field('结论', verdict[payload.verdict] || '未识别'), field('产物记录', payload.artifact_sequence), field('快照哈希', payload.snapshot_hash),
          payload.kind === 'review' ? h('ul', null, ...payload.findings.map(finding => h('li', { key: finding.id }, finding.id, finding.blocking ? ' · 阻断问题' : ' · 非阻断问题', ' · ', finding.evidence_ref))) : h(React.Fragment, null,
            field('验证命令', payload.command_id), field('命令版本', payload.command_revision), field('退出码', payload.exit_code), field('验证场景', payload.scenario_ids.join('、')), field('日志引用', payload.log_ref))),
        h('p', { className: 'kode-collab-note' }, '这是已记录的证据；最终交付以 Hub 的任务判定为准。'))))
}
