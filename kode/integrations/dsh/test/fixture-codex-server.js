/** Deterministic app-server protocol fixture; never runs an external model. */
import readline from 'node:readline'
import { appendFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const result = (id, value) => send({ id, result: value })
const notify = (method, params) => send({ method, params })
let turn = 0, goal = null, archived = process.env.KODE_FIXTURE_ARCHIVED_THREAD === '1', compactActive = false
const dynamic = new Map()
const input = readline.createInterface({ input: process.stdin })
input.on('line', line => { void receive(JSON.parse(line)).catch(error => send({ id: null, error: { message: error.message } })) })
async function receive(message) {
  const { id, method, params } = message
  if (process.env.KODE_FIXTURE_RPC_LOG && method) await appendFile(process.env.KODE_FIXTURE_RPC_LOG, JSON.stringify({ method, params, label: process.env.KODE_FIXTURE_AGENT_LABEL, hostCredentialPresent: Boolean(process.env.KODE_BRIDGE_TOKEN || process.env.KODE_MESSAGING_ADMIN_TOKEN_FILE || process.env.KODE_SESSION_ID) }) + '\n')
  if (method === 'initialize') return result(id, { userAgent: 'fixture' })
  if (method === 'initialized') return
  if (method === 'model/list') return result(id, { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high',description:'Deep'}],defaultReasoningEffort:'medium' }], nextCursor: null })
  if (method === 'collaborationMode/list') return result(id,{data:[{name:'Default',mode:'default'},{name:'Plan',mode:'plan'}]})
  if (method === 'thread/settings/update') return result(id, {})
  if (method === 'thread/goal/get') return result(id, {goal})
  if (method === 'thread/goal/clear') { const cleared=!!goal;goal=null;notify('thread/goal/cleared',{threadId:params.threadId});return result(id,{cleared}) }
  if (method === 'thread/goal/set') {
    if (params.origin !== 'user') return send({id,error:{code:-32602,message:'user origin required'}})
    if (!goal && !params.objective) return send({id,error:{code:-32602,message:'no goal'}})
    goal={threadId:params.threadId,objective:params.objective??goal.objective,status:params.status??'active',tokensUsed:goal?.tokensUsed??0,timeUsedSeconds:0,tokenBudget:null}
    result(id,{goal});notify('thread/goal/updated',{threadId:params.threadId,goal})
    if(goal.status==='active' && process.env.KODE_FIXTURE_GOAL_AUTO==='1') {
      const nativeTurn=()=>{const turnId='goal-'+ ++turn,threadId=params.threadId;notify('turn/started',{threadId,turn:{id:turnId}});notify('item/agentMessage/delta',{threadId,turnId,itemId:turnId,delta:'Native goal '+turn});notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}})}
      setTimeout(()=>{nativeTurn();setTimeout(()=>{nativeTurn();goal={...goal,status:'complete'};notify('thread/goal/updated',{threadId:params.threadId,goal})},40)},10)
    }
    return
  }
  if (method === 'thread/name/set') return result(id,{})
  if (method === 'thread/resume' && archived) return send({id,error:{code:-32600,message:`session ${params.threadId} is archived. Run codex unarchive ${params.threadId} to unarchive it first.`}})
  if (method === 'thread/unarchive') { archived=false;return result(id,{thread:{id:params.threadId}}) }
  if (method === 'thread/start' || method === 'thread/resume') return result(id, { thread: { id: params.threadId ?? 'same-native-id' } })
  if (method === 'turn/steer') {
    const turnId = `turn-${turn}`, threadId = params.threadId
    if (process.env.KODE_FIXTURE_STEER_DROP === '1') return process.exit(1)
    if (process.env.KODE_FIXTURE_STEER_REJECT === '1') {
      send({ id, error: { code: -32602, message: 'turn already completed' } })
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); return
    }
    if (params.expectedTurnId !== turnId) return send({ id, error: { code: -32602, message: 'wrong active turn' } })
    result(id, { turnId })
    const text = `steered: ${params.input.filter(part => part.type === 'text').map(part => part.text).join(' ')}`
    notify('item/agentMessage/delta', { threadId, turnId, itemId: 'steered-answer', delta: text })
    notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'steered-answer', text } })
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }); return
  }
  if (method === 'turn/interrupt') { result(id, {}); return }
  if (method === 'skills/list') return result(id,{data:[{cwd:params.cwds[0],skills:[{name:'fixture-skill',description:'Example workspace skill',path:params.cwds[0]+'/.agents/skills/fixture-skill/SKILL.md',enabled:true}],errors:[]}]})
  if (method === 'mcpServerStatus/list') return result(id,{data:[{name:'fixture-mcp',authStatus:'notLoggedIn',tools:{example:{}}}],nextCursor:null})
  if (method === 'thread/compact/start') {
    const turnId='compact-'+ ++turn,threadId=params.threadId
    compactActive=true;result(id,{});notify('turn/started',{threadId,turn:{id:turnId}})
    notify('item/completed',{threadId,turnId,item:{id:'compact',type:'contextCompaction'}})
    setTimeout(()=>{
      compactActive=false
      const failed=process.env.KODE_FIXTURE_COMPACT_FAIL==='1'
      notify('turn/completed',{threadId,turn:{id:turnId,status:failed?'failed':'completed',...(failed?{error:{message:'compaction finalization failed'}}:{})}})
    },Number(process.env.KODE_FIXTURE_COMPACT_DELAY_MS??0))
    return
  }
  if (method === 'review/start') { const turnId='review-'+ ++turn,threadId=params.threadId;result(id,{reviewThreadId:threadId,turn:{id:turnId,status:'inProgress'}});notify('item/agentMessage/delta',{threadId,turnId,itemId:'review',delta:'Native review result'});notify('turn/completed',{threadId,turn:{id:turnId,status:'completed'}});return }
  if (method === 'turn/start') {
    if(compactActive)return send({id,error:{code:-32600,message:'ActiveTurnNotSteerable: Compact'}})
    const turnId = 'turn-' + ++turn, threadId = params.threadId
    result(id, { turn: { id: turnId, status: 'inProgress' } })
    notify('turn/started', { threadId, turn: { id: turnId } })
    const text = params.input[0]?.text ?? ''
    const complete = () => {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'answer', delta: `${process.env.KODE_FIXTURE_AGENT_LABEL ?? 'fixture'}: ${text}` })
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'answer', text: `${process.env.KODE_FIXTURE_AGENT_LABEL ?? 'fixture'}: ${text}` } })
      notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
    }
    if (text.includes('WAIT')) return
    if (text.includes('OVERLAPPING_NATIVE')) {
      const start=(id)=>notify('item/started',{threadId,turnId,item:{type:'commandExecution',id,command:id,status:'inProgress'}})
      const finish=(id)=>notify('item/completed',{threadId,turnId,item:{type:'commandExecution',id,command:id,status:'completed',aggregatedOutput:id+' done',exitCode:0}})
      start('long-command')
      notify('item/reasoning/textDelta',{threadId,turnId,itemId:'thinking',delta:'Thinking while the command is still running.'})
      start('parallel-command');finish('parallel-command')
      notify('item/agentMessage/delta',{threadId,turnId,itemId:'progress',delta:'The long command is still running.'})
      notify('item/completed',{threadId,turnId,item:{type:'agentMessage',id:'progress',text:'The long command is still running.'}})
      finish('long-command');complete();return
    }
    if (text.includes('TOOL_SEQUENCE')) {
      const say = (id, text) => { notify('item/agentMessage/delta', { threadId, turnId, itemId: id, delta: text }); notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id, text } }) }
      const start = (id, command) => notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id, command, status: 'inProgress' } })
      const finish = (id, command) => notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id, command, status: 'completed', aggregatedOutput: 'fixture result', exitCode: 0 } })
      say('sequence-before', '先检查目录，再查看状态，最后运行测试。')
      start('sequence-1', 'pwd'); finish('sequence-1', 'pwd')
      start('sequence-2', 'git status --short'); finish('sequence-2', 'git status --short')
      start('sequence-3', 'npm test')
      setTimeout(() => {
        finish('sequence-3', 'npm test')
        say('sequence-after', '三项检查已完成，这是最后的文字回复。')
        setTimeout(() => notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } }), 5000)
      }, Number(process.env.KODE_FIXTURE_NATIVE_DELAY_MS ?? 30000))
      return
    }
    if (text.includes('MULTI_MESSAGE')) {
      notify('item/agentMessage/delta', { threadId, turnId, itemId: 'commentary', delta: 'Inspecting the workspace.' })
      notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'commentary', text: 'Inspecting the workspace.', phase: 'commentary' } })
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'check', command: 'pwd', status: 'inProgress' } })
      setTimeout(() => {
        notify('item/completed', { threadId, turnId, item: { type: 'commandExecution', id: 'check', command: 'pwd', status: 'completed', aggregatedOutput: '/srv/project', exitCode: 0 } })
        notify('item/agentMessage/delta', { threadId, turnId, itemId: 'final', delta: 'Final answer.' })
        notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', id: 'final', text: 'Final answer.', phase: 'final_answer' } })
        notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } })
      }, Number(process.env.KODE_FIXTURE_NATIVE_DELAY_MS ?? 0))
      return
    }
    if (text.includes('NATIVE_TRACE')) {
      notify('item/reasoning/textDelta',{threadId,turnId,itemId:'reasoning',delta:'Inspecting the workspace.'})
      notify('item/reasoning/summaryTextDelta',{threadId,turnId,itemId:'reasoning',delta:'Duplicate summary must not repeat.'})
      notify('item/started',{threadId,turnId,item:{type:'commandExecution',id:'native-command',command:'pwd',status:'inProgress'}})
      const delay=Number(process.env.KODE_FIXTURE_NATIVE_DELAY_MS??25)
      setTimeout(()=>{notify('item/completed',{threadId,turnId,item:{type:'commandExecution',id:'native-command',command:'pwd',status:'completed',aggregatedOutput:'/srv/project',exitCode:0}});complete()},delay)
      return
    }
    const target = text.match(/KODE_TEST_SEND ([A-Za-z0-9_.:-]+)\/([A-Za-z0-9_.:-]+)/)
    if (text.includes('TOOL') || target) {
      dynamic.set('tool-1', complete)
      const action = target ? { tool: 'kode_sessions_send', arguments: { node_id: target[1], session_id: target[2], content: 'KODE_TEST_REQUEST Confirm this native Codex message.', idempotency_key: 'native-fixture-' + createHash('sha256').update(text).digest('hex').slice(0, 32) } } : { tool: 'kode_sessions_list', arguments: {} }
      return send({ id: 'tool-1', method: 'item/tool/call', params: { threadId, turnId, callId: 'call-1', ...action } })
    }
    complete(); return
  }
  if (dynamic.has(id)) { dynamic.get(id)(); dynamic.delete(id); return }
  if (id !== undefined) send({ id, error: { code: -32601, message: 'unknown fixture method' } })
}
