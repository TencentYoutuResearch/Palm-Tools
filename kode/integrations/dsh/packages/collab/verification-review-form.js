import React from 'react'
import { canonical } from './builder-accept-command.js'
import { confirmReviewedVerification,verificationReviewKey,requestVerificationReview } from './verification-review-command.js'
const h=React.createElement,equal=(a,b)=>canonical(a)===canonical(b)
/** Local Host owner setup; a registered command still needs project binding and execution grant. */
export function VerificationReviewForm({host,storage,request=requestVerificationReview,onRegistered=()=>{}}){
 const pointer=JSON.stringify(['verification-review-active',host])
 const [fields,setFields]=React.useState({runner_id:'local',command_id:'',revision:'1',executable:'',args:'[]',scenarios:'smoke',timeout:'60000',limit:'262144',write:false,network:false,resources:''})
 const [review,setReview]=React.useState(null),[slot,setSlot]=React.useState(null),[busy,setBusy]=React.useState(false),[ready,setReady]=React.useState(false),[error,setError]=React.useState('')
 const active=React.useRef(null),running=React.useRef(false)
 React.useEffect(()=>{const controller=new AbortController();active.current=controller;setReady(false);setReview(null);setSlot(null)
  void storage.read(pointer).then(value=>{if(controller.signal.aborted)return;if(value&&value.review?.host!==host)throw Error('Wrong owner review');setSlot(value);setReview(value?.review??null);setReady(true)}).catch(()=>{if(!controller.signal.aborted)setError('无法读取验证命令确认记录，请重试。')})
  return()=>controller.abort()
 },[host,storage])
 const run=async action=>{const controller=active.current;if(running.current||!ready||!controller)return;running.current=true;setBusy(true);setError('');try{await action(controller.signal)}catch{if(!controller.signal.aborted)setError('验证命令尚未确认，请恢复原确认；登记不会执行命令。')}finally{running.current=false;if(!controller.signal.aborted)setBusy(false)}}
 const preview=()=>run(async signal=>{
  const args=JSON.parse(fields.args);if(!Array.isArray(args))throw Error('Argument array required')
  const resources=fields.resources.split(',').map(value=>value.trim()).filter(Boolean)
  const definition={...(resources.length?{exclusive_resources:resources}:{}),runner_id:fields.runner_id,command_id:fields.command_id,revision:fields.revision,executable:fields.executable,args,timeout_ms:Number(fields.timeout),max_output_bytes:Number(fields.limit),scenario_ids:fields.scenarios.split(',').map(s=>s.trim()).filter(Boolean),capabilities:fields.write?['read','workspace_write']:['read'],network:fields.network,tool_id:'kode_verify_output'}
  const value=await request({action:'preview',definition},{signal});if(value?.host!==host||value.execution_performed!==false)throw Error('Wrong preview Host');if(!signal.aborted)setReview(value)
 })
 const confirm=()=>run(async signal=>{
  if(!review||review.host!==host)throw Error('Review required')
  const proposed={request_id:review.scope_hash,state:'prepared',review}
  const saved=await storage.reserve(pointer,proposed,old=>old.state==='accepted')
  if(!equal(saved.review,review))throw Error('Another pending owner review')
  if(!signal.aborted)setSlot(saved)
  const d=saved.review.definition,key=verificationReviewKey(host,d.runner_id,d.command_id,d.revision),existing=await storage.read(key)
  const receipt=await confirmReviewedVerification({host,runner:d.runner_id,command:d.command_id,revision:d.revision,review:saved.review,storage,recover:!!existing,request,signal})
  const accepted={...saved,state:'accepted',receipt};await storage.save(pointer,accepted)
  if(!signal.aborted){setSlot(accepted);onRegistered(receipt)}
 })
 const input=(key,label,type='text')=>h('label',{className:'kode-collab-input-label'},label,h('input',{type,value:fields[key],disabled:busy,onChange:e=>setFields(v=>({...v,[key]:e.target.value}))}))
 return h('section',{className:'kode-collab-verification-setup',style:{minWidth:0,maxWidth:'100%',maxHeight:'100%',overflowY:'auto',overflowWrap:'anywhere',padding:16,boxSizing:'border-box'},'aria-label':'登记验证命令'},h('h3',null,'登记验证命令'),h('p',null,'执行位置：',host,'。登记保存命令定义，执行仍由已激活流程和授权控制。'),
  !review?h('div',null,input('runner_id','执行器标识'),input('command_id','命令标识'),input('revision','不可变版本'),input('executable','可执行文件绝对路径'),input('args','参数（JSON 数组）'),input('scenarios','验证场景（逗号分隔）'),input('resources','独占资源标识（逗号分隔，可留空）'),h('p',null,'同一 Home 管理范围内，共用设备、服务或端口须使用相同资源标识；独立资源请用不同标识。占用持续到停止确认。'),input('timeout','超时毫秒','number'),input('limit','输出字节上限','number'),
   ...[['write','允许写入工作区'],['network','允许访问网络']].map(([key,label])=>h('label',{key},h('input',{type:'checkbox',checked:fields[key],disabled:busy,onChange:e=>setFields(v=>({...v,[key]:e.target.checked}))}),label)),h('p',null,'不继承环境凭证；环境变量为空。'),h('button',{type:'button',className:'kode-collab-button',disabled:!ready||busy,onClick:preview},'核对验证命令')):
  h('div',null,h('p',null,'命令：',review.definition.runner_id,' / ',review.definition.command_id,' / ',review.definition.revision),h('p',null,'可执行文件：',review.definition.executable),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify(review.definition.args)),h('p',null,'文件指纹：',review.definition.executable_hash),h('p',null,'验证场景：',review.definition.scenario_ids.join('、')),h('p',null,'独占共享资源：',review.definition.exclusive_resources?.join('、')||'无'),h('p',null,'权限：',review.definition.capabilities.join('、'),'；网络：',review.definition.network?'允许':'不允许'),h('p',null,'超时：',review.definition.timeout_ms,' 毫秒；输出上限：',review.definition.max_output_bytes,' 字节'),
   slot?.state==='accepted'?h('div',null,h('p',{role:'status'},'验证命令已登记。'),h('pre',{style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}},JSON.stringify(slot.receipt.reference)),h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:()=>{setReview(null);setSlot(null)}},'登记另一版本或命令')):
   h('div',null,h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:confirm},slot?.state==='prepared'?'恢复原命令登记':'确认登记此命令'),!slot&&h('button',{type:'button',className:'kode-collab-button',disabled:busy,onClick:()=>setReview(null)},'返回修改'))),
  error&&h('p',{role:'alert'},error))
}
