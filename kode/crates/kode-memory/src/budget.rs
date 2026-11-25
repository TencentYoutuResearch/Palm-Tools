//! 能量预算账本:防 agent 提议泛滥让用户疲劳。
//!
//! 设计参考 `.specops/specs/memory-design.md` §3.2（2026-11 调优）:
//! - 上限 15 点（多 tab 共享同一 author 或高频开发期不易误触上限）
//! - propose 消耗 1 点（挂起期间占用配额，防单轮刷屏）
//! - approve / edit-then-approve 全额退还 1 点（高质量提议净消耗为 0，不再误伤好 agent）
//! - reject 额外 -0.5（总 -1.5）
//! - blacklist 额外 -2（总 -3）
//! - 能量不足 1 点时 propose 直接拒绝(out_of_energy)
//! - 6h 完整回血到上限（每 24 分钟恢复 1 点，避免被长时间卡死）
//!
//! 不变量(§8.6):事件驱动,每次变化立即落盘,**不要**批量异步。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_ENERGY: f32 = 15.0;
pub const COST_PROPOSE: f32 = 1.0;
pub const REWARD_APPROVE: f32 = 1.0;
pub const PENALTY_REJECT: f32 = 0.5; // 额外,加上 propose 的 -1 共 -1.5
pub const PENALTY_BLACKLIST: f32 = 2.0; // 额外,加上 propose 的 -1 共 -3
/// 6h 完整回血一次(从 0 → MAX_ENERGY 需要 6 小时，即每 24 分钟恢复 1 点)
pub const REFILL_FULL_SECS: f32 = 6.0 * 3600.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthorBudget {
    pub author: String,
    /// 当前能量(实数,因为 +0.5 的 approve)
    pub energy: f32,
    /// 上次更新的 unix 秒。下次读时根据时间差补血
    pub last_update_ts: u64,
}

impl AuthorBudget {
    fn new(author: &str, now: u64) -> Self {
        Self {
            author: author.to_string(),
            energy: MAX_ENERGY,
            last_update_ts: now,
        }
    }

    /// 把存量能量按时间差补到上限(不超过 MAX_ENERGY)。
    fn refill_to_now(&mut self, now: u64) {
        if now <= self.last_update_ts {
            return;
        }
        let elapsed = (now - self.last_update_ts) as f32;
        let regen = (elapsed / REFILL_FULL_SECS) * MAX_ENERGY;
        self.energy = (self.energy + regen).min(MAX_ENERGY);
        self.last_update_ts = now;
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct BudgetFile {
    authors: HashMap<String, AuthorBudget>,
}

pub struct BudgetStore {
    path: PathBuf,
    file: BudgetFile,
}

impl BudgetStore {
    /// 打开能量账本。优先用 `<root>/.kode/budget.json`(2026-06+ 新布局),
    /// 兼容老 `<root>/budget.json`:如老文件存在且新位置无,则原子搬运。
    /// `MemoryStore::open` 会先把目录结构整出来,所以这里只读+写。
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let new_path = root.join(".kode").join("budget.json");
        let old_path = root.join("budget.json");

        // 兼容:若老布局有 budget.json 而新位置没,迁过去
        if old_path.exists() && !new_path.exists() {
            if let Some(parent) = new_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::rename(&old_path, &new_path).with_context(|| {
                format!(
                    "migrate budget {} -> {}",
                    old_path.display(),
                    new_path.display()
                )
            })?;
        }

        // 确保父目录存在(MemoryStore::open 一般已建好,但允许独立调用)
        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        let file = if new_path.exists() {
            let text = std::fs::read_to_string(&new_path)
                .with_context(|| format!("read {}", new_path.display()))?;
            serde_json::from_str(&text).unwrap_or_default()
        } else {
            BudgetFile::default()
        };
        Ok(Self {
            path: new_path,
            file,
        })
    }

    /// 拿一个 author 的当前能量(已应用回血)。
    pub fn current_energy(&mut self, author: &str) -> f32 {
        let now = now_secs();
        let entry = self
            .file
            .authors
            .entry(author.to_string())
            .or_insert_with(|| AuthorBudget::new(author, now));
        entry.refill_to_now(now);
        entry.energy
    }

    /// 尝试扣费。如果不够,返回 Err 含下次回血到 1 点的预计时间。
    pub fn try_charge(&mut self, author: &str, cost: f32) -> Result<f32, BudgetError> {
        let now = now_secs();
        let entry = self
            .file
            .authors
            .entry(author.to_string())
            .or_insert_with(|| AuthorBudget::new(author, now));
        entry.refill_to_now(now);
        if entry.energy < cost {
            // 算还需多少秒能恢复到 cost
            let needed = cost - entry.energy;
            let secs_until = (needed / MAX_ENERGY * REFILL_FULL_SECS) as u64;
            return Err(BudgetError::OutOfEnergy {
                current: entry.energy,
                needed: cost,
                next_refill_at: now + secs_until,
            });
        }
        entry.energy -= cost;
        entry.last_update_ts = now;
        let remaining = entry.energy;
        self.persist()?;
        Ok(remaining)
    }

    /// 单纯加能量(approve 退还场景)。不会超过 MAX_ENERGY。
    pub fn add(&mut self, author: &str, delta: f32) -> Result<f32> {
        let now = now_secs();
        let entry = self
            .file
            .authors
            .entry(author.to_string())
            .or_insert_with(|| AuthorBudget::new(author, now));
        entry.refill_to_now(now);
        entry.energy = (entry.energy + delta).min(MAX_ENERGY).max(0.0);
        entry.last_update_ts = now;
        let val = entry.energy;
        self.persist()?;
        Ok(val)
    }

    /// 单纯扣能量(reject/blacklist 额外惩罚场景)。可低于 0,但下次取时会用 0。
    pub fn penalize(&mut self, author: &str, delta: f32) -> Result<f32> {
        // delta 是正数,表示扣多少
        let now = now_secs();
        let entry = self
            .file
            .authors
            .entry(author.to_string())
            .or_insert_with(|| AuthorBudget::new(author, now));
        entry.refill_to_now(now);
        entry.energy = (entry.energy - delta).max(0.0);
        entry.last_update_ts = now;
        let val = entry.energy;
        self.persist()?;
        Ok(val)
    }

    /// 列出所有 author 的当前能量(已应用回血)。给 GUI metrics summary 用,
    /// 不写盘 — 仅在内存里把每条 budget 算一次回血。
    /// 返回 (author, energy)。**顺序按 author 字典序**(便于 UI 稳定渲染)。
    pub fn iter_authors(&mut self) -> Vec<(String, f32)> {
        let now = now_secs();
        // 先把所有 entry 补血到 now。这里直接 mut 借,避免 clone。
        for entry in self.file.authors.values_mut() {
            entry.refill_to_now(now);
        }
        let mut out: Vec<(String, f32)> = self
            .file
            .authors
            .iter()
            .map(|(k, v)| (k.clone(), v.energy))
            .collect();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    }

    /// 上限,给 UI 渲染能量条用。
    pub fn max_energy() -> f32 {
        MAX_ENERGY
    }

    fn persist(&self) -> Result<()> {
        // tmp + rename 原子写
        let tmp = self.path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&self.file)?;
        std::fs::write(&tmp, text).with_context(|| format!("write {}", tmp.display()))?;
        std::fs::rename(&tmp, &self.path).context("rename budget.json")?;
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum BudgetError {
    #[error("out of energy: have {current:.2}, need {needed:.2}, refill at unix {next_refill_at}")]
    OutOfEnergy {
        current: f32,
        needed: f32,
        next_refill_at: u64,
    },
    #[error("budget io: {0}")]
    Io(#[from] anyhow::Error),
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn fresh_author_starts_full() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        assert_eq!(b.current_energy("codebuddy"), MAX_ENERGY);
    }

    #[test]
    fn try_charge_then_drain() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        let cap = MAX_ENERGY as usize;
        for _ in 0..cap {
            b.try_charge("a", COST_PROPOSE).unwrap();
        }
        // 打空后的下一次应该失败
        let err = b.try_charge("a", COST_PROPOSE).unwrap_err();
        match err {
            BudgetError::OutOfEnergy { current, .. } => assert!(current < COST_PROPOSE),
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn approve_refunds_full_propose_cost() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", COST_PROPOSE).unwrap();
        b.add("a", REWARD_APPROVE).unwrap();
        assert!((b.current_energy("a") - MAX_ENERGY).abs() < 1e-3);
    }

    #[test]
    fn reject_applies_extra_penalty() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", COST_PROPOSE).unwrap();
        b.penalize("a", PENALTY_REJECT).unwrap();
        let expected = MAX_ENERGY - COST_PROPOSE - PENALTY_REJECT;
        assert!((b.current_energy("a") - expected).abs() < 1e-3);
    }

    #[test]
    fn blacklist_applies_heavy_penalty() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", COST_PROPOSE).unwrap();
        b.penalize("a", PENALTY_BLACKLIST).unwrap();
        let expected = MAX_ENERGY - COST_PROPOSE - PENALTY_BLACKLIST;
        assert!((b.current_energy("a") - expected).abs() < 1e-3);
    }

