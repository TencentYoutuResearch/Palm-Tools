//! Owner acceptance binds exact delivery evidence; it never substitutes for evidence checks.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub(super) fn require_acceptance(
    tx: &Transaction,
    id: &str,
    run: &mut Value,
    request_id: &str,
    request: &Value,
    evidence: &Value,
    at: u64,
) -> Result<Option<Value>> {
    let hash = format!(
        "{:x}",
        Sha256::digest(format!("kode.delivery.acceptance.v1\n{}", evidence).as_bytes())
    );
    if run["human_acceptance"]["state"] == "accepted"
        && run["human_acceptance"]["evidence_hash"] == hash
    {
        return Ok(None);
    }
    let revision = run["revision"].as_u64().unwrap() + 1;
    run["revision"] = json!(revision);
    run["updated_at"] = json!(at);
    run["state"] = json!("waiting_user");
    run["waiting_reason"] = json!("human_delivery_acceptance_required");
    run["human_acceptance"] = json!({"state":"pending","evidence_hash":hash,"evidence":evidence,"requested_at":at,"revision":revision});
    let result = json!({"run_id":id,"run_revision":revision,"state":"waiting_user","reason":"human_delivery_acceptance_required","completion_authorized":false,"human_acceptance":run["human_acceptance"]});
    tx.execute(
        "UPDATE work_runs SET revision=?2,state='waiting_user',body=?3 WHERE id=?1",
        params![id, revision, run.to_string()],
    )?;
    tx.execute(
        "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
        params![id, request_id, request.to_string(), result.to_string()],
    )?;
    tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)", params![id,json!({"kind":"delivery_acceptance_requested","revision":revision,"at":at,"evidence_hash":hash,"actor":{"kind":"system","id":"delivery_verifier"}}).to_string()])?;
    Ok(Some(result))
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Choice {
    Accept,
    Reject,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub request_id: String,
    pub expected_revision: u64,
    pub evidence_hash: String,
    pub choice: Choice,
    pub reason: String,
}
impl Store {
    pub fn decide_work_delivery(&self, id: &str, input: Decision) -> Result<Value> {
        if !valid_id(id)
            || !valid_id(&input.request_id)
            || input.expected_revision == 0
            || input.expected_revision >= i64::MAX as u64
            || input.evidence_hash.len() != 64
            || !input.evidence_hash.bytes().all(|b| b.is_ascii_hexdigit())
            || input.reason.trim().is_empty()
            || input.reason.len() > 2048
            || input.reason.contains('\0')
        {
            bail!("invalid delivery decision")
        }
        let request = json!({"action":"delivery_decision","input":input});
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let prior: Option<(String, String)> = tx
            .query_row(
                "SELECT request,result FROM work_run_commands WHERE run_id=?1 AND request_id=?2",
                params![id, input.request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((previous, result)) = prior {
            if serde_json::from_str::<Value>(&previous)? != request {
                bail!("work run command identity conflict")
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let body: String =
            tx.query_row("SELECT body FROM work_runs WHERE id=?1", [id], |r| r.get(0))?;
        let mut run: Value = serde_json::from_str(&body)?;
        if run["revision"] != input.expected_revision {
            bail!("work run revision conflict")
        }
        if run["state"] != "waiting_user"
            || run["waiting_reason"] != "human_delivery_acceptance_required"
            || run["completion_authorized"] != false
            || run["human_acceptance"]["state"] != "pending"
            || run["human_acceptance"]["evidence_hash"] != input.evidence_hash
            || run["context"]["binding"]["delivery_policy"]["config"]["spec"]["human_acceptance"]
                != true
        {
            bail!("delivery decision unavailable or evidence changed")
        }
        let at = now();
        let accepted = matches!(input.choice, Choice::Accept);
        let decision = json!({"request_id":input.request_id,"choice":input.choice,"reason":input.reason,"evidence_hash":input.evidence_hash,"at":at,"actor":{"kind":"human","id":"local_owner"}});
        run["human_acceptance"]["state"] = json!(if accepted { "accepted" } else { "rejected" });
        run["human_acceptance"]["decision"] = decision.clone();
        run["revision"] = json!(input.expected_revision + 1);
        run["updated_at"] = json!(at);
        run["state"] = json!(if accepted { "queued" } else { "waiting_user" });
        run["waiting_reason"] = json!(if accepted {
            "delivery_finalization_pending"
        } else {
            "human_delivery_rejected"
        });
        tx.execute(
            "UPDATE work_runs SET revision=?2,state=?3,body=?4 WHERE id=?1",
            params![
                id,
                input.expected_revision + 1,
                run["state"].as_str(),
                run.to_string()
            ],
        )?;
        tx.execute(
            "INSERT INTO work_run_commands(run_id,request_id,request,result) VALUES (?1,?2,?3,?4)",
            params![id, input.request_id, request.to_string(), run.to_string()],
        )?;
        tx.execute("INSERT INTO work_run_events(run_id,body) VALUES (?1,?2)",params![id,json!({"kind":"delivery_acceptance_decided","revision":run["revision"],"decision":decision,"at":at,"completion_authorized":false}).to_string()])?;
        tx.commit()?;
        Ok(run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_is_exact_durable_and_never_directly_completes_work() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("ledger.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let mut run = json!({"id":"run","state":"running","revision":1,"completion_authorized":false,
            "context":{"binding":{"delivery_policy":{"config":{"spec":{"human_acceptance":true}}}}}});
        let evidence = json!({"artifact":"a","context_hash":"frozen"});
        {
            let mut db = store.db.lock();
            let tx = db.transaction().unwrap();
            tx.execute(
                "INSERT INTO work_runs VALUES ('run','team','new','{}',1,'running',?1,?1)",
                [run.to_string()],
            )
            .unwrap();
            let pending = require_acceptance(
                &tx,
                "run",
                &mut run,
                "deliver",
                &json!({"delivery":1}),
                &evidence,
                1,
            )
            .unwrap()
            .unwrap();
            assert_eq!(pending["completion_authorized"], false);
            assert_eq!(run["state"], "waiting_user");
            tx.commit().unwrap();
        }
        let hash = run["human_acceptance"]["evidence_hash"]
            .as_str()
            .unwrap()
            .to_string();
        let command = || Decision {
            request_id: "accept".into(),
            expected_revision: 2,
            evidence_hash: hash.clone(),
            choice: Choice::Accept,
            reason: "Checked the artifact".into(),
        };
        let mut wrong = command();
        wrong.expected_revision = 1;
        assert!(store
            .decide_work_delivery("run", wrong)
            .unwrap_err()
            .to_string()
            .contains("revision"));
        let mut wrong = command();
        wrong.evidence_hash = "0".repeat(64);
        assert!(store.decide_work_delivery("run", wrong).is_err());
        let accepted = store.decide_work_delivery("run", command()).unwrap();
        assert_eq!(accepted["state"], "queued");
        assert_eq!(accepted["completion_authorized"], false);
        assert_eq!(
            accepted["human_acceptance"]["decision"]["actor"],
            json!({"kind":"human","id":"local_owner"})
        );
        assert_eq!(
            store.decide_work_delivery("run", command()).unwrap(),
            accepted
        );
        let mut conflict = command();
        conflict.reason = "Different".into();
        assert!(store.decide_work_delivery("run", conflict).is_err());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(
            store.decide_work_delivery("run", command()).unwrap(),
            accepted
        );
        assert_eq!(
            store.work_run_events("run", 0).unwrap()["events"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        {
            let mut db = store.db.lock();
            let tx = db.transaction().unwrap();
            let mut run = accepted;
            assert!(require_acceptance(
                &tx,
                "run",
                &mut run,
                "unchanged",
                &json!({}),
                &evidence,
                2
            )
            .unwrap()
            .is_none());
            assert!(require_acceptance(
                &tx,
                "run",
                &mut run,
                "changed",
                &json!({}),
                &json!({"artifact":"b"}),
                3
            )
            .unwrap()
            .is_some());
            assert_eq!(run["state"], "waiting_user");
            tx.commit().unwrap();
        }
        let run = store.work_run("run").unwrap().unwrap();
        let rejected = store
            .decide_work_delivery(
                "run",
                Decision {
                    request_id: "reject".into(),
                    expected_revision: 4,
                    evidence_hash: run["human_acceptance"]["evidence_hash"]
                        .as_str()
                        .unwrap()
                        .into(),
                    choice: Choice::Reject,
                    reason: "Artifact needs changes".into(),
                },
            )
            .unwrap();
        assert_eq!(rejected["waiting_reason"], "human_delivery_rejected");
        assert_eq!(rejected["completion_authorized"], false);
        assert!(store
            .finalize_work_delivery(
                "run",
                super::super::work_delivery::Finalize {
                    request_id: "bypass".into(),
                    expected_revision: 5
                }
            )
            .is_err());
    }
}
