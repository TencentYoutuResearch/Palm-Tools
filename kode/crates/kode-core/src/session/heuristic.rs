//! 启发式 busy/idle 判定:N 毫秒内有新字节认为 busy,否则 idle。
//! 由 App 主循环周期性调用 `tick()` 来驱动状态更新。

use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy)]
pub struct BusyHeuristic {
    last_byte_at: Option<Instant>,
    threshold: Duration,
}

impl BusyHeuristic {
    pub fn new(threshold: Duration) -> Self {
        Self {
            last_byte_at: None,
            threshold,
        }
    }

    pub fn touch(&mut self) {
        self.last_byte_at = Some(Instant::now());
    }

    /// 返回当前是否 busy
    pub fn is_busy(&self) -> bool {
        match self.last_byte_at {
            Some(t) => t.elapsed() < self.threshold,
            None => false,
        }
    }

    /// 距离下次需要可能状态翻转的时间(用于驱动主循环 tick)
    pub fn next_tick_in(&self) -> Option<Duration> {
        let t = self.last_byte_at?;
        let elapsed = t.elapsed();
        if elapsed >= self.threshold {
            None
        } else {
            Some(self.threshold - elapsed)
        }
    }
}
