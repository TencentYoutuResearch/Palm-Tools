//! App:全局状态机 + 主循环。

use std::time::Duration;

use anyhow::Result;
use crossterm::event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, MouseEvent};
use futures::StreamExt;
use ratatui::Terminal;
use tokio::sync::mpsc;

use crate::action::Action;
use crate::input::{encode_mouse_sgr, handle_mouse};
use crate::keymap::{handle_key, Handled, Mode};
use crate::ui;
use kode_core::config::Config;
use kode_core::session::{Session, SessionId};
use kode_core::CoreEvent;

/// 侧栏三态:Full(完整,默认 24 列)→ Compact(简略,8 列,只显示序号+状态点+短标题)→ Hidden(隐藏)
/// 用户按 C-b b 在三态间循环。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarMode {
    Full,
    Compact,
    Hidden,
}

impl SidebarMode {
    /// 循环顺序:Full → Compact → Hidden → Full。
    /// 配合用户原话「简略模式 → 隐藏 → 全部展开」。
    pub fn cycle(self) -> Self {
        match self {
            SidebarMode::Full => SidebarMode::Compact,
            SidebarMode::Compact => SidebarMode::Hidden,
            SidebarMode::Hidden => SidebarMode::Full,
        }
    }

    pub fn is_hidden(self) -> bool {
        matches!(self, SidebarMode::Hidden)
    }

    /// 给定 Full 模式下的宽度,返回当前模式实际占用的列数。
    /// Compact 模式固定 8 列(序号 2 + 空 1 + 状态点 1 + 空 1 + 标题前 2 字符 + 边框 1)
    pub fn width(self, full_width: u16) -> u16 {
        match self {
            SidebarMode::Full => full_width,
            SidebarMode::Compact => 8,
            SidebarMode::Hidden => 0,
        }
    }
}

pub struct App {
    pub config: Config,
    pub tabs: Vec<Session>,
    pub active: usize,
    pub mode: Mode,
    /// 侧栏显示模式(Full / Compact / Hidden 三态循环)
    pub sidebar: SidebarMode,
    pub show_help: bool,
    pub should_quit: bool,
    pub last_size: (u16, u16),
    next_id: SessionId,
    evt_tx: mpsc::UnboundedSender<Action>,
    evt_rx: mpsc::UnboundedReceiver<Action>,
    /// 给 kode-core(PTY/jsonl_tail)用的通道。
    /// 后台桥接 task 把 CoreEvent 转 Action 灌进 evt_tx。
    core_tx: mpsc::UnboundedSender<CoreEvent>,
}

impl App {
    pub fn new(config: Config) -> Self {
        let (evt_tx, evt_rx) = mpsc::unbounded_channel::<Action>();
        let (core_tx, mut core_rx) = mpsc::unbounded_channel::<CoreEvent>();
        // 桥接:core 事件 → Action,投到 UI 主循环
        let bridge_tx = evt_tx.clone();
        tokio::spawn(async move {
            while let Some(ev) = core_rx.recv().await {
                if bridge_tx.send(Action::from(ev)).is_err() {
                    break;
                }
            }
        });
        Self {
            sidebar: if config.ui.sidebar_default_visible {
                SidebarMode::Full
            } else {
                SidebarMode::Hidden
            },
            config,
            tabs: Vec::new(),
            active: 0,
            mode: Mode::Normal,
            show_help: false,
            should_quit: false,
            last_size: (80, 24),
            next_id: 1,
            evt_tx,
            evt_rx,
            core_tx,
        }
    }

    pub fn evt_tx(&self) -> mpsc::UnboundedSender<Action> {
        self.evt_tx.clone()
    }

    /// 主循环:select 三路输入(crossterm event / app evt_rx / 周期性 tick)
    pub async fn run<B: ratatui::backend::Backend>(
        mut self,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        // 初始尺寸
        let area = terminal.size()?;
        self.last_size = (area.width, area.height);

        // 默认开 1 个 tab
        let backend_key = self.config.default_backend.clone();
        if let Err(e) = self.spawn_tab(&backend_key) {
            tracing::error!(?e, "failed to spawn initial tab");
        }

        let mut events = EventStream::new();
        let frame_period = Duration::from_millis(1000 / self.config.ui.fps_cap.max(1) as u64);
        let mut tick = tokio::time::interval(frame_period);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        // 状态翻转 tick(用于 idle 启发式;独立的更慢的频率)
        let mut status_tick = tokio::time::interval(Duration::from_millis(100));
        status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

        loop {
            tokio::select! {
                biased;

                // 1) 终端输入事件
                Some(Ok(ev)) = events.next() => {
                    self.handle_term_event(ev, terminal)?;
                }

                // 2) 内部 Action(包含 PTY bytes、PtyExited 等)
                Some(action) = self.evt_rx.recv() => {
                    self.dispatch(action, terminal)?;
                    // batch:把同一帧内累积的所有 PTY bytes 一次取完,避免 backlog
                    while let Ok(more) = self.evt_rx.try_recv() {
                        self.dispatch(more, terminal)?;
                    }
                }

                // 3) 周期性 tick:渲染节流 + 状态翻转
                _ = tick.tick() => {
                    terminal.draw(|f| ui::draw(f, &self))?;
                }

                _ = status_tick.tick() => {
                    for s in &mut self.tabs {
                        s.tick_status();
                    }
                }
            }

            if self.should_quit {
                break;
            }

            if self.tabs.is_empty() {
                // 所有 tab 关掉了 → 退出
                break;
            }
        }

        // 退出时优雅 kill 所有子进程(Drop 会兜底)
        for s in &self.tabs {
            if let Some(p) = &s.pty {
                p.kill();
            }
        }
        Ok(())
    }

