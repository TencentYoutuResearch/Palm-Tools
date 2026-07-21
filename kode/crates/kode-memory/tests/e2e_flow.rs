//! 端到端集成测试:模拟真实流程 propose → review,联动 budget。
//!
//! 不开 MCP 进程(那个由 mcp_smoke 测试覆盖),直接调 Store + Budget 验证业务逻辑。

use kode_memory::{
    budget::{
        BudgetError, BudgetStore, COST_PROPOSE, PENALTY_BLACKLIST, PENALTY_REJECT, REWARD_APPROVE,
    },
    store::{ProposeResult, ReviewOutcome, Verdict},
    MemoryStore, Scope,
};
use tempfile::TempDir;

#[test]
fn happy_path_propose_then_approve() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();
    let mut budget = BudgetStore::open(tmp.path()).unwrap();

    // 1. agent 发现一条 gotcha,扣 1 点能量
    budget.try_charge("codebuddy", COST_PROPOSE).unwrap();
    let r = store
        .propose(
            "codebuddy",
            Some("sess-1"),
            Scope::Project("kode".into()),
            "PtyHost::kill 必须用 clone_killer() 拿独立句柄",
            vec!["pty".into(), "deadlock".into()],
            None,
            Some(0.9),
            Some("调试 kill_during_wait 时发现".into()),
            false,
            None,
            None,
        )
        .unwrap();
    let pending_id = match r {
        ProposeResult::Accepted { id } => id,
        _ => panic!("expected accepted"),
    };

    // 此时 search 找不到(还没审核)
    let hits = store.search("clone_killer", None, 5, false).unwrap();
    assert!(hits.is_empty(), "should not be searchable before approve");

    // 2. UI 列待审,看到这条
    let pending = store.list_pending().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].meta.id, pending_id);
    assert!(pending[0].rationale.is_some());

    // 3. 用户 approve
    let outcome = store.review(&pending_id, Verdict::Approve).unwrap();
    assert_eq!(outcome, ReviewOutcome::Approved);
    budget.add("codebuddy", REWARD_APPROVE).unwrap();

    // 此时 search 命中
    let hits = store.search("clone_killer", None, 5, false).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, pending_id);

    // pending 空
    assert_eq!(store.count_pending().unwrap(), 0);

    // budget:5 - 1 + 0.5 = 4.5
    assert!((budget.current_energy("codebuddy") - 4.5).abs() < 0.05);
}

#[test]
fn reject_path_archives_and_penalizes() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();
    let mut budget = BudgetStore::open(tmp.path()).unwrap();

    budget.try_charge("codebuddy", COST_PROPOSE).unwrap();
    let r = store
        .propose(
            "codebuddy",
            None,
            Scope::Shared,
            "我觉得用户喜欢蓝色主题",
            vec!["pref".into()],
            None,
            None,
            Some("agent 自作主张".into()),
            false,
            None,
            None,
        )
        .unwrap();
    let pid = match r {
        ProposeResult::Accepted { id } => id,
        _ => panic!(),
    };

    let outcome = store
        .review(
            &pid,
            Verdict::Reject {
                reason: "用户偏好不归 memory 管".into(),
            },
        )
        .unwrap();
    assert_eq!(outcome, ReviewOutcome::Rejected);
    budget.penalize("codebuddy", PENALTY_REJECT).unwrap();

    // archive 里应有
    assert!(tmp
        .path()
        .join(".kode")
        .join("archive")
        .join("rejected")
        .join(format!("{}.md", pid))
        .exists());
    // pending 空
    assert_eq!(store.count_pending().unwrap(), 0);
    // facts 没
    assert_eq!(store.count().unwrap(), 0);
    // budget:5 - 1 - 1 = 3
    assert!((budget.current_energy("codebuddy") - 3.0).abs() < 0.05);
}

#[test]
fn blacklist_path_heavy_penalty() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();
    let mut budget = BudgetStore::open(tmp.path()).unwrap();

    budget
        .try_charge("low-quality-agent", COST_PROPOSE)
        .unwrap();
    let r = store
        .propose(
            "low-quality-agent",
            None,
            Scope::Shared,
            "今天天气不错",
            vec![],
            None,
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap();
    let pid = match r {
        ProposeResult::Accepted { id } => id,
        _ => panic!(),
    };

    let outcome = store
        .review(
            &pid,
            Verdict::Blacklist {
                reason: "完全无关内容".into(),
            },
        )
        .unwrap();
    assert_eq!(outcome, ReviewOutcome::Blacklisted);
    budget
        .penalize("low-quality-agent", PENALTY_BLACKLIST)
        .unwrap();

    // budget:5 - 1 - 2 = 2
    assert!((budget.current_energy("low-quality-agent") - 2.0).abs() < 0.05);
}

#[test]
fn out_of_energy_blocks_further_proposals() {
    let tmp = TempDir::new().unwrap();
    let store = MemoryStore::open(tmp.path()).unwrap();
    let mut budget = BudgetStore::open(tmp.path()).unwrap();

    // 5 条全 reject:每条 -2,3 条后能量负
    for i in 0..3 {
        budget.try_charge("greedy", COST_PROPOSE).unwrap();
        budget.penalize("greedy", PENALTY_REJECT).unwrap();
        let _ = i;
    }
    // 5 - 6 = -1,被 clamp 到 0
    assert!(budget.current_energy("greedy") <= 0.01);

    // 第 4 次 propose 被拦
    let err = budget.try_charge("greedy", COST_PROPOSE).unwrap_err();
    match err {
        BudgetError::OutOfEnergy {
            current,
            needed,
            next_refill_at,
        } => {
            assert!(current < 1.0);
            assert!((needed - COST_PROPOSE).abs() < 0.01);
            assert!(next_refill_at > 0);
        }
        other => panic!("unexpected: {:?}", other),
    }

    // 同一时刻别的 author 不受影响
    let _ = store; // 让编译器满意,store 没用上但展示 store/budget 解耦
    let mut budget = budget;
    let energy = budget.try_charge("fresh-agent", COST_PROPOSE).unwrap();
    assert!((energy - 4.0).abs() < 0.01);
}

