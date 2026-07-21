//! 能量预算账本:防 agent 提议泛滥让用户疲劳。
//!
//! 设计参考 `.specops/specs/memory-design.md` §3.2:
//! - propose 消耗 1 点
//! - approve 退还 0.5 点(奖励高质量)
//! - edit-then-approve 中性(不退不扣)
//! - reject 额外 -1(总 -2)
//! - blacklist 额外 -2(总 -3)
//! - 0 点时 propose 直接拒绝(out_of_energy)
//! - 24h 缓慢回血到上限(避免永久封禁)
//!
//! 不变量(§8.6):事件驱动,每次变化立即落盘,**不要**批量异步。

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_ENERGY: f32 = 5.0;
pub const COST_PROPOSE: f32 = 1.0;
pub const REWARD_APPROVE: f32 = 0.5;
pub const PENALTY_REJECT: f32 = 1.0; // 额外,加上 propose 的 -1 共 -2
pub const PENALTY_BLACKLIST: f32 = 2.0; // 额外,加上 propose 的 -1 共 -3
/// 24h 完整回血一次(从 0 → MAX_ENERGY 需要 24 小时)
const REFILL_FULL_SECS: f32 = 24.0 * 3600.0;

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
        for _ in 0..5 {
            b.try_charge("a", 1.0).unwrap();
        }
        // 第 6 次应该失败
        let err = b.try_charge("a", 1.0).unwrap_err();
        match err {
            BudgetError::OutOfEnergy { current, .. } => assert!(current < 1.0),
            other => panic!("unexpected: {:?}", other),
        }
    }

    #[test]
    fn approve_refunds_partial() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", 1.0).unwrap(); // 5 → 4
        b.add("a", REWARD_APPROVE).unwrap(); // 4 → 4.5
        assert!((b.current_energy("a") - 4.5).abs() < 1e-3);
    }

    #[test]
    fn reject_total_minus_two() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", COST_PROPOSE).unwrap(); // -1 → 4
        b.penalize("a", PENALTY_REJECT).unwrap(); // -1 额外 → 3
        assert!((b.current_energy("a") - 3.0).abs() < 1e-3);
    }

    #[test]
    fn blacklist_total_minus_three() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("a", COST_PROPOSE).unwrap(); // -1 → 4
        b.penalize("a", PENALTY_BLACKLIST).unwrap(); // -2 额外 → 2
        assert!((b.current_energy("a") - 2.0).abs() < 1e-3);
    }

    #[test]
    fn refill_over_time() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        // 把能量打到 0
        for _ in 0..5 {
            b.try_charge("a", 1.0).unwrap();
        }
        // 手工把 last_update_ts 往回拨 12 小时,应该回血一半
        let now = now_secs();
        b.file.authors.get_mut("a").unwrap().last_update_ts = now - 12 * 3600;
        let e = b.current_energy("a");
        assert!(
            (e - MAX_ENERGY / 2.0).abs() < 0.1,
            "expected ~2.5 after 12h, got {}",
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
        // 重新打开,因时间差极短,energy 应仍约 3.0
        let e = b2.current_energy("alice");
        assert!((e - 3.0).abs() < 0.01, "expected ~3.0 persisted, got {}", e);
    }

    #[test]
    fn iter_authors_returns_sorted_with_refilled_energy() {
        let tmp = TempDir::new().unwrap();
        let mut b = BudgetStore::open(tmp.path()).unwrap();
        b.try_charge("zebra", 1.0).unwrap(); // → 4
        b.try_charge("alpha", 2.0).unwrap(); // → 3
        b.try_charge("middle", 1.5).unwrap(); // → 3.5

        let listed = b.iter_authors();
        assert_eq!(listed.len(), 3);
        // 字典序
        assert_eq!(listed[0].0, "alpha");
        assert_eq!(listed[1].0, "middle");
        assert_eq!(listed[2].0, "zebra");
        // 能量值近似(允许微小回血)
        assert!((listed[0].1 - 3.0).abs() < 0.01);
        assert!((listed[1].1 - 3.5).abs() < 0.01);
        assert!((listed[2].1 - 4.0).abs() < 0.01);
    }
}
