# Tasks

- [ ] 修改 `apps/specops/frontend/src/components/chat/Composer.svelte:137` 的 `onkeydown` 守卫,
      从 `if (e.key === 'Enter' && !e.shiftKey)` 改为
      `if (e.key === 'Enter' && !e.shiftKey && !e.isComposing)`
- [ ] 修改 `apps/specops/frontend/src/components/iwiki/AskFloat.svelte:145` 的 `onkeydown` 守卫,
      从 `if (e.key === 'Enter' && !e.shiftKey)` 改为
      `if (e.key === 'Enter' && !e.shiftKey && !e.isComposing)`
- [ ] `pnpm check`(cwd=`apps/specops`)svelte-check 类型检查通过
- [ ] `pnpm test`(cwd=`apps/specops`)现有测试通过,无回归
- [ ] 手动验证:SpecOps 控制台主聊天框中文拼音输入 + IME 候选框出现时按 Enter,候选词进 textarea、
      消息不发送;再按一次 Enter 才发送
- [ ] 手动验证:`AskFloat` 浮层(intake/plan/clarify/doc)IME 组合期 Enter 不创建 session
- [ ] 手动验证:Shift+Enter 换行行为不受影响