    fn handle_term_event<B: ratatui::backend::Backend>(
        &mut self,
        ev: Event,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        match ev {
            Event::Key(k) => self.handle_key_event(k, terminal),
            Event::Resize(w, h) => {
                self.last_size = (w, h);
                self.relayout(terminal)?;
                Ok(())
            }
            Event::Mouse(m) => self.handle_mouse_event(m, terminal),
            Event::Paste(text) => {
                if let Some(s) = self.tabs.get(self.active) {
                    s.write_input(text.as_bytes());
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }

    fn handle_key_event<B: ratatui::backend::Backend>(
        &mut self,
        key: KeyEvent,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        if matches!(key.kind, KeyEventKind::Release) {
            return Ok(());
        }

        // help overlay 优先吃任何键(关闭它)
        if self.show_help {
            // 只用 Esc / C-b ? 关闭;其他键忽略避免误透传
            if matches!(key.code, KeyCode::Esc) {
                self.show_help = false;
                return Ok(());
            }
            // C-b ? 在 prefix 下也走 keymap;先简单允许 C-b 进入 prefix
        }

        // Rename 模式特殊处理(Enter 完成时要把 buf 写入 active session)
        if let Mode::Rename { buf } = &self.mode {
            match key.code {
                KeyCode::Enter => {
                    let new_title = buf.trim().to_string();
                    if !new_title.is_empty() {
                        if let Some(s) = self.tabs.get_mut(self.active) {
                            s.state.title = new_title;
                            s.state.title_pinned = true;
                        }
                    }
                    self.mode = Mode::Normal;
                    return Ok(());
                }
                KeyCode::Esc => {
                    self.mode = Mode::Normal;
                    return Ok(());
                }
                KeyCode::Backspace => {
                    let mut new_buf = buf.clone();
                    new_buf.pop();
                    self.mode = Mode::Rename { buf: new_buf };
                    return Ok(());
                }
                KeyCode::Char(c) => {
                    let mut new_buf = buf.clone();
                    new_buf.push(c);
                    self.mode = Mode::Rename { buf: new_buf };
                    return Ok(());
                }
                _ => return Ok(()),
            }
        }

        let default_backend = self.config.default_backend.clone();
        match handle_key(&mut self.mode, key, &default_backend) {
            Handled::None => {}
            Handled::Action(a) => self.execute(a, terminal)?,
            Handled::Multi(actions) => {
                for a in actions {
                    self.execute(a, terminal)?;
                }
            }
        }
        Ok(())
    }

    fn handle_mouse_event<B: ratatui::backend::Backend>(
        &mut self,
        m: MouseEvent,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        let (w, h) = self.last_size;
        let area = ratatui::layout::Rect::new(0, 0, w, h);
        let pty_area = ui::pty_area(area, self.config.ui.sidebar_width, self.sidebar);
        let sidebar_w = self.sidebar.width(self.config.ui.sidebar_width);
        let sidebar_area = if sidebar_w == 0 {
            None
        } else {
            // 顶部一行不留,直接 sidebar_w 列
            let main_top_h = h.saturating_sub(1);
            Some(ratatui::layout::Rect::new(0, 0, sidebar_w, main_top_h))
        };

        // 滚轮落在 PTY 区时,优先用于翻 scrollback —— 自动进入 Scroll 模式。
        // 这样用户不必先按 C-b [ 也能滚历史。子 TUI 自己用滚轮的场景被牺牲,
        // 因为 codebuddy/claude 的 readline-style 输入不依赖滚轮。
        let in_pty = m.column >= pty_area.x
            && m.column < pty_area.x + pty_area.width
            && m.row >= pty_area.y
            && m.row < pty_area.y + pty_area.height;
        if in_pty {
            match m.kind {
                crossterm::event::MouseEventKind::ScrollUp => {
                    if matches!(self.mode, Mode::Normal) {
                        self.mode = Mode::Scroll;
                    }
                    if matches!(self.mode, Mode::Scroll) {
                        return self.execute(Action::ScrollUpLines(3), terminal);
                    }
                }
                crossterm::event::MouseEventKind::ScrollDown => {
                    if matches!(self.mode, Mode::Scroll) {
                        // 滚到底自动退出 Scroll 模式
                        if let Some(s) = self.tabs.get(self.active) {
                            if s.scrollback_offset() <= 3 {
                                self.mode = Mode::Normal;
                                return self.execute(Action::ExitScrollMode, terminal);
                            }
                        }
                        return self.execute(Action::ScrollDownLines(3), terminal);
                    }
                    // Normal 模式下忽略向下滚(没历史可看,且不要污染 PTY)
                    return Ok(());
                }
                _ => {}
            }
        }

        if let Some(action) = handle_mouse(m, pty_area, sidebar_area, self.tabs.len()) {
            self.execute(action, terminal)?;
        }
        Ok(())
    }

    fn dispatch<B: ratatui::backend::Backend>(
        &mut self,
        action: Action,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        self.execute(action, terminal)
    }

    fn execute<B: ratatui::backend::Backend>(
        &mut self,
        action: Action,
        terminal: &mut Terminal<B>,
    ) -> Result<()> {
        match action {
            Action::Quit => {
                self.should_quit = true;
            }
            Action::NewTab(backend_key) => {
                if let Err(e) = self.spawn_tab(&backend_key) {
                    tracing::warn!(?e, %backend_key, "spawn_tab failed");
                }
            }
            Action::CloseActiveTab => {
                self.close_tab(self.active);
            }
            Action::CloseTab(id) => {
                if let Some(idx) = self.tabs.iter().position(|s| s.id == id) {
                    self.close_tab(idx);
                }
            }
            Action::NextTab => {
                if !self.tabs.is_empty() {
                    self.active = (self.active + 1) % self.tabs.len();
                    self.on_active_change();
                }
            }
            Action::PrevTab => {
                if !self.tabs.is_empty() {
                    self.active = if self.active == 0 {
                        self.tabs.len() - 1
                    } else {
                        self.active - 1
                    };
                    self.on_active_change();
                }
            }
            Action::GotoTab(n) => {
                let idx = n.saturating_sub(1);
                if idx < self.tabs.len() {
                    self.active = idx;
                    self.on_active_change();
                }
            }
            Action::ToggleZoom => {
                // 兼容旧名:在三态间循环。
                self.sidebar = self.sidebar.cycle();
                self.relayout(terminal)?;
            }
            Action::CycleSidebar => {
                self.sidebar = self.sidebar.cycle();
                self.relayout(terminal)?;
            }
            Action::ToggleHelp => {
                self.show_help = !self.show_help;
            }
            Action::BeginRename => {
                let cur = self
                    .tabs
                    .get(self.active)
                    .map(|s| s.state.title.clone())
                    .unwrap_or_default();
                self.mode = Mode::Rename { buf: cur };
            }
            Action::RestartActiveTab => {
                let idx = self.active;
                if let Some(s) = self.tabs.get(idx) {
                    if !s.is_running() {
                        let backend = s.backend_key.clone();
                        // 先移除旧的,再 spawn 同一位置一个新的
                        self.tabs.remove(idx);
                        if let Err(e) = self.spawn_tab_at(&backend, idx) {
                            tracing::warn!(?e, "restart failed");
                        }
                    }
                }
            }
            Action::PassthroughBytes(bytes) => {
                if let Some(s) = self.tabs.get(self.active) {
                    s.write_input(&bytes);
                }
            }
            Action::PassthroughMouse {
                col,
                row,
                kind,
                modifiers,
            } => {
                if let Some(bytes) = encode_mouse_sgr(col, row, kind, modifiers) {
                    if let Some(s) = self.tabs.get(self.active) {
                        s.write_input(&bytes);
                    }
                }
            }
            Action::Resize { cols, rows } => {
                self.last_size = (cols, rows);
                self.relayout(terminal)?;
            }
            Action::PtyBytes { id, bytes } => {
                let active_id = self.tabs.get(self.active).map(|s| s.id);
                if let Some(s) = self.tabs.iter_mut().find(|s| s.id == id) {
                    let is_active = Some(id) == active_id;
                    s.feed(&bytes, is_active);
                }
            }
            Action::PtyExited { id, code } => {
                if let Some(s) = self.tabs.iter_mut().find(|s| s.id == id) {
                    s.mark_exited(code);
                }
            }
            Action::JsonlMeta {
                id,
                model,
                title,
                tokens_reset,
                tokens,
                cost_usd,
            } => {
                if let Some(s) = self.tabs.iter_mut().find(|s| s.id == id) {
                    if tokens_reset {
                        s.state.tokens = None;
                        s.state.cost_usd = None;
                    }
                    if let Some(m) = model {
                        s.state.model = m;
                    }
                    if let Some(t) = title {
                        // 用户手动重命名过就不再覆盖
                        if !s.state.title_pinned {
                            s.state.title = t;
                        }
                    }
                    if let Some(tok) = tokens {
                        s.state.tokens = Some(tok);
                    }
                    if let Some(c) = cost_usd {
                        s.state.cost_usd = Some(c);
                    }
                }
            }
            Action::Redraw => {}
            Action::EnterScrollMode => {
                // 进入翻看模式时不立即移动 scrollback,让用户看到当前画面
                // 之后按键再翻
            }
            Action::ExitScrollMode => {
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_end();
                }
            }
            Action::ScrollUpLines(n) => {
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_up(n);
                }
            }
            Action::ScrollDownLines(n) => {
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_down(n);
                }
            }
            Action::ScrollPageUp => {
                let page = self.last_size.1.saturating_sub(2).max(1) as usize;
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_up(page);
                }
            }
            Action::ScrollPageDown => {
                let page = self.last_size.1.saturating_sub(2).max(1) as usize;
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_down(page);
                }
            }
            Action::ScrollHome => {
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_home();
                }
            }
            Action::ScrollEnd => {
                if let Some(s) = self.tabs.get_mut(self.active) {
                    s.scroll_end();
                }
            }
        }
        Ok(())
    }

    fn spawn_tab(&mut self, backend_key: &str) -> Result<()> {
        let idx = self.tabs.len();
        self.spawn_tab_at(backend_key, idx)
    }

    fn spawn_tab_at(&mut self, backend_key: &str, idx: usize) -> Result<()> {
        let backend = self
            .config
            .backend(backend_key)
            .ok_or_else(|| anyhow::anyhow!("backend not configured: {backend_key}"))?
            .clone();
        let (cols, rows) = self.compute_pty_size();
        let id = self.next_id;
        self.next_id += 1;
        // TUI:沿用进程 cwd —— 用户从命令行起 kode-tui,cwd 通常正是想要的项目目录。
        // GUI 侧不能这样(双击 .app / ./run.sh dev cwd 不对),那边走自己的 resolve 逻辑。
        let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("/"));
        let session = Session::new(
            id,
            backend_key,
            &backend,
            cols,
            rows,
            Duration::from_millis(self.config.ui.idle_threshold_ms),
            self.config.ui.scrollback_lines,
            &cwd,
            self.core_tx.clone(),
            None, // TUI 暂不支持 --resume
            None, // TUI 暂不暴露 permission_mode 选择(走 backend 默认)
            None, // TUI 暂不暴露 model 选择(走 backend.default_model)
            true, // TUI 也注入 kode-memory prompt 段(行为与 GUI 默认一致)
            None, // TUI 不预查 memory context(只注入 prompt,不注入 facts)
            &[],  // TUI 没有 HookRelay,不注入 KODE_HOOK_SOCK
            None, // TUI 不用 initial_prompt(用户交互输入)
        )?;
        let idx = idx.min(self.tabs.len());
        self.tabs.insert(idx, session);
        self.active = idx;
        self.on_active_change();
        Ok(())
    }

    fn close_tab(&mut self, idx: usize) {
        if idx >= self.tabs.len() {
            return;
        }
        let s = self.tabs.remove(idx);
        if let Some(p) = &s.pty {
            p.kill();
        }
        // Drop 自动清理
        if self.tabs.is_empty() {
            self.active = 0;
        } else if self.active >= self.tabs.len() {
            self.active = self.tabs.len() - 1;
        }
        self.on_active_change();
    }

    fn on_active_change(&mut self) {
        if let Some(s) = self.tabs.get_mut(self.active) {
            s.state.unread = false;
        }
    }

    /// 终端尺寸或 sidebar 模式变化时,重算每个 session 的 PTY 尺寸并 resize
    fn relayout<B: ratatui::backend::Backend>(
        &mut self,
        _terminal: &mut Terminal<B>,
    ) -> Result<()> {
        let (cols, rows) = self.compute_pty_size();
        for s in &mut self.tabs {
            s.resize(cols, rows);
        }
        Ok(())
    }

    fn compute_pty_size(&self) -> (u16, u16) {
        let (w, h) = self.last_size;
        // 减去底部状态栏 1 行
        let main_h = h.saturating_sub(1);
        let sidebar_w = self.sidebar.width(self.config.ui.sidebar_width);
        let pty_w = w.saturating_sub(sidebar_w);
        (pty_w.max(2), main_h.max(2))
    }
}