#[test]
fn edit_then_approve_overrides_fields() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();

    let r = store
        .propose(
            "codebuddy",
            None,
            Scope::Shared,
            "PTY 死锁 用 clone_killer", // 表述粗糙
            vec!["pty".into()],
            None,
            Some(0.6),
            None,
            false,
            None,
            None,
        )
        .unwrap();
    let pid = match r {
        ProposeResult::Accepted { id } => id,
        _ => panic!(),
    };

    let outcome = store
        .review(
            &pid,
            Verdict::EditThenApprove {
                body: Some(
                    "PtyHost::kill 必须用 clone_killer() 拿独立 kill 句柄,避免与 reaper 死锁"
                        .into(),
                ),
                tags: Some(vec!["pty".into(), "deadlock".into(), "gotcha".into()]),
                scope: Some(Scope::Project("kode".into())),
                confidence: Some(0.95),
                related: None,
                contradicts: None,
                title: None,
            },
        )
        .unwrap();
    assert_eq!(outcome, ReviewOutcome::Approved);

    let f = store.read(&pid).unwrap();
    assert!(f.body.contains("拿独立 kill 句柄"));
    assert_eq!(f.meta.tags, vec!["pty", "deadlock", "gotcha"]);
    assert_eq!(f.meta.scope, "project:kode");
    assert!((f.meta.confidence - 0.95).abs() < 1e-3);
}

#[test]
fn supersedes_old_via_propose_approve() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();

    // 第一条 fact(种子,直接落入 facts)
    let old = store
        .write_for_test(
            "user",
            None,
            Scope::Shared,
            "用 Mutex<Child> 同时给 reaper 和 killer",
            vec!["pty".into()],
            None,
        )
        .unwrap();

    // 第二条:agent 提议替换,带 supersedes
    let r = store
        .propose(
            "codebuddy",
            None,
            Scope::Shared,
            "改用 clone_killer() 拿独立句柄,避免死锁",
            vec!["pty".into()],
            Some(old.clone()),
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap();
    let new_id = match r {
        ProposeResult::Accepted { id } => id,
        _ => panic!(),
    };
    store.review(&new_id, Verdict::Approve).unwrap();

    // 老 fact 标 deprecated,默认 search 不召回
    let hits = store
        .search("Mutex OR clone_killer", None, 10, false)
        .unwrap();
    assert!(!hits.iter().any(|h| h.id == old));
    assert!(hits.iter().any(|h| h.id == new_id));

    // include_deprecated 时仍可见
    let hits2 = store
        .search("Mutex OR clone_killer", None, 10, true)
        .unwrap();
    assert!(hits2.iter().any(|h| h.id == old));
}

#[test]
fn duplicate_does_not_charge_energy() {
    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();
    let mut budget = BudgetStore::open(tmp.path()).unwrap();

    store
        .write_for_test(
            "user",
            None,
            Scope::Shared,
            "PtyHost::kill 必须用 clone_killer 拿独立句柄",
            vec![],
            None,
        )
        .unwrap();

    // 模拟 MCP 层逻辑:扣费 → propose → 若 duplicate 退还
    budget.try_charge("codebuddy", COST_PROPOSE).unwrap();
    let energy_after_charge = budget.current_energy("codebuddy");
    assert!((energy_after_charge - 4.0).abs() < 0.05);

    let r = store
        .propose(
            "codebuddy",
            None,
            Scope::Shared,
            "PtyHost::kill 必须用 clone_killer 拿独立句柄",
            vec![],
            None,
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap();
    assert!(matches!(r, ProposeResult::Duplicate(_)));

    // duplicate 退还
    budget.add("codebuddy", COST_PROPOSE).unwrap();
    let energy_after_refund = budget.current_energy("codebuddy");
    assert!(
        (energy_after_refund - 5.0).abs() < 0.05,
        "got {}",
        energy_after_refund
    );
}

#[test]
fn cross_session_persistence() {
    // 第一次会话:propose + approve
    let tmp = TempDir::new().unwrap();
    let pid;
    {
        let mut store = MemoryStore::open(tmp.path()).unwrap();
        let r = store
            .propose(
                "codebuddy",
                None,
                Scope::Shared,
                "FTS5 必须用 trigram tokenizer 才能搜中文",
                vec!["sqlite".into(), "fts".into()],
                None,
                None,
                None,
                false,
                None,
                None,
            )
            .unwrap();
        pid = match r {
            ProposeResult::Accepted { id } => id,
            _ => panic!(),
        };
        store.review(&pid, Verdict::Approve).unwrap();
    }

    // 第二次会话:重开 store,fact 还在,可被搜到
    let store2 = MemoryStore::open(tmp.path()).unwrap();
    let hits = store2.search("trigram tokenizer", None, 5, false).unwrap();
    assert!(hits.iter().any(|h| h.id == pid));
}
