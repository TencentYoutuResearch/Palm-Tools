  // Per-bot Connectors & Apps ("连接器") UI, modeled on Orca Bot (`stablyai/orca`):
  // Direct connectors (WeCom, GitHub, Slack, Discord, Linear, Google, Kode Team),
  // searchable/categorized official MCP apps catalog, custom MCP URL, and Webhooks.
  const CONNECTOR_CATEGORIES = [
    { id: 'all', label: '全部' },
    { id: 'chat', label: '沟通' },
    { id: 'coding', label: '代码与开发' },
    { id: 'monitoring', label: '监控与分析' },
    { id: 'docs', label: '文档与项目' },
    { id: 'mail', label: '邮件与会议' },
    { id: 'sales', label: '销售与客服' },
    { id: 'custom', label: '自定义' },
  ]
  const CONNECTOR_TYPES = [
    { type: 'wecom', name: '企业微信', badge: '企微', tone: 'green', category: 'chat', summary: '在企微单聊或群聊里直接呼叫伙伴，自动同步监听会话' },
    { type: 'github', name: 'GitHub', badge: 'GH', tone: 'slate', category: 'coding', summary: '结合本机 gh 账号操作 PR/Issue，监听仓库提交与 Webhook' },
    { type: 'slack', name: 'Slack', badge: 'Slack', tone: 'amber', category: 'chat', summary: '在 Slack 频道和私信里呼叫伙伴，通过专属 Webhook 接收事件' },
    { type: 'discord', name: 'Discord', badge: 'DC', tone: 'indigo', category: 'chat', summary: '在 Discord 频道、子区与私信中触发伙伴并同步回复' },
    { type: 'linear', name: 'Linear', badge: 'Linear', tone: 'indigo', category: 'docs', summary: '通过 @提及、指派或标签把 Linear Issue 交给伙伴自动跟进' },
    { type: 'google', name: 'Google', badge: 'Google', tone: 'rose', category: 'mail', summary: '让伙伴访问 Gmail、Calendar 与 Drive，支持定时巡检或 Webhook' },
    { type: 'team', name: '团队频道', badge: 'Team', tone: 'blue', category: 'chat', summary: '在 Kode 团队频道被 @ 提及或监听指定频道新消息' },
    { type: 'webhook', name: 'Webhook', badge: 'Hook', tone: 'purple', category: 'custom', summary: '生成专属本机回调地址与密钥，CI、脚本或外部服务调用即触发' },
    { type: 'mcp', name: '自定义 MCP', badge: 'MCP', tone: 'blue', category: 'custom', summary: '通过 URL 接入任意官方或团队自建 MCP 服务器' },
  ]
  const DEFAULT_MCP_APPS = [
    { id: 'vercel', name: 'Vercel', badge: 'VC', category: 'coding', summary: '查看部署状态并读取构建与运行日志', url: 'https://mcp.vercel.com' },
    { id: 'cloudflare', name: 'Cloudflare', badge: 'CF', category: 'coding', summary: '管理 Workers、DNS 与账户资源', url: 'https://mcp.cloudflare.com/mcp' },
    { id: 'supabase', name: 'Supabase', badge: 'SB', category: 'coding', summary: '查询数据库并管理 Supabase 项目', url: 'https://mcp.supabase.com/mcp' },
    { id: 'neon', name: 'Neon', badge: 'NE', category: 'coding', summary: '执行 SQL 并管理 Postgres 分支', url: 'https://mcp.neon.tech/mcp' },
    { id: 'netlify', name: 'Netlify', badge: 'NL', category: 'coding', summary: '部署站点并检查构建结果', url: 'https://mcp.netlify.com/mcp' },
    { id: 'gitlab', name: 'GitLab', badge: 'GL', category: 'coding', summary: '读取并更新 GitLab Issue 与 Merge Request', url: 'https://{host}/api/v4/mcp', variable: { key: 'host', label: 'GitLab 域名（留空默认 gitlab.com）', default: 'gitlab.com', placeholder: 'gitlab.example.com' } },
    { id: 'context7', name: 'Context7', badge: 'C7', category: 'coding', summary: '查询开源库的最新官方文档与示例', url: 'https://mcp.context7.com/mcp' },
    { id: 'sentry', name: 'Sentry', badge: 'ST', category: 'monitoring', summary: '排查线上报错及关联事件栈', url: 'https://mcp.sentry.dev/mcp' },
    { id: 'datadog', name: 'Datadog', badge: 'DD', category: 'monitoring', summary: '检索日志、指标与告警监控', url: 'https://mcp.{site}/v1/mcp', variable: { key: 'site', label: 'Datadog 区域', default: 'datadoghq.com', choices: [{ name: 'US1', value: 'datadoghq.com' }, { name: 'US3', value: 'us3.datadoghq.com' }, { name: 'US5', value: 'us5.datadoghq.com' }, { name: 'EU', value: 'datadoghq.eu' }, { name: 'AP1', value: 'ap1.datadoghq.com' }, { name: 'AP2', value: 'ap2.datadoghq.com' }, { name: 'UK1', value: 'uk1.datadoghq.com' }] } },
    { id: 'posthog', name: 'PostHog', badge: 'PH', category: 'monitoring', summary: '查询产品数据分析与 Feature Flags', url: 'https://mcp.posthog.com/mcp' },
    { id: 'atlassian', name: 'Atlassian', badge: 'AT', category: 'docs', summary: '读写 Jira Issue 与 Confluence 文档', url: 'https://mcp.atlassian.com/v2/mcp' },
    { id: 'notion', name: 'Notion', badge: 'NT', category: 'docs', summary: '搜索、阅读并编辑 Notion 页面', url: 'https://mcp.notion.com/mcp' },
    { id: 'clickup', name: 'ClickUp', badge: 'CU', category: 'docs', summary: '管理任务、清单与文档', url: 'https://mcp.clickup.com/mcp' },
    { id: 'airtable', name: 'Airtable', badge: 'AB', category: 'docs', summary: '查询并编辑多维表格记录', url: 'https://mcp.airtable.com/mcp' },
    { id: 'todoist', name: 'Todoist', badge: 'TD', category: 'docs', summary: '新增、整理并完成待办任务', url: 'https://ai.todoist.net/mcp' },
    { id: 'zapier', name: 'Zapier', badge: 'ZP', category: 'docs', summary: '调用你在 Zapier 中编排的自动化动作', url: 'https://mcp.zapier.com/api/v1/connect' },
    { id: 'granola', name: 'Granola', badge: 'GR', category: 'mail', summary: '检索会议纪要与转写记录', url: 'https://mcp.granola.ai/mcp' },
    { id: 'stripe', name: 'Stripe', badge: 'SP', category: 'sales', summary: '查询支付订单、客户与订阅状态', url: 'https://mcp.stripe.com' },
    { id: 'intercom', name: 'Intercom', badge: 'IC', category: 'sales', summary: '搜索客服对话、联系人与帮助中心文章', url: 'https://mcp.{site}/mcp', variable: { key: 'site', label: 'Intercom 区域', default: 'intercom.com', choices: [{ name: 'US', value: 'intercom.com' }, { name: 'EU', value: 'eu.intercom.com' }] } },
  ]
  const CATEGORY_TONES = { chat: 'green', coding: 'slate', monitoring: 'amber', docs: 'indigo', mail: 'rose', sales: 'purple', custom: 'blue' }
  const connectorMeta = (type, appId = null, apps = DEFAULT_MCP_APPS) => {
    if (type === 'mcp' && appId && appId !== 'custom') {
      const app = apps.find(item => item.id === appId)
      if (app) return { type: 'mcp', name: app.name, badge: app.badge || 'MCP', tone: CATEGORY_TONES[app.category] ?? 'blue', summary: app.summary }
    }
    return CONNECTOR_TYPES.find(item => item.type === type) ?? { type, name: type, badge: type, tone: 'slate', summary: '' }
  }

  function BotConnectorChips({ connectors, empty = '' }) {
    if (!connectors?.length) return empty ? h('span', { className: 'kode-secondary' }, empty) : null
    return h('span', { className: 'kode-bot-skill-chips kode-connector-chips' },
      ...connectors.map((conn, index) => {
        const meta = connectorMeta(conn.type, conn.config?.app_id)
        const paused = conn.enabled === false
        return h('span', {
          key: conn.id ?? `${conn.type}:${conn.config?.app_id ?? ''}:${index}`,
          className: `kode-connector-chip is-${meta.tone}${paused ? ' is-paused' : ''}`,
          title: conn.how_to_ask || meta.summary,
        }, h('span', { className: 'kode-connector-chip-badge' }, meta.badge), conn.name || meta.name)
      }))
  }

  function connectorWebhookUrl(path) {
    if (!path) return ''
    try { return `${window.location.origin}${path}` } catch { return path }
  }

  function BotConnectorEditor({ type, mcpApp = null, existing, bot, data, busy, error = '', onSave, onCancel }) {
    const apps = data.mcp_app_catalog?.length ? data.mcp_app_catalog : DEFAULT_MCP_APPS
    const resolvedApp = type === 'mcp' ? (mcpApp ?? apps.find(item => item.id === existing?.config?.app_id) ?? null) : null
    const meta = connectorMeta(type, resolvedApp?.id, apps)
    const [name, setName] = useState(existing?.name ?? resolvedApp?.name ?? meta.name)
    const [cfg, setCfg] = useState(() => ({
      chat_id: existing?.config?.chat_id ?? '',
      chat_name: existing?.config?.chat_name ?? '',
      events_hint: existing?.config?.events_hint ?? '',
      repo: existing?.config?.repo ?? '',
      workspace: existing?.config?.workspace ?? bot.default_cwd ?? data.workspaces?.[0]?.path ?? '',
      branch: existing?.config?.branch ?? '',
      watch_commits: existing?.config?.watch_commits !== false,
      room: existing?.config?.room ?? '',
      mode: existing?.config?.mode ?? 'mention',
      workspace_name: existing?.config?.workspace ?? '',
      server: existing?.config?.server ?? '',
      channel: existing?.config?.channel ?? '',
      mention_handle: existing?.config?.mention_handle ?? bot.name,
      team: existing?.config?.team ?? '',
      label: existing?.config?.label ?? `bot:${bot.name}`,
      account: existing?.config?.account ?? '',
      services: existing?.config?.services ?? ['gmail', 'calendar'],
      schedule_cron: existing?.config?.schedule_cron ?? '',
      mcp_url: existing?.config?.url ?? resolvedApp?.url ?? '',
      mcp_var: existing?.config?.[resolvedApp?.variable?.key] ?? resolvedApp?.variable?.default ?? '',
      notes: existing?.config?.notes ?? '',
      instructions: existing?.config?.instructions ?? '',
      permission: existing?.config?.permission ?? (type === 'wecom' ? 'default' : 'plan'),
    }))
    const [wecomSessions, setWecomSessions] = useState(null)
    const [wecomLoading, setWecomLoading] = useState(false)
    const [wecomHint, setWecomHint] = useState('')
    const set = patch => setCfg(prev => ({ ...prev, ...patch }))
    const loadWecomSessions = async () => {
      setWecomLoading(true); setWecomHint('')
      try {
        const res = await fetchHost('/api/kode/wecom', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'sessions', include_groups: true }),
        })
        const json = await parseHostJson(res)
        if (res.ok && Array.isArray(json.sessions)) {
          setWecomSessions(json.sessions)
          if (json.help_message) setWecomHint(json.help_message)
          else if (json.error) setWecomHint(json.error)
        } else if (json?.error) {
          setWecomHint(json.error)
        }
      } catch { /* WeCom might not be authorized yet. */ }
      finally { setWecomLoading(false) }
    }
    useEffect(() => {
      if (type === 'wecom' && data.connector_env?.wecom?.authorized) void loadWecomSessions()
    }, [type])
    const submit = event => {
      event.preventDefault()
      const payload = type === 'wecom'
        ? { chat_id: cfg.chat_id, chat_name: cfg.chat_name, instructions: cfg.instructions, permission: cfg.permission }
        : type === 'webhook'
          ? { events_hint: cfg.events_hint, instructions: cfg.instructions, permission: cfg.permission }
          : type === 'github'
            ? { repo: cfg.repo, workspace: cfg.workspace, branch: cfg.branch, watch_commits: cfg.watch_commits, instructions: cfg.instructions, permission: cfg.permission }
            : type === 'team'
              ? { room: cfg.room, mode: cfg.mode, instructions: cfg.instructions, permission: cfg.permission }
              : type === 'slack'
                ? { workspace: cfg.workspace_name, channel: cfg.channel, mention_handle: cfg.mention_handle, instructions: cfg.instructions, permission: cfg.permission }
                : type === 'discord'
                  ? { server: cfg.server, channel: cfg.channel, mention_handle: cfg.mention_handle, instructions: cfg.instructions, permission: cfg.permission }
                  : type === 'linear'
                    ? { team: cfg.team, label: cfg.label, instructions: cfg.instructions, permission: cfg.permission }
                    : type === 'google'
                      ? { account: cfg.account, services: cfg.services, schedule_cron: cfg.schedule_cron, instructions: cfg.instructions, permission: cfg.permission }
                      : {
                        app_id: resolvedApp?.id ?? 'custom',
                        category: resolvedApp?.category ?? 'custom',
                        url: resolvedApp ? resolvedApp.url : cfg.mcp_url,
                        ...(resolvedApp?.variable ? { [resolvedApp.variable.key]: cfg.mcp_var } : {}),
                        notes: cfg.notes,
                      }
      void onSave({ ...(existing ? { id: existing.id } : {}), type, name: name.trim() || meta.name, enabled: existing ? existing.enabled : true, config: payload })
    }
    const permOptions = [{ value: 'plan', label: '只读分析（推荐）' }, { value: 'default', label: '常规执行（按需确认）' }, { value: 'acceptEdits', label: '允许编辑工作区' }]
    const toggleService = svc => {
      const has = cfg.services.includes(svc)
      const next = has ? cfg.services.filter(item => item !== svc) : [...cfg.services, svc]
      if (next.length) set({ services: next })
    }
    return h('form', { className: 'kode-agent-editor kode-connector-editor', onSubmit: submit },
      h('div', { className: 'kode-connector-editor-head' },
        h('span', { className: `kode-connector-badge is-${meta.tone}` }, meta.badge),
        h('strong', null, existing ? `编辑 ${meta.name}` : `添加 ${meta.name}`)),
      h('label', { className: 'kode-field' },
        h('span', null, '显示名称'),
        h('input', { value: name, maxLength: 64, disabled: busy, placeholder: meta.name, onChange: event => setName(event.target.value) })),
      type === 'wecom' && h(React.Fragment, null,
        h('p', { className: 'kode-config-note' }, data.connector_env?.wecom?.authorized
          ? `本机企业微信已授权${data.connector_env.wecom.bot_id ? `（${data.connector_env.wecom.bot_id}）` : ''}。保存后会自动开启企微消息监听、将所选会话加入监听列表并绑定到「${bot.name}」。`
          : '本机企业微信尚未授权：可先在「伙伴页 → 高级设置 → 企业微信机器人」完成扫码登录，或先填写 chat_id 预绑定。'),
        data.connector_env?.wecom?.authorized && h('div', { className: 'kode-connector-secret-row' },
          h(Button, { type: 'button', size: 'sm', variant: 'outline', disabled: busy || wecomLoading, onClick: () => void loadWecomSessions() }, wecomLoading ? '正在拉取企微会话…' : '刷新企微会话'),
          wecomSessions && h('span', { className: 'kode-secondary' }, `已发现 ${wecomSessions.length} 个会话`)),
        wecomHint && h('p', { className: 'kode-config-note' }, wecomHint),
        wecomSessions?.length > 0 && h(SelectField, {
          label: '从最近企微会话选择',
          value: cfg.chat_id,
          options: [{ value: '', label: '全部已监听的企微会话' }, ...wecomSessions.map(row => ({ value: row.chat_id, label: `${row.name || row.chat_id} (${row.chat_id})` }))],
          disabled: busy,
          onChange: value => {
            const picked = wecomSessions.find(row => row.chat_id === value)
            set({ chat_id: value, chat_name: picked?.name ?? '' })
          },
        }),
        h('label', { className: 'kode-field' },
          h('span', null, '企微会话 chat_id（留空 = 响应所有已监听会话）'),
          h('input', { value: cfg.chat_id, disabled: busy, placeholder: wecomLoading ? '正在加载企微会话…' : '例如 wrXXXX 或 userid', onChange: event => set({ chat_id: event.target.value }) }))),
      type === 'webhook' && h('label', { className: 'kode-field' },
        h('span', null, '用途说明（可选）'),
        h('input', { value: cfg.events_hint, disabled: busy, placeholder: '例如：CI 构建失败告警、Sentry 异常回调、表单提交', onChange: event => set({ events_hint: event.target.value }) })),
      type === 'github' && h(React.Fragment, null,
        h('p', { className: 'kode-config-note' }, data.connector_env?.github?.authenticated
          ? `本机 gh 已登录账号：${data.connector_env.github.account ?? '已认证'}。伙伴可直接通过本机 gh 读写 PR 与 Issue。`
          : data.connector_env?.github?.installed
            ? '检测到已安装 gh，但尚未登录；在终端运行 gh auth login 后伙伴即可直接操作 GitHub。'
            : '未检测到 gh CLI；安装并登录 gh 后伙伴即可操作 GitHub，同时仍可监听本地 Git 变更或 Webhook。'),
        h('label', { className: 'kode-field' },
          h('span', null, 'GitHub 仓库（可选，owner/repo）'),
          h('input', { value: cfg.repo, disabled: busy, placeholder: '例如：org/repo-name', onChange: event => set({ repo: event.target.value }) })),
        (data.workspaces?.length > 0 || cfg.workspace) && h(SelectField, {
          label: '监听本地 Git 工作区',
          value: cfg.workspace,
          options: [
            { value: '', label: '不监听本地 Git（仅用 Webhook / gh）' },
            ...(data.workspaces ?? []).map(row => ({ value: row.path, label: `${row.title} (${row.path})` })),
            ...(cfg.workspace && !(data.workspaces ?? []).some(row => row.path === cfg.workspace) ? [{ value: cfg.workspace, label: cfg.workspace }] : []),
          ],
          disabled: busy,
          onChange: value => set({ workspace: value }),
        }),
        cfg.workspace && h('label', { className: 'kode-field' },
          h('span', null, '仅监听分支（可选）'),
          h('input', { value: cfg.branch, disabled: busy, placeholder: '例如：main（留空表示全部分支）', onChange: event => set({ branch: event.target.value }) })),
        cfg.workspace && h('label', { className: 'kode-connector-check' },
          h('input', { type: 'checkbox', checked: cfg.watch_commits, disabled: busy, onChange: event => set({ watch_commits: event.target.checked }) }),
          h('span', null, '自动监听本地仓库的新提交（git.commit；取消勾选则改用专属 Webhook 触发）'))),
      type === 'team' && h(React.Fragment, null,
        h(SelectField, {
          label: '触发方式',
          value: cfg.mode,
          options: [{ value: 'mention', label: `被 @${bot.name} 提及时响应（推荐）` }, { value: 'all', label: '监听频道中的每一条新消息' }],
          disabled: busy,
          onChange: value => set({ mode: value }),
        }),
        h('label', { className: 'kode-field' },
          h('span', null, '限定频道名（可选，留空表示所有频道）'),
          h('input', { value: cfg.room, disabled: busy, placeholder: '例如：eng-alerts', onChange: event => set({ room: event.target.value }) }))),
      type === 'slack' && h(React.Fragment, null,
        h('div', { className: 'kode-watch-grid' },
          h('label', { className: 'kode-field' }, h('span', null, 'Slack 工作区（可选）'), h('input', { value: cfg.workspace_name, disabled: busy, placeholder: '例如：Acme Corp', onChange: event => set({ workspace_name: event.target.value }) })),
          h('label', { className: 'kode-field' }, h('span', null, '频道（可选）'), h('input', { value: cfg.channel, disabled: busy, placeholder: '例如：ops-bot', onChange: event => set({ channel: event.target.value }) }))),
        h('label', { className: 'kode-field' }, h('span', null, '提及名称（@handle）'), h('input', { value: cfg.mention_handle, disabled: busy, placeholder: bot.name, onChange: event => set({ mention_handle: event.target.value }) })),
        h('p', { className: 'kode-config-note' }, '保存后会生成专属本机 Webhook 地址，可从 Slack Event Subscriptions / Outgoing Webhook 或中转脚本推送过来。')),
      type === 'discord' && h(React.Fragment, null,
        h('div', { className: 'kode-watch-grid' },
          h('label', { className: 'kode-field' }, h('span', null, 'Discord 服务器（可选）'), h('input', { value: cfg.server, disabled: busy, placeholder: '例如：Engineering', onChange: event => set({ server: event.target.value }) })),
          h('label', { className: 'kode-field' }, h('span', null, '频道 / 子区（可选）'), h('input', { value: cfg.channel, disabled: busy, placeholder: '例如：bot-alerts', onChange: event => set({ channel: event.target.value }) }))),
        h('label', { className: 'kode-field' }, h('span', null, '提及名称（@handle）'), h('input', { value: cfg.mention_handle, disabled: busy, placeholder: bot.name, onChange: event => set({ mention_handle: event.target.value }) })),
        h('p', { className: 'kode-config-note' }, '保存后生成专属 Webhook 入口，可直接对接 Discord Bot / 中转脚本触发伙伴。')),
      type === 'linear' && h(React.Fragment, null,
        h('div', { className: 'kode-watch-grid' },
          h('label', { className: 'kode-field' }, h('span', null, 'Linear 团队（可选）'), h('input', { value: cfg.team, disabled: busy, placeholder: '例如：ENG', onChange: event => set({ team: event.target.value }) })),
          h('label', { className: 'kode-field' }, h('span', null, '触发标签（Label）'), h('input', { value: cfg.label, disabled: busy, placeholder: `bot:${bot.name}`, onChange: event => set({ label: event.target.value }) }))),
        h('p', { className: 'kode-config-note' }, '保存后生成专属 Webhook 地址，配置到 Linear Webhook 即可在 Issue 贴标、指派或 @ 提及时自动唤醒伙伴。')),
      type === 'google' && h(React.Fragment, null,
        h('label', { className: 'kode-field' }, h('span', null, 'Google 账号邮箱（可选）'), h('input', { value: cfg.account, disabled: busy, placeholder: 'you@company.com', onChange: event => set({ account: event.target.value }) })),
        h('div', { className: 'kode-connector-services' },
          h('span', { className: 'kode-secondary' }, '授权范围：'),
          ...[['gmail', 'Gmail'], ['calendar', 'Calendar'], ['drive', 'Drive']].map(([id, label]) =>
            h('label', { key: id, className: 'kode-connector-check' },
              h('input', { type: 'checkbox', checked: cfg.services.includes(id), disabled: busy, onChange: () => toggleService(id) }),
              h('span', null, label)))),
        h('label', { className: 'kode-field' }, h('span', null, '定时巡检 Cron（可选，留空则用 Webhook/MCP 触发）'), h('input', { value: cfg.schedule_cron, disabled: busy, placeholder: '例如：0 9 * * 1-5（工作日早上 9 点）', onChange: event => set({ schedule_cron: event.target.value }) }))),
      type === 'mcp' && h(React.Fragment, null,
        resolvedApp
          ? h(React.Fragment, null,
            h('p', { className: 'kode-config-note' }, `${resolvedApp.name} 官方 MCP 服务器：${resolvedApp.summary}。接入后伙伴在会话与自我介绍中都会知道可使用此应用。`),
            resolvedApp.variable?.choices
              ? h(SelectField, {
                label: resolvedApp.variable.label,
                value: cfg.mcp_var,
                options: resolvedApp.variable.choices.map(choice => ({ value: choice.value, label: `${choice.name}（${choice.value}）` })),
                disabled: busy,
                onChange: value => set({ mcp_var: value }),
              })
              : resolvedApp.variable
                ? h('label', { className: 'kode-field' },
                  h('span', null, resolvedApp.variable.label),
                  h('input', { value: cfg.mcp_var, disabled: busy, placeholder: resolvedApp.variable.placeholder || resolvedApp.variable.default, onChange: event => set({ mcp_var: event.target.value }) }))
                : h('p', { className: 'kode-secondary' }, `MCP 地址：${resolvedApp.url}`))
          : h('label', { className: 'kode-field' },
            h('span', null, 'MCP 服务器 URL'),
            h('input', { required: true, type: 'url', value: cfg.mcp_url, disabled: busy, placeholder: 'https://mcp.example.com/mcp', onChange: event => set({ mcp_url: event.target.value }) })),
        h('label', { className: 'kode-field' },
          h('span', null, '备注（可选）'),
          h('input', { value: cfg.notes, disabled: busy, placeholder: '例如：用于查生产日志或更新项目 Wiki', onChange: event => set({ notes: event.target.value }) }))),
      type !== 'mcp' && h(React.Fragment, null,
        h(SelectField, { label: '触发时的执行权限', value: cfg.permission, options: permOptions, disabled: busy, onChange: value => set({ permission: value }) }),
        h('label', { className: 'kode-field' },
          h('span', null, '收到事件时让伙伴做什么（留空使用默认说明）'),
          h('textarea', { rows: 3, value: cfg.instructions, disabled: busy, placeholder: '描述伙伴收到事件后的分析、回复与汇报规范…', onChange: event => set({ instructions: event.target.value }) }))),
      h(Failure, { text: error }),
      h('div', { className: 'kode-settings-footer' },
        h(Button, { type: 'button', variant: 'outline', disabled: busy, onClick: onCancel }, '取消'),
        h(Button, { type: 'submit', variant: 'primary', disabled: busy }, busy ? '保存中…' : existing ? '保存连接器' : '启用连接器')))
  }

  function BotConnectorsPanel({ bot, data }) {
    const connectors = bot.connectors ?? []
    const mcpApps = data.mcp_app_catalog?.length ? data.mcp_app_catalog : DEFAULT_MCP_APPS
    const [adding, setAdding] = useState(null) // { type, mcpApp? }
    const [editing, setEditing] = useState(null)
    const [category, setCategory] = useState('all')
    const [query, setQuery] = useState('')
    const [busy, setBusy] = useState('')
    const [error, setError] = useState('')
    const [notice, setNotice] = useState('')
    const [copied, setCopied] = useState('')
    const editorRef = useRef(null)
    useEffect(() => {
      if (adding || editing) {
        editorRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' })
      }
    }, [adding, editing])
    const act = async (label, body, successText = '') => {
      setBusy(label); setError(''); setNotice('')
      try {
        const value = await botsCall(body)
        if (Array.isArray(value.bots)) publishBots({ data: value, error: '' })
        if (successText) setNotice(successText)
        return value
      } catch (failure) { setError(failure.message); return null }
      finally { setBusy('') }
    }
    const copy = async (key, text) => {
      try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(prev => prev === key ? '' : prev), 2000) }
      catch { setNotice(text) }
    }
    const env = data.connector_env ?? {}
    const needle = query.trim().toLowerCase()
    const matchesSearch = (...parts) => !needle || parts.some(part => String(part ?? '').toLowerCase().includes(needle))
    const directCatalog = CONNECTOR_TYPES.filter(item =>
      (category === 'all' || item.category === category) && matchesSearch(item.name, item.type, item.summary, item.badge))
    const mcpCatalog = mcpApps.filter(app =>
      (category === 'all' || app.category === category) && matchesSearch(app.name, app.id, app.summary, app.url))

    return h('div', { className: 'kode-connectors-panel' },
      h('p', { className: 'kode-secondary' }, '给伙伴接入外部沟通通道、Webhook 或官方 MCP 应用（参考 Orca 连接器目录），外部消息、仓库变更或工具调用都能直接联动伙伴。'),
      h('div', { className: 'kode-connector-env-bar' },
        h('span', { className: `kode-connector-env-pill${env.wecom?.authorized ? ' is-ok' : ''}` }, `企业微信：${env.wecom?.authorized ? (env.wecom.enabled ? '已授权 · 监听中' : '已授权 · 未开启监听') : env.wecom?.installed ? '未登录' : '未安装'}`),
        h('span', { className: `kode-connector-env-pill${env.github?.authenticated ? ' is-ok' : ''}` }, `GitHub gh：${env.github?.authenticated ? (env.github.account || '已登录') : env.github?.installed ? '未登录' : '未安装'}`),
        h('span', { className: 'kode-connector-env-pill is-ok' }, '本机 Webhook：就绪'),
        h('span', { className: 'kode-connector-env-pill is-ok' }, `官方 MCP 目录：${mcpApps.length} 款`)),
      (adding || editing) && h('div', { ref: editorRef }, h(BotConnectorEditor, {
        key: editing ? editing.id : `add:${adding.type}:${adding.mcpApp?.id ?? ''}`,
        type: editing ? editing.type : adding.type,
        mcpApp: editing ? null : (adding.mcpApp ?? null),
        existing: editing,
        bot,
        data,
        busy: Boolean(busy),
        error,
        onCancel: () => { setAdding(null); setEditing(null); setError('') },
        onSave: async connector => {
          const saved = await act('save', { action: 'connector_upsert', bot_id: bot.id, connector }, editing ? '连接器已更新。' : '连接器已接入并生效。')
          if (saved) { setAdding(null); setEditing(null) }
        },
      })),
      notice && h('p', { className: 'kode-config-note', role: 'status' }, notice),
      !(adding || editing) && h(Failure, { text: error }),
      connectors.length > 0 && h('section', { className: 'kode-connectors-active' },
        h('h4', null, `已接入的连接器与应用 · ${connectors.length}`),
        h('ul', { className: 'kode-connector-list' }, ...connectors.map(conn => {
          const meta = connectorMeta(conn.type, conn.config?.app_id, mcpApps)
          const url = connectorWebhookUrl(conn.webhook_path)
          const curl = url && conn.secret ? `curl -X POST "${url}" -H "Authorization: Bearer ${conn.secret}" -H "Content-Type: application/json" -d '{"event":"ping","message":"hello"}'` : ''
          return h('li', { key: conn.id, className: `kode-connector-card${conn.enabled ? '' : ' is-paused'}` },
            h('div', { className: 'kode-connector-card-head' },
              h('span', { className: `kode-connector-badge is-${meta.tone}` }, meta.badge),
              h('div', { className: 'kode-connector-card-title' },
                h('strong', null, conn.name),
                h('span', { className: `kode-connector-status${conn.enabled ? ' is-on' : ''}` }, conn.enabled ? '已启用' : '已暂停')),
              h(FastSwitch, { checked: conn.enabled, disabled: Boolean(busy), label: conn.name, onChange: next => void act(conn.id, { action: 'connector_toggle', id: conn.id, enabled: next }) })),
            conn.how_to_ask && h('div', { className: 'kode-connector-how' },
              h('span', { className: 'kode-connector-how-label' }, conn.type === 'mcp' ? 'MCP 入口' : '如何呼叫'),
              h('span', null, conn.how_to_ask)),
            conn.type === 'mcp' && conn.config?.url && h('div', { className: 'kode-connector-webhook-box' },
              h('div', { className: 'kode-connector-webhook-row' },
                h('code', { className: 'kode-connector-url' }, conn.config.url),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => void copy(`mcp:${conn.id}`, conn.config.url) }, copied === `mcp:${conn.id}` ? '已复制' : '复制地址'))),
            url && h('div', { className: 'kode-connector-webhook-box' },
              h('div', { className: 'kode-connector-webhook-row' },
                h('code', { className: 'kode-connector-url' }, url),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => void copy(`url:${conn.id}`, url) }, copied === `url:${conn.id}` ? '已复制' : '复制地址'),
                conn.secret && h(Button, { size: 'sm', variant: 'ghost', onClick: () => void copy(`curl:${conn.id}`, curl) }, copied === `curl:${conn.id}` ? '已复制' : '复制 curl')),
              conn.secret && h('div', { className: 'kode-connector-secret-row' },
                h('span', { className: 'kode-secondary' }, `Bearer 密钥：${conn.secret.slice(0, 6)}••••••${conn.secret.slice(-4)}`),
                h(Button, { size: 'sm', variant: 'ghost', onClick: () => void copy(`sec:${conn.id}`, conn.secret) }, copied === `sec:${conn.id}` ? '已复制' : '复制密钥'),
                h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: () => { if (confirm('轮换后旧密钥会立即失效，确定轮换？')) void act(`rot:${conn.id}`, { action: 'connector_rotate', id: conn.id }, '已生成新密钥，请同步更新调用方。') } }, '轮换密钥'))),
            h('div', { className: 'kode-connector-card-foot' },
              h('span', { className: 'kode-secondary' }, conn.type === 'mcp'
                ? (conn.config?.notes || 'MCP 应用已绑定到此伙伴')
                : conn.event_count > 0 ? `已触发 ${conn.event_count} 次${conn.last_event_at ? ` · 最近 ${shortTime(conn.last_event_at)}` : ''}` : '尚未收到事件'),
              h('div', { className: 'kode-connector-card-actions' },
                conn.type !== 'mcp' && h(Button, { size: 'sm', variant: 'outline', disabled: Boolean(busy) || !conn.enabled, onClick: () => void act(`test:${conn.id}`, { action: 'connector_test', id: conn.id }, `已向「${bot.name}」发送测试触发事件，请留意看板或主对话。`) }, busy === `test:${conn.id}` ? '触发中…' : '测试触发'),
                h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: () => { setError(''); setAdding(null); setEditing(conn) } }, '编辑'),
                h(Button, { size: 'sm', variant: 'ghost', disabled: Boolean(busy), onClick: async () => { if (confirm(`移除连接器「${conn.name}」？`)) { const deleted = await act(`del:${conn.id}`, { action: 'connector_delete', id: conn.id }, '已移除连接器。'); if (deleted && editing?.id === conn.id) setEditing(null) } } }, '移除'))))
        }))),
      h('section', { className: 'kode-connectors-catalog' },
        h('div', { className: 'kode-connector-catalog-head' },
          h('h4', null, '添加连接器与应用'),
          h('div', { className: 'kode-kanban-search' },
            h(IconSearchOutlineRegular, { size: 15 }),
            h('input', { 'aria-label': '搜索连接器与应用', placeholder: '搜索企微、GitHub、Notion、Sentry、Webhook…', value: query, onChange: event => setQuery(event.target.value) }))),
        h('div', { className: 'kode-kanban-filters', role: 'tablist', 'aria-label': '连接器分类' },
          ...CONNECTOR_CATEGORIES.map(item => h('button', {
            key: item.id,
            type: 'button',
            className: 'kode-banner-chip',
            'aria-pressed': category === item.id,
            onClick: () => setCategory(item.id),
          }, item.label))),
        directCatalog.length > 0 && h(React.Fragment, null,
          h('div', { className: 'kode-connector-group-label' }, '通道与自定义连接器'),
          h('div', { className: 'kode-connector-grid' }, ...directCatalog.map(item => {
            const count = connectors.filter(row => row.type === item.type && (item.type !== 'mcp' || row.config?.app_id === 'custom')).length
            return h('button', {
              key: item.type,
              type: 'button',
              className: 'kode-connector-tile',
              disabled: Boolean(busy),
              onClick: () => { setError(''); setEditing(null); setAdding({ type: item.type }) },
            },
              h('div', { className: 'kode-connector-tile-head' },
                h('span', { className: `kode-connector-badge is-${item.tone}` }, item.badge),
                h('strong', null, item.name),
                count > 0 && h('span', { className: 'kode-connector-tile-count' }, `已加 ${count}`)),
              h('span', { className: 'kode-secondary kode-connector-tile-desc' }, item.summary))
          }))),
        mcpCatalog.length > 0 && h(React.Fragment, null,
          h('div', { className: 'kode-connector-group-label' }, `官方 MCP 应用 · ${mcpCatalog.length}`),
          h('div', { className: 'kode-connector-grid' }, ...mcpCatalog.map(app => {
            const added = connectors.some(row => row.type === 'mcp' && row.config?.app_id === app.id)
            const tone = CATEGORY_TONES[app.category] ?? 'blue'
            return h('button', {
              key: app.id,
              type: 'button',
              className: 'kode-connector-tile',
              disabled: Boolean(busy),
              onClick: () => { setError(''); setEditing(null); setAdding({ type: 'mcp', mcpApp: app }) },
            },
              h('div', { className: 'kode-connector-tile-head' },
                h('span', { className: `kode-connector-badge is-${tone}` }, app.badge || 'MCP'),
                h('strong', null, app.name),
                added && h('span', { className: 'kode-connector-tile-count is-added' }, '已接入')),
              h('span', { className: 'kode-secondary kode-connector-tile-desc' }, app.summary))
          }))),
        directCatalog.length === 0 && mcpCatalog.length === 0 && h('p', { className: 'kode-secondary' }, '没有匹配的连接器或应用，换个关键词试试，或选择「自定义 MCP」通过 URL 接入。')))
  }
