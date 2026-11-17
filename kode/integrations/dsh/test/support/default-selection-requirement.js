/** Future business replay input, grounded in the actual historical implementation.
 * Data and local assertions only: importing this file never starts a model or creates a team.
 * This is not a rewrite of any retained conversation or a claim of live acceptance. */
import assert from 'node:assert/strict'

export const defaultSelectionReplay = Object.freeze({
 featureCommit:'e2f0c0ba8cf3517732bb81604ecfa89fafa8e7fe',
 sourceCommit:'f8463d8740db9d5fe6fba3f1c5388d7eb2456334',
 modulePath:'kode/integrations/dsh/src/model-alias.js',
 request:'帮我把这个旧版 Kode 的默认模型选择补齐。新建会话时先用我选的模型；没选就依次用备用模型、目录默认和第一项。推理强度只能选该模型支持的值。Fast 打开和关闭都要生效，不管它是服务加速还是切换到快速模型；切换模型后，没指定强度时要用目标模型的默认值。不能用的选项请用清楚的中文说明，原来的模型名称匹配也别受影响。只在这次隔离任务里改对应功能，不改测试、不安装依赖、不联网、不提交或推送。完成后请说明哪些效果已验证，还有什么没验证。',
 taskMethod:'本文件是历史功能复做的冻结执行上下文，不是用户聊天记录，也不代表任何原始 skill 已执行。\n目标文件仅限 kode/integrations/dsh/src/model-alias.js。增加并导出 resolveDefaultSelection(models, preference, fallbackModel)，保留 resolveAdvertisedModel 的已有行为。\n选择优先级：preference.model、fallbackModel、isDefault 目录项、首项。reasoningEffort 只能取目标模型公布的值，空字符串或非字符串要报中文错误；未指定则使用目标模型的 defaultReasoningEffort。\nFast 需要模型声明 fastCapability，支持 service-tier 和 model-variant；显式 fast: false 必须保留，非法类型和未公布的能力须报中文错误。切换 model-variant 后，在没有显式 reasoningEffort 时使用目标模型的默认强度。空模型列表、未知或歧义名称也要报中文错误。\n只修改上述源文件；不改测试、不安装依赖、不联网、不提交或推送。遵守已冻结的独立审查、验证和本地归档流程。此上下文不扩大任何工具、工作区或执行权限。',
})

/** Frozen behavioral oracle, shared by the prospective replay plan and offline history checks. */
export function verifyDefaultSelectionFeature(api){
 assert.equal(typeof api.resolveDefaultSelection,'function')
 const choose=api.resolveDefaultSelection,service=[{id:'standard',name:'Friendly',isDefault:true,reasoningEfforts:[{id:'medium'},{id:'high'}],defaultReasoningEffort:'medium',fastCapability:{transport:'service-tier',tier:'priority',defaultEnabled:true}}]
 const chineseError=fn=>assert.throws(fn,error=>error instanceof Error&&/[\u4e00-\u9fff]/u.test(error.message))
 const scenarios={
  'explicit-model':()=>assert.deepEqual(choose([{id:'first'},{id:'catalog',isDefault:true},{id:'chosen'}],{model:'chosen'},'first'),{model:'chosen'}),
  'fallback-order':()=>assert.deepEqual(choose([{id:'first'},{id:'catalog',isDefault:true},{id:'fallback'}],{},'fallback'),{model:'fallback'}),
  'catalog-default':()=>assert.deepEqual(choose([{id:'first'},{id:'catalog',isDefault:true}]),{model:'catalog'}),
  'first-available':()=>assert.deepEqual(choose([{id:'first'},{id:'second'}]),{model:'first'}),
  'advertised-label':()=>assert.deepEqual(choose(service,{model:'Friendly'}),{model:'standard',reasoningEffort:'medium',fast:true}),
  'declared-effort':()=>{assert.deepEqual(choose(service,{reasoningEffort:'high'}),{model:'standard',reasoningEffort:'high',fast:true});for(const value of ['invalid','',false])chineseError(()=>choose(service,{reasoningEffort:value}))},
  'service-tier-fast':()=>{assert.equal(choose(service,{fast:true}).fast,true);assert.equal(choose(service,{fast:false}).fast,false)},
  'unsupported-fast':()=>{chineseError(()=>choose([{id:'plain'}],{fast:true}));chineseError(()=>choose(service,{fast:'yes'}))},
  'variant-target-default':()=>{const variants=[{id:'normal',reasoningEfforts:[{id:'medium'}],defaultReasoningEffort:'medium',fastCapability:{transport:'model-variant',fastModelId:'fast',standardModelId:'normal',defaultEnabled:false}},{id:'fast',reasoningEfforts:[{id:'high'}],defaultReasoningEffort:'high',fastCapability:{transport:'model-variant',fastModelId:'fast',standardModelId:'normal',defaultEnabled:true}}];assert.deepEqual(choose(variants,{model:'normal',fast:true}),{model:'fast',reasoningEffort:'high',fast:true});assert.deepEqual(choose(variants,{model:'fast',fast:false}),{model:'normal',reasoningEffort:'medium',fast:false})},
  'empty-or-unknown':()=>{chineseError(()=>choose([]));chineseError(()=>choose(service,{model:'missing'}))},
  'existing-name-resolution':()=>{const models=[{id:'a',name:'same'},{id:'b',name:'same'}];assert.equal(api.resolveAdvertisedModel(models,'a'),'a');chineseError(()=>api.resolveAdvertisedModel(models,'same'))},
 }
 for(const check of Object.values(scenarios))check()
 return Object.keys(scenarios)
}
