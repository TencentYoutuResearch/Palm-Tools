/** Host-side interview preparation. No inference, tool execution or implicit permission. */
const path = '/api/v1/messaging/superagents/drafts'
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value)
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max && !value.includes('\0')
export function defaultBuilderQuestionnaire() {
  return { id:'software-team', version:'1', questions:[
    { id:'task_kind', prompt:'这个团队最常处理什么任务？可填写“需求交付”“缺陷修复”或描述其他任务。' },
    { id:'delivery', prompt:'做到什么程度算交付？例如本地修改并验证、创建评审请求，或其他终点；是否需要你最终验收？' },
    { id:'example', prompt:'选一个实际任务，描述收到的输入和你希望看到的交付结果。' },
    { id:'reproduction', prompt:'缺陷无法复现时，可以继续调查到什么程度，什么时候需要向你求助？', when_answer:{ question_id:'task_kind', equals:'缺陷修复' } },
    { id:'workflow', prompt:'建议采用实现、独立评审、验证的研发流程。你需要保留、增减哪些步骤，以及谁负责验收决策？' },
    { id:'resources', prompt:'允许使用哪些已配置的执行资源和工作区？可以只说明职责、速度和成本偏好，无需指定模型。' },
    { id:'budget', prompt:'团队预算是多少、按什么周期管理？额度不足或需要更昂贵的专家时，允许怎样处理？这与供应商余额分开记录。' },
    { id:'permissions', prompt:'本地修改、提交、推送、评论、合并、部署和对外发消息，各允许到哪一步，哪些必须先问你？' },
    { id:'verification', prompt:'哪些验证结果是交付必需的，哪些环境或步骤需要人工参与？已有项目命令会通过取证核实。' },
    { id:'failure', prompt:'评审或验证失败、依赖不可用时，允许怎样返工，什么时候暂停并向你反馈？' },
    { id:'concurrency', prompt:'多个任务可否并行？哪些目录、账号、设备或测试环境必须串行使用？' },
  ] }
}
function validateQuestionnaire(value) {
  if (!value || Object.keys(value).some(k=>!['id','version','questions'].includes(k)) || !id(value.id) || !id(value.version) || !Array.isArray(value.questions) || value.questions.length < 1 || value.questions.length > 128) throw new Error('invalid Builder questionnaire')
  const previous = new Set()
  for (const q of value.questions) {
    const c = q?.when_answer
    if (!q || Object.keys(q).some(k=>!['id','prompt','when_answer'].includes(k)) || !id(q.id) || previous.has(q.id) || !text(q.prompt,2048) ||
        (c !== undefined && (!c || Object.keys(c).some(k=>!['question_id','equals'].includes(k)) || !previous.has(c.question_id) || !text(c.equals,8192)))) throw new Error('invalid Builder question or forward dependency')
    previous.add(q.id)
  }
}
export async function prepareBuilderInterview(client, input) {
  if (!input || Object.keys(input).some(k=>!['draft_id','request_id','expected_revision','answers','clear_answers','questionnaire'].includes(k)) || !id(input.draft_id) || !id(input.request_id) || !Number.isSafeInteger(input.expected_revision) || input.expected_revision < 1) throw new Error('invalid Builder interview command')
  const draft = await client.call(`${path}/${input.draft_id}`)
  if (draft.status !== 'draft' || draft.revision !== input.expected_revision) throw new Error('Builder draft unavailable or revision conflict')
  const interview = structuredClone(draft.interview)
  interview.answers = Object.assign(Object.create(null), interview.answers)
  // The complete plan is persisted, so restart does not change outstanding questions.
  if (interview.questionnaire && input.questionnaire) throw new Error('questionnaire already selected; edit the draft explicitly to replace it')
  const questionnaire = interview.questionnaire ?? input.questionnaire ?? defaultBuilderQuestionnaire()
  validateQuestionnaire(questionnaire)
  const allowed = new Set(questionnaire.questions.map(q=>q.id))
  const answers = input.answers ?? {}, clear = input.clear_answers ?? []
  if (!answers || Array.isArray(answers) || typeof answers !== 'object' || Object.entries(answers).some(([key,value])=>!allowed.has(key) || !text(value,8192)) ||
      !Array.isArray(clear) || clear.some(key=>!allowed.has(key)) || new Set(clear).size !== clear.length || clear.some(key=>Object.hasOwn(answers,key))) throw new Error('invalid Builder answers')
  let changed = !interview.questionnaire || clear.some(key=>Object.hasOwn(interview.answers,key)) || Object.entries(answers).some(([key,value])=>interview.answers[key] !== value)
  if (changed) { interview.proposed_team = null; delete interview.proposed_workflow }
  for (const key of clear) delete interview.answers[key]
  Object.assign(interview.answers, answers)
  const pending = [], inactive = []
  for (const q of questionnaire.questions) {
    if (q.when_answer && interview.answers[q.when_answer.question_id] !== q.when_answer.equals) {
      // A changed branch invalidates its former answer; old revisions retain history.
      if (Object.hasOwn(answers,q.id)) throw new Error('answer supplied for inactive Builder question')
      if (Object.hasOwn(interview.answers,q.id)) inactive.push(q.id)
      delete interview.answers[q.id]
      continue
    }
    if (!Object.hasOwn(interview.answers,q.id)) pending.push({ id:q.id, prompt:q.prompt })
  }
  if (inactive.length) { changed = true; interview.proposed_team = null; delete interview.proposed_workflow }
  interview.questionnaire = questionnaire
  interview.questions = pending.slice(0,3)
  return { command:{ id:draft.id, request_id:input.request_id, expected_revision:draft.revision, revoked:false, interview },
    questions:interview.questions, remaining_questions:pending.length, invalidated_answers:inactive, configuration_invalidated:changed,
    interview_answers_complete:pending.length === 0, eligible_for_execution:false,
    pending_checks:['project_facts','resource_coverage','workflow_and_delivery_configuration','normal_and_failure_examples','human_activation'] }
}
export function registerBuilderInterview(ctx, config) {
  return ctx.webServer.register({ kind:'exact', path:'/api/kode/builder/prepare-interview', handler:async(req,res)=>{
    const send=(status,body)=>{ res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify(body)) }
    const admitted=ctx.connection.admit(req)
    if ('rejection' in admitted) return send(admitted.rejection,{error:'authentication required'})
    if (admitted.peer.principal.kind !== 'owner') return send(403,{error:'Host owner required'})
    if (req.method !== 'POST') return send(405,{error:'POST required'})
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return send(415,{error:'JSON required'})
    try {
      if (!config?.backendClient) throw new Error('backend unavailable')
      let body=''; for await (const part of req) { body+=part; if(Buffer.byteLength(body)>131072)throw new Error('request too large') }
      send(200,await prepareBuilderInterview(config.backendClient,JSON.parse(body)))
    } catch { send(400,{error:'Builder interview unavailable or input invalid'}) }
  } })
}
