//! `CoreEvent` — Session 层产生的事件,由 UI 层(TUI 或 GUI)按需包成自己的 Action。
//!
//! Session/PTY/jsonl_tail 把所有外部可观测的状态变化都通过这个枚举发出,
//! UI 层订阅 `mpsc::UnboundedReceiver<CoreEvent>` 即可。

use crate::session::SessionId;

#[derive(Debug, Clone)]
pub enum CoreEvent {
    /// PTY 子进程产生的字节流。**高频**,UI 层在自己的渲染层做合并/节流。
    PtyBytes { id: SessionId, bytes: Vec<u8> },
    /// PTY 子进程退出,带退出码。
    PtyExited { id: SessionId, code: Option<i32> },
    /// codebuddy session jsonl 解析出的元数据增量。任意字段可能为 None。
    JsonlMeta {
        id: SessionId,
        model: Option<String>,
        title: Option<String>,
        /// 子进程真实 session uuid。codebuddy `/clear` 会切到新 jsonl/session,
        /// 这里把新 uuid 带回 UI,避免持久化仍指向旧会话。
        session_uuid: Option<String>,
        /// 是否清空已有 token/context/cost 展示。/clear 和 /model 会触发。
        tokens_reset: bool,
        /// reset 后累计总 tokens(input + output)。
        tokens: Option<u64>,
        /// reset 后累计 input tokens。
        input_tokens: Option<u64>,
        /// reset 后累计 output tokens。
        output_tokens: Option<u64>,
        /// reset 后累计 cached(prompt cache hit)tokens。已包含在 input_tokens 里。
        cached_tokens: Option<u64>,
        /// 价格估算。当前不计算,保留字段兼容 UI/remote 协议。
        cost_usd: Option<f64>,
        /// 最新一次请求的 context 窗口占用百分比(0.0-100.0),由 jsonl_tail 算好。
        context_pct: Option<f32>,
    },
    /// 远端 transport 透传的任意 BridgeBus 事件
    /// (session.status / session.created / ask_user_question / plan_proposed /
    /// session.attention_cleared / session.mode_changed / session.focus_requested 等)。
    ///
    /// 由 `RemoteTransport::handle_envelope` 发出;
    /// `spawn_event_router` 原样转成 `EventEnvelope` 发给 `BridgeBus`,
    /// 下游 `spawn_attention_forwarder` 已有的所有 case 自动生效。
    BusEvent {
        id: SessionId,
        event_type: String,
        payload: serde_json::Value,
    },
}