    #[test]
    fn refill_over_time() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        // 把能量打到 0
        for _ in 0..(MAX_ENERGY as usize) {
            b.try_charge("a", COST_PROPOSE).unwrap();
        }
        // 手工把 last_update_ts 往回拨半个回血周期,应该回血一半
        let now = now_secs();
        let half_secs = (REFILL_FULL_SECS / 2.0) as u64;
        b.file.authors.get_mut("a").unwrap().last_update_ts = now - half_secs;
        let e = b.current_energy("a");
        assert!(
            (e - MAX_ENERGY / 2.0).abs() < 0.1,
            "expected ~{} after {}s, got {}",
            MAX_ENERGY / 2.0,
            half_secs,
            e
        );
    }

    #[test]
    fn persist_across_open() {
        let tmp = TempDir::new().unwrap();
        {
            let mut b = BudgetStore::open(tmp.path()).unwrap();
            b.try_charge("alice", 2.0).unwrap();
        }
        let mut b2 = BudgetStore::open(tmp.path()).unwrap();
        // 重新打开,因时间差极短,energy 应仍约 MAX_ENERGY - 2.0
        let e = b2.current_energy("alice");
        let expected = MAX_ENERGY - 2.0;
        assert!(
            (e - expected).abs() < 0.01,
            "expected ~{} persisted, got {}",
            expected,
            e
        );
    }

    #[test]
    fn iter_authors_returns_sorted_with_refilled_energy() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("zebra", 1.0).unwrap();
        b.try_charge("alpha", 2.0).unwrap();
        b.try_charge("middle", 1.5).unwrap();

        let listed = b.iter_authors();
        assert_eq!(listed.len(), 3);
        // 字典序
        assert_eq!(listed[0].0, "alpha");
        assert_eq!(listed[1].0, "middle");
        assert_eq!(listed[2].0, "zebra");
        // 能量值近似(允许微小回血)
        assert!((listed[0].1 - (MAX_ENERGY - 2.0)).abs() < 0.01);
        assert!((listed[1].1 - (MAX_ENERGY - 1.5)).abs() < 0.01);
        assert!((listed[2].1 - (MAX_ENERGY - 1.0)).abs() < 0.01);
    }
}
