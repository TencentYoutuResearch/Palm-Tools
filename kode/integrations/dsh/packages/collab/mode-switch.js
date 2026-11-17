/** UI navigation only: never dispatch, cancel or create Sessions. */
import React from 'react'
import {Button,Menu,FishLogo} from '@deepseek-ai/dsh-client-ui-primitives'
import {Icon} from './icons.js'
import kodeMark from './assets/kode-mark.png'
const h=React.createElement
export function ModeSwitch({mode,onSelect,wide=true,brand=false,identity}){
 const [open,setOpen]=React.useState(false)
 const label=mode==='im'?'协作':'会话'
 return h('div',{className:'kode-collab-mode-switch'+(brand?' kode-collab-brand-switch':'')},h(Menu,{open,onClose:()=>setOpen(false),portal:true,selectedId:mode,
  items:[{id:'session',label:'DeepSeek Harness · 会话'},{id:'im',label:'Kode Orbit · 协作'}],
  onSelect:id=>{if(id==='session'||id==='im'){setOpen(false);onSelect(id)}},
  anchor:h(Button,{type:'button','aria-label':'切换模式，当前：'+(brand?(mode==='im'?'Kode Orbit · ':'DeepSeek Harness · '):'')+label,'aria-haspopup':'menu','aria-expanded':open,onClick:()=>setOpen(v=>!v),title:'切换会话 / 协作模式'},brand?(mode==='im'?h(KodeIdentity,{wide}):(identity??h(React.Fragment,null,h(FishLogo,{size:24}),wide&&h('span',null,'DeepSeek Harness')))):h(React.Fragment,null,h(Icon,{name:mode==='im'?'users':'session',size:18}),wide&&h('span',null,label)),wide&&h(Icon,{name:'down',size:14}))}))
}

/** Reuse Kode's existing red/black terminal mark, as in the owner's reference. */
export function KodeIdentity({wide=true}){return h('span',{className:'kode-brand-identity','aria-hidden':true},
 h('img',{className:'kode-brand-mark',src:kodeMark,alt:'',width:28,height:28}),
 wide&&h('span',{className:'kode-brand-wordmark'},'Kode ',h('span',{className:'kode-brand-product'},'Orbit')))}
