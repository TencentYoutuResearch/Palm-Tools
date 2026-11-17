import React from 'react'
const h=React.createElement
import {builderTeamLinkRows} from './builder-team-links-model.js'
export function BuilderTeamLinks({value,compact=false}) {
 const rows=builderTeamLinkRows(value)
 if(compact&&value?.optimization_target?.source==='owner_confirmed_optimization')return h('small',null,'优化设计 · v',value.optimization_target.team_revision,value.optimization_target.status==='stale'?' · 已过期':'')
 if(!rows.length)return h('small',null,'历史团队关联未知')
 if(compact)return h('small',null,rows.length>1?'多个已接受关联':'已接受关联',value.team_links_truncated?' · 未显示全部':'')
 return h('details',{className:'kode-builder-team-links'},h('summary',null,rows.length>1?'多个已接受的团队来源':'已接受的团队来源'),
 h('p',null,'以下为历史接受记录，不代表当前优化目标，也不授予修改、调试或执行权限。'),
 h('ul',null,...rows.map((row,index)=>h('li',{key:JSON.stringify([row.request_id,row.team_id,row.team_revision,index])},'Team ',row.team_id,' · revision ',row.team_revision,' · 草案 revision ',row.draft_revision,' · owner 接受记录 ',row.request_id))),
 value.team_links_truncated&&h('p',{role:'status'},'仅显示最近 100 条关联，历史记录未全部列出；不自动选定唯一团队。'))
}
