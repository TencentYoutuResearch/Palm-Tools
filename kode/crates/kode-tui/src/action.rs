//! Action 枚举:键盘输入和事件最终都映射到 Action,由 App 统一处理。
//!
//! 在 v0.2 monorepo 化后,PTY/jsonl 层只产 `kode_core::CoreEvent`;
//! TUI 主循环把 CoreEvent `From` 包成 Action 即可(见 `From<CoreEvent> for Action`)。

use kode_core::{CoreEvent, SessionId};

#[derive(Debug, Clone)]
pub enum Action {
    /// 退出整个 kode
    Quit,

    /// 新建 tab(指定后端 key,如 "codebuddy" / "claude")
    NewTab(String),

    /// 关闭当前 active tab(若 tab 非空,先弹确认;空 tab 直接关)
    CloseActiveTab,

    /// 关闭指定 tab
    CloseTab(SessionId),

    /// 切到下一个 tab
    NextTab,

    /// 切到上一个 tab
    PrevTab,

    /// 跳到第 N 个(1-based for keymap 0..9,内部转 0-based)
    GotoTab(usize),

    /// 切换 zoom(侧栏可见性,旧版二态;现转发到三态循环)
    ToggleZoom,

    /// 循环切换侧栏显示模式 Full → Compact → Hidden → Full(C-b b)
    CycleSidebar,

    /// 弹出帮助 overlay
    ToggleHelp,

    /// 进入重命名模式
    BeginRename,

    /// 重启已退出的 active tab
    RestartActiveTab,

    /// 直通字节给 active tab 的 PTY
    PassthroughBytes(Vec<u8>),

    /// 直通鼠标事件(已转换坐标)
    PassthroughMouse {
        /// 已经相对 PTY 区的坐标
        col: u16,
        row: u16,
        kind: crossterm::event::MouseEventKind,
        modifiers: crossterm::event::KeyModifiers,
    },

    /// 终端尺寸变化
    Resize { cols: u16, rows: u16 },

    /// 来自 PTY reader 的字节数据
    PtyBytes { id: SessionId, bytes: Vec<u8> },

    /// PTY 子进程退出
    PtyExited { id: SessionId, code: Option<i32> },

    /// 从 codebuddy session jsonl 解析出的元数据更新
    JsonlMeta {
        id: SessionId,
        model: Option<String>,
        title: Option<String>,
        tokens_reset: bool,
        tokens: Option<u64>,
        cost_usd: Option<f64>,
    },

    /// 触发一次重绘(脏标记)
    Redraw,

    /// 进入 scrollback 翻看模式(状态栏会变色)
    EnterScrollMode,
    /// 退出 scrollback 模式,回到实时屏幕
    ExitScrollMode,
    /// 向上翻 N 行(看更早历史)
    ScrollUpLines(usize),
    /// 向下翻 N 行(回到当前)
    ScrollDownLines(usize),
    /// 向上翻一页
    ScrollPageUp,
    /// 向下翻一页
    ScrollPageDown,
    /// 跳到 scrollback 顶端
    ScrollHome,
    /// 回到实时屏幕(scrollback=0)
    ScrollEnd,
}

impl From<CoreEvent> for Action {
    fn from(ev: CoreEvent) -> Self {
        match ev {
            CoreEvent::PtyBytes { id, bytes } => Action::PtyBytes { id, bytes },
            CoreEvent::PtyExited { id, code } => Action::PtyExited { id, code },
            CoreEvent::JsonlMeta {
                id,
                model,
                title,
                tokens_reset,
                tokens,
                cost_usd,
                // TUI 不展示 session_uuid/input/output/cached/context_pct,直接丢
                session_uuid: _,
                input_tokens: _,
                output_tokens: _,
                cached_tokens: _,
                context_pct: _,
            } => Action::JsonlMeta {
                id,
                model,
                title,
                tokens_reset,
                tokens,
                cost_usd,
            },
            // TUI 不处理远端 bus 事件,静默忽略
            CoreEvent::BusEvent { .. } | CoreEvent::TurnHold { .. } => Action::Redraw,
        }
    }
}
