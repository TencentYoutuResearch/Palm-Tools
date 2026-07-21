# Tasks

- [ ] 把 `body`(`apps/specops/src/server/public/styles.css:216`)从 `min-height: 100vh` 改为固定视口高度 `height: 100vh` 并加 `overflow: hidden`,消除页面级全局滚动
- [ ] 把 `.shell`(`:225` 起)从 `min-height: 100vh` 改为 `height: 100vh`,并确认 grid 行 `56px minmax(0, 1fr)` 在固定高度下正确分配
- [ ] 给中间工作区 `.workspace`(`:737-744`)的主内容区设置 `overflow-y: auto`(保持 `min-height: 0`),使其内容超高时只在自身内部上下滚动
- [ ] 确认/补齐右侧 inspector 区域为独立滚动容器(`overflow-y: auto` + `min-height: 0`)
- [ ] 验证 rail 现有独立滚动(`.rail` `overflow: hidden` + `#documents`/`#sessions` `overflow-y: auto`)未被破坏
- [ ] 在浏览器中目视验证:任一区域内容超高时无全局滚动条,三区域各自独立滚动,masthead 固定可见
