//! SessionState:tab 状态栏所需的元信息。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Starting,
    Idle,
    Busy,
    Exited(Option<i32>),
}

impl Status {
    pub fn label(&self) -> &'static str {
        match self {
            Status::Starting => "start",
            Status::Idle => "idle",
            Status::Busy => "busy",
            Status::Exited(_) => "exit",
        }
    }

    /// 状态栏前面那个圆点的颜色样式
    pub fn dot(&self) -> &'static str {
        match self {
            Status::Starting => "○",
            Status::Idle => "●",
            Status::Busy => "●",
            Status::Exited(_) => "✕",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SessionState {
    pub status: Status,
    /// 后端推断的 model;从 jsonl 解析后会被覆盖为真实值
    pub model: String,
    /// 用户可见的 tab title(默认 "tab N · cmd",可被 Ctrl-b , 重命名或 jsonl 的 ai-title 覆盖)
    pub title: String,
    /// 用户是否手动重命名过(若手动改过,jsonl 的 ai-title 不再覆盖)
    pub title_pinned: bool,
    /// 切走后是否有新输出
    pub unread: bool,
    /// 当前 session 累计 token(input + output)。
    pub tokens: Option<u64>,
    /// 细分 token 统计(来自 jsonl providerData.usage)
    pub tokens_input: Option<u64>,
    pub tokens_output: Option<u64>,
    pub tokens_cached: Option<u64>,
    /// 估算 cost(MVP 暂不计算,显示 None)
    pub cost_usd: Option<f64>,
}

impl SessionState {
    pub fn new(title: impl Into<String>, model: impl Into<String>) -> Self {
        Self {
            status: Status::Starting,
            model: model.into(),
            title: title.into(),
            title_pinned: false,
            unread: false,
            tokens: None,
            tokens_input: None,
            tokens_output: None,
            tokens_cached: None,
            cost_usd: None,
        }
    }
}
