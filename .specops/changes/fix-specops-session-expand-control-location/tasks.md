# Tasks

- [ ] 在 `#run-panel` 的 `.run-panel-header`(`apps/specops/src/server/public/index.html:114-117`,与 `#close-session` 同排)新增放大/缩小(展开/还原)切换按钮
- [ ] 在 `apps/specops/src/server/public/app.js` 给该按钮接上 toggle 逻辑:放大态给右侧 `.session-status-panel` / `#run-panel` 加放大 class,再次点击还原
- [ ] 在 `apps/specops/src/server/public/styles.css` 增补右侧 session 卡片放大/还原态样式(放大占更大宽/高,还原回默认)
- [ ] 从左侧 rail session 卡片点击逻辑(`app.js:273-307`)移除"就地在左栏展开整份面板"的行为,保留选中→右侧展示
- [ ] 清理/收敛只服务左栏展开的 `renderExpandedSession` 及 `.expanded-*` DOM 构建(`app.js:310` 起一段)与对应 CSS
- [ ] 在浏览器中目视验证:控件在右侧 session 卡片头部、放大/还原可重复 toggle、左栏点击仍能正常选中并在右侧展示
