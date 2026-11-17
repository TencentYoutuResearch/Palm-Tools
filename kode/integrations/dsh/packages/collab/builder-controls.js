import React from 'react'
export const BuilderControlsContext = React.createContext(null)
export const useBuilderControls = () => React.useContext(BuilderControlsContext)
export function builderPickerData(resources, choice, models = [], reasoning = null) {
  const profiles=resources.map(row=>({id:row.profile_id,name:row.name,type:row.executor_type,origin:'configured'}))
  const currentProfile=profiles.find(row=>row.id===choice.profile_id)
  return {profiles,currentProfile,selectedProfileId:choice.profile_id,canChangeAgent:true,supportedTypes:[...new Set(profiles.map(p=>p.type))],types:{},
    models:models.map(row=>({...row,provider:row.provider??choice.provider,reasoningEfforts:row.id===choice.model?reasoning?.efforts??[]:[]})),
    selection:{provider:choice.provider,model:choice.model,reasoningEffort:choice.effort}}
}
export function runtimeSelection(binding, fallback) {
  if (!binding) return fallback
  if (binding.state==='legacy_conflict') return null
  return binding.selection_snapshot?.selection ?? null
}
export function runtimeLockReason(binding) {
  if (!binding) return null
  return binding.state==='legacy_conflict'?'此草案存在多个旧运行绑定，请先核对，不能切换执行配置。':binding.state==='pending_start'?'正在准备启动，Agent 已锁定；此流程尚不支持运行中切换模型。':'Agent 已绑定此对话；此流程尚不支持运行中切换模型。'
}
