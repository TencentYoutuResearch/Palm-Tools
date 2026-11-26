// Codex owns the async tool. Describe its DSH representation in the durable
// header only; advertising another executable tool to Codex would duplicate it.
const name = 'ask_user_question'
export function questionHeaderTools(tools, profile) {
  if (profile?.type !== 'codex' && profile?.protocol !== 'codex') return tools
  const existing = tools.find(tool => tool.name === name)
  if (existing?.parameters?.properties?.timeout) return tools
  const parameters = existing?.parameters ?? {type:'object', properties:{questions:{type:'array',items:{type:'object'}}}, required:['questions']}
  const schema = {...existing,name,description:existing?.description ?? 'Ask the user a question',parameters:{
    ...parameters,properties:{...parameters.properties,timeout:{type:'number'}},
  }}
  return [...tools.filter(tool => tool.name !== name),schema]
}

export function asyncQuestion(item) {
  if (item?.type !== 'agentMessage' || item.delivery !== 'async' || !item.id || !Array.isArray(item.questions) || !item.questions.length) return
  if (!item.questions.every(q => typeof q?.title === 'string' && q.title.trim() &&
      (q.options == null || Array.isArray(q.options) && q.options.every(label => typeof label === 'string')))) return
  return item.questions.map((q,index) => ({
    id:JSON.stringify(['request_user_input_async',item.id,index]),question:q.title,
    ...(q.options?.length ? {options:q.options.map(label => ({label}))} : {}),
  }))
}

export function codexQuestionReply(source, text) {
  if (source?.kind !== 'user-question-reply' || !source.callId?.startsWith('kode-async:')) return text
  const result = JSON.parse(text)
  const replies = result.answers.map(row => ({
    questionItemId:row.id, answer:[...(row.selected ?? []), ...(row.custom ? [row.custom] : [])].join('\n'),
  }))
  return '<send_user_message_question_reply>\n' + JSON.stringify(replies).replaceAll('<','\\u003c') + '\n</send_user_message_question_reply>'
}
