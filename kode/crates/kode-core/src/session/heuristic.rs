//! busy/idle 判定。
//!
//! 两层信号:
//! - PTY 字节:N 毫秒内有新输出 → `is_pty_busy`(给 prompt scan 用,屏幕还在刷)
//! - turn hold:用户提交 / 工具开始之后,一直锁 busy,直到 Stop / turn_finished
//!
//! Cursor 等 agent 在思考或跑工具时 PTY 经常完全静止。只看字节会在
//! running/idle 之间来回跳;turn hold 把"这一轮还没结束"钉住。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug)]
pub struct BusyHeuristic {
    last_byte_at: Option<Instant>,
    threshold: Duration,
    turn_hold: AtomicBool,
}

impl Clone for BusyHeuristic {
    fn clone(&self) -> Self {
        Self {
            last_byte_at: self.last_byte_at,
            threshold: self.threshold,
            turn_hold: AtomicBool::new(self.turn_hold.load(Ordering::Relaxed)),
        }
    }
}

impl BusyHeuristic {
    pub fn new(threshold: Duration) -> Self {
        Self {
            last_byte_at: None,
            threshold,
            turn_hold: AtomicBool::new(false),
        }
    }

    pub fn touch(&mut self) {
        self.last_byte_at = Some(Instant::now());
    }

    /// 本轮 agent 还在跑(提交 prompt / PreToolUse)。PTY 静默时也保持 busy。
    pub fn hold_turn(&self) {
        self.turn_hold.store(true, Ordering::Relaxed);
    }

    /// Stop / turn_finished:允许下一拍 tick 翻 idle。
    pub fn release_turn(&self) {
        self.turn_hold.store(false, Ordering::Relaxed);
    }

    pub fn is_turn_held(&self) -> bool {
        self.turn_hold.load(Ordering::Relaxed)
    }

    /// 最近有没有 PTY 输出。prompt scan 必须用这个,不能用 [`is_busy`]:
    /// turn hold 期间屏幕往往是静止的,但仍要能扫到 approval prompt。
    pub fn is_pty_busy(&self) -> bool {
        match self.last_byte_at {
            Some(t) => t.elapsed() < self.threshold,
            None => false,
        }
    }

    /// UI 状态:turn hold 或 PTY 仍在刷。
    pub fn is_busy(&self) -> bool {
        self.is_turn_held() || self.is_pty_busy()
    }

    /// 距离下次需要可能状态翻转的时间(用于驱动主循环 tick)
    pub fn next_tick_in(&self) -> Option<Duration> {
        if self.is_turn_held() {
            return None;
        }
        let t = self.last_byte_at?;
        let elapsed = t.elapsed();
        if elapsed >= self.threshold {
            None
        } else {
            Some(self.threshold - elapsed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread;

    #[test]
    fn pty_silence_is_idle_without_hold() {
        let mut h = BusyHeuristic::new(Duration::from_millis(30));
        assert!(!h.is_busy());
        h.touch();
        assert!(h.is_pty_busy());
        assert!(h.is_busy());
        thread::sleep(Duration::from_millis(40));
        assert!(!h.is_pty_busy());
        assert!(!h.is_busy());
    }

    #[test]
    fn turn_hold_keeps_busy_after_pty_silence() {
        let mut h = BusyHeuristic::new(Duration::from_millis(20));
        h.touch();
        h.hold_turn();
        thread::sleep(Duration::from_millis(30));
        assert!(!h.is_pty_busy());
        assert!(h.is_busy());
        h.release_turn();
        assert!(!h.is_busy());
    }
}
