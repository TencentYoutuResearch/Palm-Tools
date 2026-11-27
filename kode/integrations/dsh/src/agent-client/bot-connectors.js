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
      if (app) return { type: 'mcp', appId: app.id, name: app.name, badge: app.badge || 'MCP', tone: CATEGORY_TONES[app.category] ?? 'blue', summary: app.summary }
    }
    return CONNECTOR_TYPES.find(item => item.type === type) ?? { type, name: type, badge: type, tone: 'slate', summary: '' }
  }

  // Brand & service vector marks (24x24 viewBox) for direct connectors and official MCP apps.
  const CONNECTOR_ICON_SPECS = {
    wecom: {
      bg: '#07c160',
      render: () => [
        h('path', { key: 'b1', fill: '#fff', d: 'M9.5 4C5.36 4 2 6.84 2 10.35c0 1.95 1.05 3.69 2.7 4.86l-.68 2.18 2.38-1.19c.96.29 2 .45 3.1.45.28 0 .55-.01.82-.04A5.8 5.8 0 0 1 10 14.8c0-3.31 3.13-6 7-6 .17 0 .34.01.5.02C16.76 6.06 13.47 4 9.5 4Zm-2.4 4.3a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Zm4.8 0a.95.95 0 1 1 0 1.9.95.95 0 0 1 0-1.9Z' }),
        h('path', { key: 'b2', fill: '#fff', opacity: 0.94, d: 'M16.5 10c-3.04 0-5.5 2.1-5.5 4.7 0 2.6 2.46 4.7 5.5 4.7.82 0 1.6-.15 2.3-.43l1.88.94-.54-1.72C21.29 17.3 22 16.07 22 14.7c0-2.6-2.46-4.7-5.5-4.7Zm-1.85 3.2a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Zm3.7 0a.75.75 0 1 1 0 1.5.75.75 0 0 1 0-1.5Z' }),
      ],
    },
    github: {
      bg: '#24292f',
      render: () => [
        h('path', { key: 'gh', fill: '#fff', fillRule: 'evenodd', clipRule: 'evenodd', d: 'M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z' }),
      ],
    },
    slack: {
      bg: '#4a154b',
      render: () => [
        h('path', { key: 's1', fill: '#e01e5a', d: 'M6.2 14.6a2 2 0 1 1-2-2h2v2Zm1 0a2 2 0 1 1 4 0v5a2 2 0 1 1-4 0v-5Z' }),
        h('path', { key: 's2', fill: '#36c5f0', d: 'M9.4 6.2a2 2 0 1 1 2-2v2h-2Zm0 1a2 2 0 1 1 0 4h-5a2 2 0 1 1 0-4h5Z' }),
        h('path', { key: 's3', fill: '#2eb67d', d: 'M17.8 9.4a2 2 0 1 1 2 2h-2v-2Zm-1 0a2 2 0 1 1-4 0v-5a2 2 0 1 1 4 0v5Z' }),
        h('path', { key: 's4', fill: '#ecb22e', d: 'M14.6 17.8a2 2 0 1 1-2 2v-2h2Zm0-1a2 2 0 1 1 0-4h5a2 2 0 1 1 0 4h-5Z' }),
      ],
    },
    discord: {
      bg: '#5865f2',
      render: () => [
        h('path', { key: 'dc', fill: '#fff', d: 'M19.27 5.33C17.94 4.71 16.5 4.26 15 4a.09.09 0 0 0-.07.03c-.18.33-.39.76-.53 1.09a16.09 16.09 0 0 0-4.8 0c-.14-.34-.35-.76-.54-1.09-.01-.02-.04-.03-.07-.03-1.5.26-2.93.71-4.27 1.33-.01 0-.02.01-.03.02-2.72 4.07-3.47 8.03-3.1 11.95 0 .02.01.04.03.05 1.8 1.32 3.53 2.12 5.24 2.65.03.01.06 0 .07-.02.4-.55.76-1.13 1.07-1.74.02-.04 0-.08-.04-.09-.57-.22-1.11-.48-1.64-.78-.04-.02-.04-.08-.01-.11.11-.08.22-.17.33-.25.02-.02.05-.02.07-.01 3.44 1.57 7.15 1.57 10.55 0 .02-.01.05-.01.07.01.11.09.22.17.33.26.04.03.04.09-.01.11-.52.31-1.07.56-1.64.78-.04.01-.05.06-.04.09.32.61.68 1.19 1.07 1.74.03.02.06.03.09.02 1.72-.53 3.45-1.33 5.25-2.65.02-.01.03-.03.03-.05.44-4.53-.73-8.46-3.1-11.95-.01-.01-.02-.02-.04-.02ZM8.52 14.91c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.84 2.12-1.89 2.12Zm6.97 0c-1.03 0-1.89-.95-1.89-2.12s.84-2.12 1.89-2.12c1.06 0 1.9.96 1.89 2.12 0 1.17-.83 2.12-1.89 2.12Z' }),
      ],
    },
    linear: {
      bg: '#5e6ad2',
      render: () => [
        h('circle', { key: 'c', cx: 12, cy: 12, r: 8.8, fill: 'none', stroke: '#fff', strokeWidth: 1.75 }),
        h('path', { key: 'l', d: 'M5.8 18.2 18.2 5.8M3.9 14.4 14.4 3.9M4.4 10.1 10.1 4.4', stroke: '#fff', strokeWidth: 1.75, strokeLinecap: 'round' }),
        h('path', { key: 'f', fill: '#fff', opacity: 0.92, d: 'M12 20.8a8.8 8.8 0 0 0 8.8-8.8L12 20.8Z' }),
      ],
    },
    google: {
      bg: '#ffffff',
      light: true,
      render: () => [
        h('path', { key: 'g1', fill: '#4285f4', d: 'M20.64 12.2c0-.64-.06-1.25-.16-1.84H12v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z' }),
        h('path', { key: 'g2', fill: '#34a853', d: 'M12 21c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.33-1.58-5.04-3.71H3.96v2.33A9 9 0 0 0 12 21Z' }),
        h('path', { key: 'g3', fill: '#fbbc05', d: 'M6.96 13.71a5.41 5.41 0 0 1 0-3.42V7.96H3.96a9 9 0 0 0 0 8.08l3-2.33Z' }),
        h('path', { key: 'g4', fill: '#ea4335', d: 'M12 6.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C16.46 3.89 14.42 3 12 3a9 9 0 0 0-8.04 4.96l3 2.33c.71-2.13 2.7-3.71 5.04-3.71Z' }),
      ],
    },
    team: {
      bg: '#2563eb',
      render: () => [
        h('path', { key: 'tm', d: 'M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM20 19v-1.4a3 3 0 0 0-2.2-2.9M15.5 4.7a3 3 0 0 1 0 5.6', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ],
    },
    webhook: {
      bg: '#7c3aed',
      render: () => [
        h('path', { key: 'wh', d: 'M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2M6 17l3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06M12 6l3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ],
    },
    mcp: {
      bg: '#0284c7',
      render: () => [
        h('path', { key: 'mcp', d: 'M12 21v-4.5M9 8V3.5M15 8V3.5M18 8v3.5a6 6 0 0 1-12 0V8h12Z', fill: 'none', stroke: '#fff', strokeWidth: 1.95, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ],
    },
    'mcp:vercel': {
      bg: '#18181b',
      render: () => [h('path', { key: 'vc', fill: '#fff', d: 'M12 4.5 20.5 19h-17L12 4.5Z' })],
    },
    'mcp:cloudflare': {
      bg: '#f38020',
      render: () => [h('path', { key: 'cf', fill: '#fff', d: 'M17.4 17.2H7.1a3.7 3.7 0 0 1-.4-7.38A5.2 5.2 0 0 1 16.6 8.4a4.4 4.4 0 0 1 .8 8.8Z' })],
    },
    'mcp:supabase': {
      bg: '#18181b',
      render: () => [
        h('path', { key: 'sb1', fill: '#3ecf8e', d: 'M13.2 21.1c-.5.63-1.5.28-1.5-.53V13h6.6c.86 0 1.34.99.8 1.66l-5.9 6.44Z' }),
        h('path', { key: 'sb2', fill: '#3ecf8e', opacity: 0.78, d: 'M10.8 2.9c.5-.63 1.5-.28 1.5.53V11H5.7c-.86 0-1.34-.99-.8-1.66l5.9-6.44Z' }),
      ],
    },
    'mcp:neon': {
      bg: '#0d2922',
      render: () => [h('path', { key: 'ne', d: 'M5 19V5h14v9.5L14.5 10v9H5Z', fill: 'none', stroke: '#00e599', strokeWidth: 2.1, strokeLinejoin: 'round' })],
    },
    'mcp:netlify': {
      bg: '#00ad9f',
      render: () => [h('path', { key: 'nl', d: 'M12 3 21 12l-9 9-9-9 9-9Zm-4.5 9h9M12 7.5v9', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' })],
    },
    'mcp:gitlab': {
      bg: '#e24329',
      render: () => [h('path', { key: 'gl', fill: '#fff', d: 'm21.4 13.8-1.1-3.4-2.2-6.7a.45.45 0 0 0-.86 0l-2.1 6.5H8.86L6.76 3.7a.45.45 0 0 0-.86 0L3.7 10.4l-1.1 3.4a.9.9 0 0 0 .33 1l9.07 6.6 9.07-6.6a.9.9 0 0 0 .33-1Z' })],
    },
    'mcp:context7': {
      bg: '#059669',
      render: () => [h('path', { key: 'c7', d: 'M4.5 5.5A2.5 2.5 0 0 1 7 3h12.5v16H7a2.5 2.5 0 0 0-2.5 2.5v-16Zm5.5 5L8.5 12l1.5 1.5m4.5-3L16 12l-1.5 1.5', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' })],
    },
    'mcp:sentry': {
      bg: '#362d59',
      render: () => [h('path', { key: 'st', d: 'M13.5 5.2a1.8 1.8 0 0 0-3.1 0L3.6 17a1.8 1.8 0 0 0 1.55 2.7h2.7a6.2 6.2 0 0 0-2.6-4.4l1.2-2.1a8.6 8.6 0 0 1 4.1 6.5h3.1a11 11 0 0 0-6.8-9.7l1.3-2.2a13.5 13.5 0 0 1 9.3 11.9h2.9A1.8 1.8 0 0 0 21.9 17L15 5.2', fill: 'none', stroke: '#fff', strokeWidth: 1.75, strokeLinecap: 'round', strokeLinejoin: 'round' })],
    },
    'mcp:datadog': {
      bg: '#632ca6',
      render: () => [
        h('rect', { key: 'r', x: 3.5, y: 4, width: 17, height: 16, rx: 3.5, fill: 'none', stroke: '#fff', strokeWidth: 1.8 }),
        h('path', { key: 'p', d: 'M6.5 13h2.6l1.7-4 2.4 6.5 1.8-3.5h2.5', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ],
    },
    'mcp:posthog': {
      bg: '#f54e00',
      render: () => [h('path', { key: 'ph', d: 'M5 18v-4m4.6 4v-7m4.6 7V7m4.8 11V4.5', stroke: '#fff', strokeWidth: 2.3, strokeLinecap: 'round' })],
    },
    'mcp:atlassian': {
      bg: '#0052cc',
      render: () => [h('path', { key: 'at', fill: '#fff', d: 'M8.1 11.4c-.4-.5-1.1-.4-1.4.1L3.4 18.2c-.3.6.1 1.3.8 1.3h4.6c.4 0 .7-.2.9-.6 1-2.2.4-5.6-1.6-7.5Zm4.6-6.8c-.4-.7-1.4-.7-1.7 0-2 4.1-2.2 8.5-.6 12.2.2.4.5.7 1 .7h8.4c.7 0 1.1-.7.8-1.3L12.7 4.6Z' })],
    },
    'mcp:notion': {
      bg: '#1f2328',
      render: () => [
        h('rect', { key: 'nr', x: 4, y: 3.5, width: 16, height: 17, rx: 2.5, fill: 'none', stroke: '#fff', strokeWidth: 1.8 }),
        h('path', { key: 'nn', d: 'M8.5 16.5v-9l7 9v-9', fill: 'none', stroke: '#fff', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      ],
    },
    'mcp:clickup': {
      bg: '#7b68ee',
      render: () => [h('path', { key: 'cu', d: 'm6.5 11.2 5.5-5 5.5 5M7.2 15.8a6.8 6.8 0 0 0 9.6 0', fill: 'none', stroke: '#fff', strokeWidth: 2.3, strokeLinecap: 'round', strokeLinejoin: 'round' })],
    },
    'mcp:airtable': {
      bg: '#18181b',
      render: () => [
        h('path', { key: 'a1', fill: '#fcb400', d: 'M12 4.2 20 7.6 12 11 4 7.6 12 4.2Z' }),
        h('path', { key: 'a2', fill: '#18bfff', d: 'm12.7 12.2 7.3-3.1v6.8l-7.3 3.3v-7Z' }),
        h('path', { key: 'a3', fill: '#f82b60', d: 'm11.3 12.2-7.3-3.1v6.8l7.3 3.3v-7Z' }),
      ],
    },
    'mcp:todoist': {
      bg: '#e44332',
      render: () => [h('path', { key: 'td', d: 'm4 8.5 3.6 2.1L15 6.2M4 12.8l3.6 2.1L15 10.5M4 17.1l3.6 2.1L15 14.8', fill: 'none', stroke: '#fff', strokeWidth: 1.95, strokeLinecap: 'round', strokeLinejoin: 'round' })],
    },
    'mcp:zapier': {
      bg: '#ff4f00',
      render: () => [h('path', { key: 'zp', d: 'M12 4.5v15M4.5 12h15M6.7 6.7l10.6 10.6M17.3 6.7 6.7 17.3', stroke: '#fff', strokeWidth: 2.1, strokeLinecap: 'round' })],
    },
    'mcp:granola': {
      bg: '#15803d',
      render: () => [h('path', { key: 'gr', d: 'M6 10v4m4-7v10m4-8v6m4-4v2', stroke: '#fff', strokeWidth: 2.2, strokeLinecap: 'round' })],
    },
    'mcp:stripe': {
      bg: '#635bff',
      render: () => [h('path', { key: 'sp', fill: '#fff', d: 'M12.3 9.7c-1.5-.5-2.2-.9-2.2-1.6 0-.6.5-1 1.5-1 1.3 0 2.6.5 3.5 1l.9-2.6A8.8 8.8 0 0 0 11.7 4.5c-2.8 0-4.7 1.5-4.7 3.8 0 2.5 1.9 3.4 4.1 4.1 1.6.6 2.2 1 2.2 1.8 0 .7-.7 1.2-1.8 1.2-1.4 0-3-.6-4.1-1.3l-.9 2.7c1.1.7 2.9 1.2 4.8 1.2 3 0 5-1.4 5-3.9 0-2.6-1.9-3.6-4-4.4Z' })],
    },
    'mcp:intercom': {
      bg: '#0057ff',
      render: () => [
        h('rect', { key: 'ir', x: 4, y: 4, width: 16, height: 16, rx: 4, fill: 'none', stroke: '#fff', strokeWidth: 1.75 }),
        h('path', { key: 'ib', d: 'M8 8.5v4.2m2.7-5.2v6.2m2.6-6.2v6.2M16 8.5v4.2M7.8 15.4c1.2 1 2.7 1.5 4.2 1.5s3-.5 4.2-1.5', fill: 'none', stroke: '#fff', strokeWidth: 1.65, strokeLinecap: 'round' }),
      ],
    },
  }

  function ConnectorIcon({ type, appId = null, size = 28, compact = false }) {
    const spec = (type === 'mcp' && appId && CONNECTOR_ICON_SPECS[`mcp:${appId}`])
      || CONNECTOR_ICON_SPECS[type]
      || CONNECTOR_ICON_SPECS.mcp
    const glyphSize = Math.round(size * (compact ? 0.68 : 0.6))
    return h('span', {
      className: `kode-connector-icon${compact ? ' is-compact' : ''}${spec.light ? ' is-light' : ''}`,
      style: { width: `${size}px`, height: `${size}px`, background: spec.bg },
      'aria-hidden': true,
    }, h('svg', { width: glyphSize, height: glyphSize, viewBox: '0 0 24 24', fill: 'none' }, ...spec.render()))
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
        }, h(ConnectorIcon, { type: conn.type, appId: conn.config?.app_id, size: 18, compact: true }), conn.name || meta.name)
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
        h(ConnectorIcon, { type, appId: resolvedApp?.id, size: 28 }),
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
        h('span', { className: `kode-connector-env-pill${env.wecom?.authorized ? ' is-ok' : ''}` }, h(ConnectorIcon, { type: 'wecom', size: 16, compact: true }), `企业微信：${env.wecom?.authorized ? (env.wecom.enabled ? '已授权 · 监听中' : '已授权 · 未开启监听') : env.wecom?.installed ? '未登录' : '未安装'}`),
        h('span', { className: `kode-connector-env-pill${env.github?.authenticated ? ' is-ok' : ''}` }, h(ConnectorIcon, { type: 'github', size: 16, compact: true }), `GitHub gh：${env.github?.authenticated ? (env.github.account || '已登录') : env.github?.installed ? '未登录' : '未安装'}`),
        h('span', { className: 'kode-connector-env-pill is-ok' }, h(ConnectorIcon, { type: 'webhook', size: 16, compact: true }), '本机 Webhook：就绪'),
        h('span', { className: 'kode-connector-env-pill is-ok' }, h(ConnectorIcon, { type: 'mcp', size: 16, compact: true }), `官方 MCP 目录：${mcpApps.length} 款`)),
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
              h(ConnectorIcon, { type: conn.type, appId: conn.config?.app_id, size: 30 }),
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
                h(ConnectorIcon, { type: item.type, size: 28 }),
                h('strong', null, item.name),
                count > 0 && h('span', { className: 'kode-connector-tile-count' }, `已加 ${count}`)),
              h('span', { className: 'kode-secondary kode-connector-tile-desc' }, item.summary))
          }))),
        mcpCatalog.length > 0 && h(React.Fragment, null,
          h('div', { className: 'kode-connector-group-label' }, `官方 MCP 应用 · ${mcpCatalog.length}`),
          h('div', { className: 'kode-connector-grid' }, ...mcpCatalog.map(app => {
            const added = connectors.some(row => row.type === 'mcp' && row.config?.app_id === app.id)
            return h('button', {
              key: app.id,
              type: 'button',
              className: `kode-connector-tile${added ? ' is-added' : ''}`,
              disabled: Boolean(busy),
              onClick: () => { setError(''); setEditing(null); setAdding({ type: 'mcp', mcpApp: app }) },
            },
              h('div', { className: 'kode-connector-tile-head' },
                h(ConnectorIcon, { type: 'mcp', appId: app.id, size: 28 }),
                h('strong', null, app.name),
                added && h('span', { className: 'kode-connector-tile-count is-added' }, '已接入')),
              h('span', { className: 'kode-secondary kode-connector-tile-desc' }, app.summary))
          }))),
        directCatalog.length === 0 && mcpCatalog.length === 0 && h('p', { className: 'kode-secondary' }, '没有匹配的连接器或应用，换个关键词试试，或选择「自定义 MCP」通过 URL 接入。')))
  }
