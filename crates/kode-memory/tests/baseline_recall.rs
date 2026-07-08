//! Baseline 召回测试 —— v1 启动前必须达标的对照基准。
//!
//! 设计参考 `.specops/specs/memory-design.md` §6.5:
//! 没有这个 baseline,1 个月后没人能回答"召回变好了吗"。
//!
//! 流程:
//! 1. 加载 tests/baseline/seeds.jsonl,用 write_for_test 落入 facts/
//!    (跳过 propose+review 流程,直接灌种子)
//! 2. 加载 tests/baseline/queries.jsonl
//! 3. 对每个 query 跑 search → 看 expected_id 是否在 Top-1 / Top-5
//! 4. 输出准确率,要求 Top-5 ≥ 70%
//!
//! 跑:`cargo test -p kode-memory --test baseline_recall -- --nocapture`

use kode_memory::{MemoryStore, Scope};
use serde::Deserialize;
use std::collections::HashMap;
use tempfile::TempDir;

#[derive(Debug, Deserialize)]
struct Seed {
    id: String,
    scope: String,
    body: String,
    #[serde(default)]
    tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Query {
    query: String,
    expected_id: String,
}

fn load_jsonl<T: for<'de> Deserialize<'de>>(path: &str) -> Vec<T> {
    let text = std::fs::read_to_string(path).expect("read jsonl");
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.trim().starts_with("//"))
        .map(|l| serde_json::from_str(l).expect("parse jsonl line"))
        .collect()
}

#[test]
fn baseline_recall_meets_threshold() {
    let crate_dir = env!("CARGO_MANIFEST_DIR");
    let seeds: Vec<Seed> = load_jsonl(&format!("{}/tests/baseline/seeds.jsonl", crate_dir));
    let queries: Vec<Query> = load_jsonl(&format!("{}/tests/baseline/queries.jsonl", crate_dir));

    assert!(seeds.len() >= 50, "need ≥50 seeds, got {}", seeds.len());
    assert!(
        queries.len() >= 30,
        "need ≥30 queries, got {}",
        queries.len()
    );

    let tmp = TempDir::new().unwrap();
    let mut store = MemoryStore::open(tmp.path()).unwrap();

    // 用 slug → ulid 映射,后面比对召回结果
    let mut slug_to_ulid: HashMap<String, String> = HashMap::new();
    for s in &seeds {
        let scope = Scope::parse(&s.scope).unwrap();
        let ulid = store
            .write_for_test("baseline-seed", None, scope, &s.body, s.tags.clone(), None)
            .unwrap();
        slug_to_ulid.insert(s.id.clone(), ulid);
    }

    let mut top1 = 0usize;
    let mut top5 = 0usize;
    let mut misses: Vec<(String, String)> = Vec::new();

    for q in &queries {
        let expected_ulid = slug_to_ulid
            .get(&q.expected_id)
            .unwrap_or_else(|| panic!("query expects unknown seed id: {}", q.expected_id));

        // 不限 scope,Top-5
        let hits = store.search(&q.query, None, 5, false).unwrap();
        let position = hits.iter().position(|h| &h.id == expected_ulid);
        match position {
            Some(0) => {
                top1 += 1;
                top5 += 1;
            }
            Some(_) => top5 += 1,
            None => misses.push((q.query.clone(), q.expected_id.clone())),
        }
    }

    let total = queries.len();
    let top1_pct = top1 as f32 / total as f32 * 100.0;
    let top5_pct = top5 as f32 / total as f32 * 100.0;

    println!();
    println!("=== Baseline Recall Report ===");
    println!("seeds:   {}", seeds.len());
    println!("queries: {}", total);
    println!("Top-1:   {}/{} ({:.1}%)", top1, total, top1_pct);
    println!("Top-5:   {}/{} ({:.1}%)", top5, total, top5_pct);
    if !misses.is_empty() {
        println!();
        println!("=== Misses (not in Top-5) ===");
        for (q, exp) in &misses {
            println!("  ❌ \"{}\" → expected {}", q, exp);
        }
    }
    println!();

    // 硬阈值:Top-5 ≥ 70%
    assert!(
        top5_pct >= 70.0,
        "Top-5 recall {:.1}% < 70% threshold. {} misses out of {}",
        top5_pct,
        misses.len(),
        total
    );
}
