/** Proposed Kode glue, dependency injected: no import of private dsh exports. */
export function portableComposerSupport(conversationModule) {
  const cap=conversationModule?.portableComposerCapabilities;
  if(cap?.version!==1 || cap.text!==true || typeof conversationModule.PortableTextComposer!=='function')return null;
  return conversationModule.PortableTextComposer;
}
/** Use inside existing discussion Composer. Never replace createMessageDraft or prepare/accept. */
export function portableDiscussionProps({key,text,pending,busy,ready,thread,draft,setText,setError,setReady,send}) {
 return {
  scopeKey:key,value:text,disabled:busy||!ready,editingDisabled:pending,
  ariaLabel:thread?'回复讨论串':'发送新话题',placeholder:thread?'回复这条讨论…':'开始一个新话题…',
  sendLabel:pending?'重试原发送':'发送',
  onChange(value){try{draft.current.edit(value);setText(value)}catch{setError('草稿未保存，不能发送。');setReady(false)}},
  async onSubmit(request){
   if(request.scopeKey!==key || request.text!==text || !ready || busy)throw Error('Draft scope or revision changed');
   // Existing send owns persisted request ID and exact receipt/scope validation.
   await send({preventDefault(){}});
  }
 }
}
