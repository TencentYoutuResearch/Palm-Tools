//! 并发写入压力测试 —— prototype 最关键的一项验证。
//!
//! 注意:M1 改造后 agent 不能直接写 facts/,这里用 `write_for_test` 模拟
//! 内部 commit 路径(等价于 review approve 后落入 facts 的那一步)。
//! 这测的是 `commit_to_facts` 的并发安全,不是 `propose` 的。
//!
//! 目标:
//! 1. N 个 task 各写 M 条 → 总数 == N*M(无丢失)
//! 2. id 全部唯一
//! 3. SQLite 行数 == 实际落盘文件数(状态一致)
//! 4. 每个文件可被解析回 Fact

use kode_memory::{MemoryStore, Scope};
use std::collections::HashSet;
use std::sync::Arc;
use tempfile::TempDir;
use tokio::sync::Mutex;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writes_no_loss_no_collision() {
    let tmp = TempDir::new().unwrap();
    let store = Arc::new(Mutex::new(MemoryStore::open(tmp.path()).unwrap()));

    const N_TASKS: usize = 10;
    const M_PER_TASK: usize = 100;

    let mut handles = Vec::new();
    for t in 0..N_TASKS {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            let mut my_ids = Vec::with_capacity(M_PER_TASK);
            for i in 0..M_PER_TASK {
                let mut s = store.lock().await;
                let id = s
                    .write_for_test(
                        &format!("agent-{}", t),
                        Some(&format!("sess-{}", t)),
                        Scope::Shared,
                        &format!("fact body from task {} item {}", t, i),
                        vec![format!("t{}", t), format!("i{}", i)],
                        Some(0.7 + (i as f32) * 0.001),
                    )
                    .unwrap();
                my_ids.push(id);
            }
            my_ids
        }));
    }

    let mut all_ids: Vec<String> = Vec::new();
    for h in handles {
        all_ids.extend(h.await.unwrap());
    }

    let total = N_TASKS * M_PER_TASK;
    assert_eq!(all_ids.len(), total, "expected all writes to succeed");
    let unique: HashSet<_> = all_ids.iter().cloned().collect();
    assert_eq!(unique.len(), total, "ids must be unique");
    let count_db = store.lock().await.count().unwrap();
    assert_eq!(count_db as usize, total, "sqlite row count");
    let facts_dir = tmp.path().join("vault").join("facts");
    let file_count = std::fs::read_dir(&facts_dir).unwrap().count();
    assert_eq!(file_count, total, "file count on disk");
    let leftover = std::fs::read_dir(tmp.path().join(".kode").join("tmp"))
        .unwrap()
        .count();
    assert_eq!(leftover, 0, "no leftover tmp files");

    let s = store.lock().await;
    for id in all_ids.iter().take(10) {
        let f = s.read(id).unwrap();
        assert_eq!(&f.meta.id, id);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_writes_then_search_works() {
    let tmp = TempDir::new().unwrap();
    let store = Arc::new(Mutex::new(MemoryStore::open(tmp.path()).unwrap()));

    let mut handles = Vec::new();
    for t in 0..5 {
        let store = store.clone();
        handles.push(tokio::spawn(async move {
            for i in 0..20 {
                let mut s = store.lock().await;
                s.write_for_test(
                    &format!("agent-{}", t),
                    None,
                    Scope::Shared,
                    &format!("uniqueneedle{}{} 关键词测试", t, i),
                    vec![],
                    None,
                )
                .unwrap();
            }
        }));
    }
    for h in handles {
        h.await.unwrap();
    }

    let s = store.lock().await;
    let hits = s.search("uniqueneedle12", None, 50, false).unwrap();
    assert!(!hits.is_empty(), "search should find written facts");

    let cn = s.search("关键词测试", None, 50, false).unwrap();
    assert!(!cn.is_empty(), "cjk search works after concurrent writes");
}
