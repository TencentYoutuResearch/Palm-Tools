import { canonical } from './builder-accept-command.js'

export const builderPreparationSteps = [
  { id: 'workspace', title: '选择工作区', label: '工作区' },
  { id: 'selection', title: '选择对话助手', label: '对话助手' },
  { id: 'account', title: '确认用量归属', label: '用量归属' },
  { id: 'funding', title: '确认预算与权限', label: '内部用量上限' },
]

/** Presentation only. These checks never grant authority or replace start-plan validation. */
export function resolveBuilderPreparation({ draft, selection = null, resources = [], funding = null, now = Date.now() }) {
  const refs = draft.interview.workspace_refs ?? []
  const workspaces = refs.filter(row => row.host_id === draft.home_hub)
  const choice = selection?.selection
  const workspaceReady = workspaces.length > 0
  const selectionReady = workspaceReady && !!choice && selection.draft_revision === draft.revision
    && typeof choice.profile_id === 'string' && !!choice.profile_id && !!choice.provider && !!choice.model
    && workspaces.some(row => canonical(row) === canonical(choice.workspace))
  const resource = selectionReady ? resources.find(row => row.resource_kind === 'execution_profile'
    && row.host === draft.home_hub && row.profile_id === choice.profile_id) : null
  const accountReady = selectionReady && resource?.account?.current === true
  const fundingMatches = !!funding && selectionReady && funding.request?.draft_revision === draft.revision
    && funding.request?.selection_revision === selection.revision && canonical(funding.selection) === canonical(selection)
  const fundingCurrent = fundingMatches && funding.budget?.starts_at <= now && funding.budget?.ends_at > now
    && funding.grant?.policy?.enabled === true && funding.grant.policy.expires_at > now
  const funded = !!funding
  const blocked = draft.status !== 'draft' ? '此草案已撤销，不能启动。'
    : funded && !fundingMatches ? '预算已绑定原配置，当前草案或助手选择已变化。请新建设计草案后重新确认。'
      : funded && !fundingCurrent ? '本次搭建预算或权限不在有效期内，不能继续启动。请新建设计草案后重新确认。' : ''
  const completed = { workspace: workspaceReady, selection: selectionReady, account: accountReady, funding: fundingCurrent }
  const step = builderPreparationSteps.find(row => !completed[row.id])?.id ?? 'ready'
  return {
    step, ready: !blocked && step === 'ready', blocked, funded, completed, resource,
    summaries: {
      workspace: workspaces.map(row => row.root_ref).join('、'),
      selection: choice ? `${resource?.name || choice.profile_id} · ${choice.model}` : '',
      account: resource?.account?.id || '',
      funding: funding ? `${funding.budget?.limit ?? ''} ${funding.budget?.unit ?? ''} · 仅用于搭建对话` : '',
    },
  }
}

/** A fresh read is deliberately scoped to the current draft and execution-resource directory. */
export async function readBuilderPreparation(draft, request, { signal } = {}) {
  const query = `?draft_id=${encodeURIComponent(draft.id)}`
  const [selection, funding] = await Promise.all([
    request('/api/kode/builder/selection' + query, { signal }),
    request('/api/kode/builder/funding' + query, { signal }),
  ])
  for (const value of [selection, funding]) {
    if (value.home_hub !== draft.home_hub || value.draft_id !== draft.id) throw Error('Wrong preparation scope')
  }
  if (selection.eligible_for_execution !== false || funding.activation_performed !== false) throw Error('Invalid preparation authority')
  const resources = []
  let after = ''
  do {
    const page = await request('/api/kode/resource-coverage?limit=100&after=' + encodeURIComponent(after), { signal })
    if (page.host !== draft.home_hub || !Array.isArray(page.items) || page.items.length > 100 || resources.length + page.items.length > 2000) throw Error('Invalid resource directory')
    let cursor = after
    for (const row of page.items) {
      if (row.host !== draft.home_hub || typeof row.cursor !== 'string' || row.cursor <= cursor) throw Error('Invalid resource scope')
      cursor = row.cursor
    }
    if (page.next_cursor !== null && (!page.items.length || page.next_cursor !== cursor)) throw Error('Invalid resource continuation')
    resources.push(...page.items)
    after = page.next_cursor
  } while (after !== null)
  return { draftId: draft.id, home: draft.home_hub, draftRevision: draft.revision, selection: selection.record, funding: funding.record, resources, runtimeBinding: selection.runtime_binding ?? null }
}
