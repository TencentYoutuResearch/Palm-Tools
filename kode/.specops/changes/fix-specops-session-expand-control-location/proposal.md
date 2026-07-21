---
schema_version: 1
id: fix-specops-session-expand-control-location
kind: bug
title: 把 session 放大/缩小(展开/还原)控件从 SpecOps 左侧栏迁到右侧 session 区域的每个 session 卡片上
status: completed
verifies: []
paths:
  - apps/specops/src/server/public/app.js
  - apps/specops/src/server/public/index.html
  - apps/specops/src/server/public/styles.css
---

# 把 session 放大/缩小(展开/还原)控件从 SpecOps 左侧栏迁到右侧 session 区域的每个 session 卡片上

> 原始请求(逐字引用):
> 之前放大缩小搞错地方了，放在了kode里面的左侧栏了而不是specops的右边session区域

## Motivation

SpecOps Web UI(`apps/specops/src/server/public/`)的 session "放大/缩小"
(展开/还原)行为目前被实现在**左侧 rail 的 Sessions 列表里**:点击列表中的每个
session 卡片(`.session-container` 的 button)会就地在左栏内 toggle `expanded` 态、
展开 `.session-detail`(`apps/specops/src/server/public/app.js:273-304`),并由
`renderExpandedSession`(`apps/specops/src/server/public/app.js:310` 起)在**左栏内部**
渲染一份完整的展开视图(`.expanded-session-panel` / `.expanded-header` 等)。

这放错了地方。SpecOps 真正用于展示单个 session 的区域是**右侧第三栏**
`<aside class="diagnostics session-status-panel">`(`apps/specops/src/server/public/index.html:107`),
其中 `#run-panel`(`.session-card`,`:113-117` 的 `.run-panel-header`)才是 session
卡片本体,内容由 `showSessionCompact`(`apps/specops/src/server/public/app.js:612`)写入。

因此当前出现两套并存且职责错位的展示:左栏既当导航列表、又在自己内部塞了一份"放大"
的完整面板;右栏的 session 卡片才是该承载放大/缩小的地方,却没有这个控件。用户的诉求是:
**放大/缩小(展开/还原)应该挂在右侧 session 区域的每个 session 卡片上,而不是塞进左侧
rail 列表里。**

> 说明:原始请求中文写作「kode里面的左侧栏」,经确认指的是 **SpecOps UI 的左侧 rail
> 列表**(SpecOps 嵌在 kode 内),而非 kode 主 GUI(`apps/gui`)。本变更只动 SpecOps
> 前端三件套,不碰 `apps/gui`。

## Scope

- **从左侧 rail 移除放大态**:让 `#sessions` 列表里的 `.session-container` 卡片
  (`apps/specops/src/server/public/app.js:273-307`)只承担"选择/导航 + 紧凑摘要"职责,
  点击时不再在左栏内部就地展开整份 `.session-detail` / `.expanded-session-panel`;
  相应地清理 `renderExpandedSession` 及其只为左栏展开而存在的 DOM 构建
  (`expanded-session-panel` / `expanded-header` / `expanded-transcript` /
  `expanded-composer-*` 等,`apps/specops/src/server/public/app.js:310` 起一段)。
- **在右侧 session 卡片上提供放大/缩小**:在 `#run-panel` 的 `.run-panel-header`
  (`apps/specops/src/server/public/index.html:114-117`,与 `#close-session` 同排)
  新增一个"放大/缩小(展开/还原)"切换按钮;放大态把右侧 session 区域
  (`.session-status-panel` / `#run-panel`)放大到占据更大宽度/高度,再次点击还原。
  行为对应右栏由 `showSessionCompact`(`apps/specops/src/server/public/app.js:612`)
  驱动的"当前 session 卡片"。
- **样式归位**:在 `apps/specops/src/server/public/styles.css` 增补右侧 session 卡片
  的放大/还原态样式,移除/收敛原本只服务左栏展开的 `.expanded-*` 样式
  (按实际不再使用的部分清理)。
- 保持选中 session→右栏展示(`showSessionCompact` / `clearSessionPanel`,
  `:546`、`:612`)的既有数据流不变,只改"放大/缩小控件挂在哪、放大的是哪一块区域"。

## Acceptance criteria

- 在 SpecOps UI 中,放大/缩小(展开/还原)控件出现在**右侧 session 区域**
  (`.session-status-panel` 的 session 卡片头部),而**不再**出现在左侧 rail 的
  Sessions 列表内部。
- 点击右侧 session 卡片上的放大按钮,右侧 session 区域被放大(占据更大显示空间);
  再次点击(缩小/还原)恢复到默认尺寸。状态可重复 toggle。
- 点击左侧 rail 的 session 列表项仍可正常**选中**该 session 并在右侧区域展示其内容,
  但**不再**在左栏内部就地渲染整份展开面板。
- 既有的 session 选择、transcript、phase actions、composer 等功能在右侧区域照常工作,
  不因控件迁移而丢失。
- 改动范围仅限 `apps/specops/src/server/public/{app.js,index.html,styles.css}`,
  不触碰 `apps/gui` 主 GUI、不改后端/domain 代码。

## Out of scope

- 不改 kode 主 GUI(`apps/gui/src/App.svelte`)的左侧 tab 栏或 inspector 展开逻辑。
- 不改 session 的数据模型、API、phase/state 流转或 transcript 内容来源。
- 不重做左侧 rail 列表的整体视觉,只去掉其内部"就地放大整份面板"的行为。
- 不在本变更内顺带做无关的滚动/布局重构(若与
  `fix-specops-independent-region-scroll` 相关,各自独立处理)。
- 不调整放大态的具体像素尺寸细节到逐像素 polish,先保证控件位置与放大/还原行为正确。
