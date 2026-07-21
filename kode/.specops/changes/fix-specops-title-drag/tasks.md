# Tasks

- [ ] **Resizer.svelte**: 将 `top: 0` 改为 `top: 44px`，使 Resizer 从 header 下方开始，避免与 header 拖拽区域重叠
- [ ] **Resizer.svelte**: 确保 `top: 44px` 通过 CSS 自定义属性传入（如 `--header-height`），避免硬编码
- [ ] **ChatHeader.svelte**: 移除 `.head-right` 的 `data-tauri-drag-region` 属性（与 `-webkit-app-region: no-drag` CSS 矛盾）
- [ ] **IwikiHeader.svelte**: 检查 `.head-right` 的 `data-tauri-drag-region` + `-webkit-app-region: drag` + `pointer-events: none` 组合，调整为与 ChatHeader 一致的 `no-drag` + 无 `data-tauri-drag-region` 方案
- [ ] 在 ChatModule 和 IwikiModule 中手动验证：左侧栏展开/收起、右侧栏展开/收起共 4 种组合下 title 区域拖拽窗口均正常
- [ ] 验证 Resizer 列宽调整功能不受影响
- [ ] 运行 `pnpm check` 和 `pnpm test` 确认通过
