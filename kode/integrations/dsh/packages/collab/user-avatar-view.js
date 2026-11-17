import React from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { Icon } from './icons.js'
const h = React.createElement
export function createUserAvatarComponents(store) {
  function UserAvatar({ size = 32 }) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const [failed, setFailed] = React.useState(null)
    return state.source && failed !== state.source
      ? h('img', { src: state.source, alt: '', referrerPolicy: 'no-referrer', onError:()=>setFailed(state.source), style:{width:size,height:size,borderRadius:'50%',objectFit:'cover'} })
      : h(Icon,{name:'user',size:Math.round(size*.6)})
  }
  function UserAvatarSettings() {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot)
    const input = React.useRef(null), [busy,setBusy] = React.useState(false), [error,setError] = React.useState('')
    // A native settings row: label and note on the left, the avatar and its actions on the right.
    return h('div',{className:'kode-integration-row kode-user-avatar-row','aria-label':'我的协作头像'},
      h('span',null,h('strong',null,'我的协作头像'),
        h('span',{className:'kode-config-note'},state.accountId?'默认使用 DeepSeek 账户头像。自选图片只保存在当前浏览器、按账户隔离，不会修改或上传账户头像。PNG、JPEG、WebP，最大 2 MB。':'未登录账户：图片只保存在当前浏览器，登录后不会用作账户头像，也不会上传。PNG、JPEG、WebP，最大 2 MB。'),
        error && h('span',{className:'kode-error',role:'alert'},error)),
      h('div',{className:'kode-user-avatar-actions'},h(UserAvatar,{size:32}),
        h(Button,{variant:'outline',disabled:busy,onClick:()=>input.current?.click()},busy?'处理中…':'选择图片'),
        state.overridden && h(Button,{variant:'text',disabled:busy,onClick:()=>{try{store.clear();setError('')}catch(e){setError(e.message)}}},state.accountId?'恢复账户头像':'移除图片'),
        h('input',{ref:input,type:'file',accept:'image/png,image/jpeg,image/webp','aria-label':'上传本地协作头像',hidden:true,onChange:async event=>{
          const file=event.target.files?.[0];event.target.value='';if(!file)return
          setBusy(true);setError('');try{await store.upload(file)}catch(e){setError(e.message)}finally{setBusy(false)}
        }})))
  }
  return {UserAvatar,UserAvatarSettings}
}
