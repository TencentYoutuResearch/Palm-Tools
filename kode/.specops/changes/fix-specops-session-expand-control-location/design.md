# 设计说明

## 现状(放错的地方)

SpecOps UI 有两处展示 session 的位置:

1. **左侧 rail 的 Sessions 列表**(`#sessions`,`index.html:41`)——本意是导航列表。
   但 `app.js:273-307` 的点击 handler 在这里**就地**做了"放大":toggle `expanded`、
   展开 `.session-detail`,并调 `renderExpandedSession`(`app.js:310` 起)在左栏内部
   渲染一整份 `.expanded-session-panel`(含 `expanded-header` / `expanded-transcript` /
   `expanded-composer-*`)。
2. **右侧第三栏**(`.session-status-panel`,`index.html:107`)——`#run-panel`
   (`.session-card`)才是 session 卡片本体,由 `showSessionCompact`(`app.js:612`)填充。
   这里才是"放大/缩小当前 session"应该发生的地方,但目前没有放大控件。

错位点:放大行为被绑在左栏列表项上、放大的是"塞进左栏的一份副本面板",而不是右栏那张
真正的 session 卡片。

## 目标布局

- 左栏列表项 = 纯导航 + 紧凑摘要。点击只负责"选中 session → 右栏展示",不再在左栏内部
  铺开整份面板。
- 右栏 session 卡片(`#run-panel`)= 单 session 的完整展示,头部新增"放大/缩小"切换。
  放大 = 让右侧 session 区域占据更大显示空间;缩小/还原 = 回默认尺寸。

## 实现要点

- **按钮挂载**:放在 `index.html:114-117` 的 `.run-panel-header`,和 `#close-session`
  同一排,语义上属于"当前 session 卡片"的操作。
- **toggle 状态**:在 `app.js` 维护一个 expanded 布尔,点击给
  `.session-status-panel`(或 `#run-panel`)加/去放大 class;参考左栏现有
  `container.classList.toggle('expanded', …)`(`app.js:283`)的写法,只是把目标换成右栏。
- **放大尺寸**:SpecOps 外壳是 grid `260px / 1fr / minmax(300px, 340px)`
  (`styles.css:227`)。放大态可让第三栏临时占据更大宽度(或叠加为更大浮层),用 CSS class
  控制,默认态尺寸不变;具体策略在实现时定,先保证"放大/还原"语义正确。
- **清理左栏放大**:移除 `app.js:273-307` 中"就地展开整份面板"的分支与
  `renderExpandedSession` 一段,以及只服务它的 `.expanded-*` CSS;保留选中→
  `showSessionCompact` 的数据流。

## 取舍

- 只动 SpecOps 前端三件套(`app.js` / `index.html` / `styles.css`),不碰后端与 `apps/gui`:
  这是一个"控件挂错位置"的前端布局/交互问题,数据流本身正确。
- 放大态优先用 CSS class 切换而非新建独立组件,复用现有右栏 DOM,改动面最小、回滚容易。
- 与 `fix-specops-independent-region-scroll`(各区域独立滚动)是相邻但独立的变更:本变更
  只管"放大/缩小控件归位",不顺带改滚动归属,避免两件事互相纠缠。
