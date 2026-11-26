  const internalTags = {
    subagent_notification: '子 Agent 通知', environment_context: '环境上下文',
    INSTRUCTIONS: '项目规则', user_instructions: '会话规则', hook_prompt: 'Hook 提示',
    'system-reminder': '系统提醒', recommended_plugins: '插件上下文',
    skills_instructions: '技能上下文', skill: '技能上下文', 'app-context': '应用上下文',
    'kode-memory': '共享记忆', 'kode-memory-context': '记忆上下文',
    'in-app-browser-context': '浏览器上下文', permissions: '权限上下文',
    collaboration_mode: '协作模式', turn_aborted: '本轮已中断',
    send_user_message_question_reply: '问题回复',
  }
  const internalOpening = new RegExp(`^[ \\t]*<(${Object.keys(internalTags).join('|')})(?:\\s+[^<>]*)?>`, 'gm')
  function internalSection(tag, body) {
    const section = { tag, title: internalTags[tag], body: body.trim(), fields: [] }
    if (tag === 'subagent_notification') {
      try {
        const payload = JSON.parse(body), state = payload.status
        const statuses = { completed: '已完成', errored: '失败', failed: '失败', error: '失败', interrupted: '已中断', cancelled: '已取消', running: '进行中', pending_init: '等待启动' }
        const kind = typeof state === 'string' ? state : state && typeof state === 'object' ? Object.keys(statuses).find(key => key in state) : undefined
        const result = typeof state === 'object' && state ? state[kind] : payload.message ?? payload.result
        const name = payload.agent_name ?? payload.nickname ?? payload.name
        section.title = typeof name === 'string' && name.trim() && !/^[0-9a-f-]{20,}$/i.test(name) ? name : '子 Agent'
        section.status = statuses[kind] ?? '状态通知'
        section.tone = ['errored', 'failed', 'error'].includes(kind) ? 'error' : 'neutral'
        section.body = typeof result === 'string' ? result : typeof payload.message === 'string' ? payload.message : ''
        if (!section.body) section.body = kind === 'running' ? '子 Agent 正在处理任务。' : '子 Agent 状态已更新。'
      } catch { section.status = '格式未识别'; section.body = '通知格式未识别。' }
    } else if (tag === 'environment_context') {
      for (const [key,label] of [['cwd','工作目录'],['shell','Shell'],['current_date','记录日期'],['timezone','时区']]) {
        const value = new RegExp(`<${key}>([\\s\\S]*?)</${key}>`).exec(body)?.[1]?.trim()
        if (value) section.fields.push([label,value])
      }
      const directory = section.fields.find(([label]) => label === '工作目录')?.[1]
      section.hint = [directory?.split(/[\\/]/).filter(Boolean).at(-1), section.fields.find(([label]) => label === 'Shell')?.[1]].filter(Boolean).join(' · ')
    } else if (tag === 'INSTRUCTIONS') section.hint = 'AGENTS.md'
    else if (tag === 'send_user_message_question_reply') {
      try {
        const replies = JSON.parse(body)
        section.body = Array.isArray(replies) && replies.every(row => typeof row.question === 'string' && typeof row.answer === 'string') ? replies.map(row => `**${row.question}**\n\n${row.answer}`).join('\n\n') : '收到一条问题回复。'
      } catch { section.body = '问题回复格式未识别。' }
    }
    return section
  }
  function splitInternalText(text) {
    // Only known wrappers on their own lines are context. Fenced examples and
    // ordinary HTML/XML stay verbatim, including mentions of these tag names.
    const fences = [], fencePattern = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm
    let fence, match
    while ((match = fencePattern.exec(text))) {
      const marker=match[1]
      if (!fence) fence={ start:match.index, marker }
      else if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && /^\s*$/.test(match[0].slice(match[0].indexOf(marker)+marker.length))) { fences.push([fence.start,fencePattern.lastIndex]);fence=undefined }
    }
    if (fence) fences.push([fence.start,text.length])
    const sections=[], parts=[]
    let offset=0
    internalOpening.lastIndex=0
    while ((match=internalOpening.exec(text))) {
      if (fences.some(([start,end])=>match.index>=start && match.index<end)) continue
      const tag=match[1], bodyStart=internalOpening.lastIndex
      const closing=new RegExp(`</${tag}>[ \\t]*(?=\\r?\\n|$)`,'g');closing.lastIndex=bodyStart
      const end=closing.exec(text)
      if (!end) continue
      let start=match.index
      if (tag==='INSTRUCTIONS') {
        const heading=/(?:^|\n)# AGENTS\.md instructions for [^\n]+\s*$/.exec(text.slice(offset,start))
        if (heading) start=offset+heading.index
      }
      parts.push(text.slice(offset,start))
      sections.push(internalSection(tag,text.slice(bodyStart,end.index)))
      offset=closing.lastIndex;internalOpening.lastIndex=offset
    }
    parts.push(text.slice(offset))
    return { text: sections.length ? parts.join('').trim() : text, sections }
  }
  function InternalDisclosure({ section }) {
    const preview = section.tag === 'subagent_notification' ? section.body.replace(/[#*_`>]/g,'').split('\n').find(line=>line.trim())?.trim() : undefined
    return h('details', { className:'kode-internal-message', 'data-kode-context':section.tag },
      h('summary', null, h(section.tag==='subagent_notification' ? IconAgentPresetOutlineRegular : IconGlobeOutlineRegular,{size:14}), h('span',{className:'kode-internal-title'},section.title),
        section.status && h('span',{className:section.tone==='error'?'kode-error':'kode-secondary'},section.status),
        (section.hint || preview) && h('span',{className:'kode-internal-hint'},section.hint || preview), h(IconChevronDownOutlineRegular,{size:12,className:'kode-internal-chevron'})),
      h('div',{className:'kode-internal-body'},
        section.fields.length ? h('dl',null,...section.fields.map(([label,value])=>h('div',{key:label},h('dt',null,label),h('dd',null,value)))) : h(MarkdownText,{text:section.body,labels:markdownLabels})))
  }
  function InternalMessageAdapter({ native, kodeSessions, ...props }) {
    const data=props.node?.data
    if (!data || (props.node.kind==='assistant-step' && data.status!=='settled')) return h(native,props)
    const relay = props.node.kind === 'context' ? parseRelay(data) : undefined
    if (relay) return h(HistoricalRelay, { relay, time: data.time, sessions: kodeSessions, sessionId: props.sessionId, node: props.node, useChat: props.useChat })
    const field=props.node.kind==='assistant-step'?'blocks':'content'
    if (!Array.isArray(data[field])) return h(native,props)
    const sections=[], content=[]
    for (const block of data[field]) {
      if ((block.type ?? block.kind)!=='text' || typeof block.text!=='string') {content.push(block);continue}
      const parsed=splitInternalText(block.text);sections.push(...parsed.sections)
      if (parsed.text) content.push(parsed.sections.length?{...block,text:parsed.text}:block)
    }
    if (!sections.length) return h(native,props)
    const node={...props.node,data:{...data,[field]:content}}
    return h('div',{className:'kode-internal-stack'},...sections.map((section,index)=>h(InternalDisclosure,{key:index,section})),content.length>0 && h(native,{...props,node}))
  }
