//! Immutable internal price versions and trusted cumulative usage. Always estimates, not vendor invoices.
use super::{
    budgets::{settle_in, Reservation, Settle},
    model::valid_id,
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
// Defaults preserve the original trusted-admin API wire identity; they do not
// assert that a runtime/provider independently verified the requested model.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModelPolicy {
    #[default]
    AdminAttested,
    RequestedModel,
}
impl ModelPolicy {
    fn is_default(&self) -> bool {
        *self == Self::AdminAttested
    }
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Attribution {
    #[default]
    AdminAttested,
    RequestedModel {
        rerouted: bool,
        cache_write_input_tokens: u64,
    },
}
impl Attribution {
    fn is_default(&self) -> bool {
        *self == Self::AdminAttested
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Price {
    #[serde(default, skip_serializing_if = "ModelPolicy::is_default")]
    pub model_policy: ModelPolicy,
    pub id: String,
    pub model: String,
    pub unit: String,
    pub input_per_million: u64,
    pub cached_per_million: u64,
    pub output_per_million: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Attribution::is_default")]
    pub attribution: Attribution,
    pub event_id: String,
    pub reservation_id: String,
    pub expected_revision: u64,
    pub model: String,
    pub input_tokens: u64,
    pub cached_input_tokens: u64,
    pub output_tokens: u64,
}
pub(super) fn estimate(price: &Price, usage: &Usage) -> Result<u64> {
    if let Attribution::RequestedModel {
        rerouted,
        cache_write_input_tokens,
    } = &usage.attribution
    {
        if price.model_policy != ModelPolicy::RequestedModel
            || *rerouted
            || *cache_write_input_tokens != 0
        {
            bail!("requested model accounting is unauthorized or has unresolved usage")
        }
    }
    if usage.model != price.model
        || usage.cached_input_tokens > usage.input_tokens
        || usage.input_tokens > 1_000_000_000_000
        || usage.output_tokens > 1_000_000_000_000
    {
        bail!("invalid cumulative usage or price model mismatch")
    }
    let total = (usage.input_tokens - usage.cached_input_tokens) as u128
        * price.input_per_million as u128
        + usage.cached_input_tokens as u128 * price.cached_per_million as u128
        + usage.output_tokens as u128 * price.output_per_million as u128;
    let charge = total.div_ceil(1_000_000);
    if charge > 4_000_000_000_000_000 {
        bail!("estimated charge exceeds accounting bound")
    }
    Ok(charge as u64)
}
pub(super) fn create_in(tx: &rusqlite::Transaction, price: Price) -> Result<Price> {
    if !valid_id(&price.id)
        || !valid_id(&price.unit)
        || price.model.is_empty()
        || price.model.len() > 256
        || [
            price.input_per_million,
            price.cached_per_million,
            price.output_per_million,
        ]
        .iter()
        .any(|v| *v > 4_000_000_000_000_000)
    {
        bail!("invalid internal price version")
    }
    let wire = serde_json::to_string(&price)?;
    let old: Option<String> = tx
        .query_row(
            "SELECT body FROM price_versions WHERE id=?1",
            [&price.id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != wire {
            bail!("price version is immutable")
        }
        return Ok(price);
    }
    tx.execute(
        "INSERT INTO price_versions(id,body) VALUES (?1,?2)",
        params![price.id, wire],
    )?;
    Ok(price)
}
impl Store {
    pub fn create_price(&self, price: Price) -> Result<Price> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = create_in(&tx, price)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn price(&self, id: &str) -> Result<Option<Price>> {
        let body: Option<String> = self
            .db
            .lock()
            .query_row("SELECT body FROM price_versions WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        body.map(|b| Ok(serde_json::from_str(&b)?)).transpose()
    }
    pub fn bind_price(&self, id: &str, price_id: &str) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = bind_price_in(&tx, id, price_id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn record_usage(&self, input: Usage, at: u64) -> Result<serde_json::Value> {
        if !valid_id(&input.event_id) || !valid_id(&input.reservation_id) {
            bail!("invalid usage identity")
        }
        let wire = serde_json::to_string(&input)?;
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let previous: Option<(String, String)> = tx
            .query_row(
                "SELECT command,result FROM metered_usage WHERE event_id=?1",
                [&input.event_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some((command, result)) = previous {
            if command != wire {
                bail!("usage event identity conflict")
            }
            return Ok(serde_json::from_str(&result)?);
        }
        let price:String=tx.query_row("SELECT p.body FROM reservation_prices r JOIN price_versions p ON p.id=r.price_id WHERE r.reservation_id=?1",[&input.reservation_id],|r|r.get(0))?;
        let price: Price = serde_json::from_str(&price)?;
        let prior:Option<String>=tx.query_row("SELECT command FROM metered_usage WHERE reservation_id=?1 ORDER BY seq DESC LIMIT 1",[&input.reservation_id],|r|r.get(0)).optional()?;
        if let Some(prior) = prior {
            let prior: Usage = serde_json::from_str(&prior)?;
            if input.input_tokens < prior.input_tokens
                || input.cached_input_tokens < prior.cached_input_tokens
                || input.output_tokens < prior.output_tokens
            {
                bail!("cumulative usage regressed")
            }
        }
        let body: String = tx.query_row(
            "SELECT body FROM budget_reservations WHERE id=?1",
            [&input.reservation_id],
            |r| r.get(0),
        )?;
        let row: Reservation = serde_json::from_str(&body)?;
        if row
            .charge_basis
            .as_deref()
            .is_some_and(|basis| basis != "estimated")
        {
            bail!("usage cannot overwrite reported/manual settlement")
        }
        let official:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM official_calls WHERE operation_id=?1 AND json_extract(body,'$.accounting.reservation_id')=?2)",params![row.request.operation_id,input.reservation_id],|r|r.get(0))?;
        if official {
            bail!("reservation belongs to official call accounting")
        }
        let charge = estimate(&price, &input)?;
        // Generated receipt namespace avoids collisions with caller-supplied settlement IDs.
        let event_id = format!("usage-{}", uuid::Uuid::new_v4());
        let result = settle_in(
            &tx,
            &input.reservation_id,
            Settle {
                event_id: event_id.clone(),
                expected_revision: input.expected_revision,
                total_charge: charge,
                finalized: false,
                basis: "estimated".into(),
            },
            at,
        )?;
        let result = serde_json::json!({"price_id":price.id,"settlement_event_id":event_id,"estimated":true,"attribution":input.attribution,"reservation":result});
        tx.execute("INSERT INTO metered_usage(event_id,reservation_id,command,result) VALUES (?1,?2,?3,?4)",params![input.event_id,input.reservation_id,wire,serde_json::to_string(&result)?])?;
        tx.execute("INSERT INTO budget_events(body) VALUES (?1)",[serde_json::to_string(&serde_json::json!({"kind":"usage_observed","at":at,"usage":input,"price_id":price.id,"reservation":result["reservation"]}))?])?;
        tx.commit()?;
        Ok(result)
    }
    pub fn usage_receipt(&self, id: &str) -> Result<Option<serde_json::Value>> {
        let row: Option<(String, String)> = self
            .db
            .lock()
            .query_row(
                "SELECT command,result FROM metered_usage WHERE event_id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        row.map(|(input,result)|Ok(serde_json::json!({"usage":serde_json::from_str::<serde_json::Value>(&input)?,"result":serde_json::from_str::<serde_json::Value>(&result)?}))).transpose()
    }
}

pub(super) fn bind_price_in(
    tx: &rusqlite::Connection,
    id: &str,
    price_id: &str,
) -> Result<serde_json::Value> {
    let old: Option<String> = tx
        .query_row(
            "SELECT price_id FROM reservation_prices WHERE reservation_id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(old) = old {
        if old != price_id {
            bail!("reservation pricing is immutable")
        }
        return Ok(serde_json::json!({"price_id":old}));
    }
    let price: String = tx.query_row(
        "SELECT body FROM price_versions WHERE id=?1",
        [price_id],
        |r| r.get(0),
    )?;
    let price: Price = serde_json::from_str(&price)?;
    let body: String = tx.query_row(
        "SELECT body FROM budget_reservations WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    let row: Reservation = serde_json::from_str(&body)?;
    if row.revision != 1 || row.finalized || row.request.unit != price.unit {
        bail!("price binding requires unbilled reservation with matching unit")
    }
    tx.execute(
        "INSERT INTO reservation_prices(reservation_id,price_id) VALUES (?1,?2)",
        params![id, price_id],
    )?;
    tx.execute(
        "INSERT INTO budget_events(body) VALUES (?1)",
        [serde_json::to_string(
            &serde_json::json!({"kind":"price_bound","price":price,"reservation":row}),
        )?],
    )?;
    Ok(serde_json::json!({"price_id":price_id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::messaging::budgets::{Configure, Reserve, Scope};
    fn price() -> Price {
        Price {
            model_policy: ModelPolicy::default(),
            id: "price-v1".into(),
            model: "fixture".into(),
            unit: "credits".into(),
            input_per_million: 1_000_000,
            cached_per_million: 100_000,
            output_per_million: 2_000_000,
        }
    }
    fn usage() -> Usage {
        Usage {
            attribution: Attribution::default(),
            event_id: "u1".into(),
            reservation_id: "hold".into(),
            expected_revision: 1,
            model: "fixture".into(),
            input_tokens: 10,
            cached_input_tokens: 5,
            output_tokens: 2,
        }
    }
    #[test]
    fn priced_usage_is_atomic_idempotent_and_preserves_estimate_provenance() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pricing.sqlite");
        let store = Store::open(&path, "home").unwrap();
        store
            .configure_budget(
                Configure {
                    id: "team".into(),
                    scope: Scope::Team,
                    scope_id: "team".into(),
                    unit: "credits".into(),
                    limit: 100,
                    starts_at: 1,
                    ends_at: 9999,
                    expected_revision: 0,
                },
                1,
            )
            .unwrap();
        store
            .reserve_budget(
                Reserve {
                    id: "hold".into(),
                    budget_ids: vec!["team".into()],
                    amount: 50,
                    unit: "credits".into(),
                    operation_id: "op".into(),
                },
                2,
            )
            .unwrap();
        assert!(store.record_usage(usage(), 3).is_err());
        store.create_price(price()).unwrap();
        store.create_price(price()).unwrap();
        assert!(store
            .create_price(Price {
                output_per_million: 3,
                ..price()
            })
            .is_err());
        store.bind_price("hold", "price-v1").unwrap();
        assert!(store
            .create_price(Price {
                model_policy: ModelPolicy::RequestedModel,
                ..price()
            })
            .is_err());
        let requested = Usage {
            attribution: Attribution::RequestedModel {
                rerouted: false,
                cache_write_input_tokens: 0,
            },
            ..usage()
        };
        assert!(store.record_usage(requested, 3).is_err());
        assert!(store.usage_receipt("u1").unwrap().is_none());
        assert_eq!(store.budget("team").unwrap()["budget"]["spent"], 0);

        store.db.lock().execute_batch("CREATE TRIGGER fail_usage BEFORE INSERT ON metered_usage BEGIN SELECT RAISE(ABORT,'fixture failure');END;").unwrap();
        assert!(store.record_usage(usage(), 3).is_err());
        assert_eq!(store.budget("team").unwrap()["budget"]["spent"], 0);
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT count(*) FROM budget_settlements", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            0
        );
        store
            .db
            .lock()
            .execute_batch("DROP TRIGGER fail_usage")
            .unwrap();

        let first = store.record_usage(usage(), 3).unwrap();
        assert_eq!(first["reservation"]["charged"], 10);
        assert_eq!(first["reservation"]["held"], 40);
        assert_eq!(first["estimated"], true);
        assert_eq!(store.record_usage(usage(), 4).unwrap(), first);
        assert!(store
            .record_usage(
                Usage {
                    output_tokens: 3,
                    ..usage()
                },
                4
            )
            .is_err());
        assert!(store
            .record_usage(
                Usage {
                    event_id: "wrong-model".into(),
                    expected_revision: 2,
                    model: "other".into(),
                    ..usage()
                },
                4
            )
            .is_err());
        assert!(store.usage_receipt("wrong-model").unwrap().is_none());
        assert_eq!(store.budget("team").unwrap()["estimated_charged"], 10);
        let next = Usage {
            event_id: "u2".into(),
            expected_revision: 2,
            input_tokens: 20,
            cached_input_tokens: 10,
            output_tokens: 4,
            ..usage()
        };
        let result = store.record_usage(next, 5).unwrap();
        assert_eq!(
            result["reservation"]["charged"], 19,
            "round cumulative total once; do not accumulate per-event rounding"
        );
        assert!(store
            .record_usage(
                Usage {
                    event_id: "regressed".into(),
                    expected_revision: 3,
                    ..usage()
                },
                6
            )
            .is_err());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(store.usage_receipt("u1").unwrap().unwrap()["result"], first);
        store
            .settle_budget(
                "hold",
                Settle {
                    event_id: "invoice".into(),
                    expected_revision: 3,
                    total_charge: 18,
                    finalized: true,
                    basis: "reported".into(),
                },
                7,
            )
            .unwrap();
        assert!(store
            .record_usage(
                Usage {
                    event_id: "late".into(),
                    expected_revision: 4,
                    input_tokens: 30,
                    ..usage()
                },
                8
            )
            .is_err());
        assert_eq!(store.budget("team").unwrap()["estimated_charged"], 0);
        assert_eq!(store.budget("team").unwrap()["budget"]["spent"], 18);
    }
    #[test]
    fn requested_model_requires_explicit_frozen_policy_and_complete_evidence() {
        let mut u = usage();
        u.attribution = Attribution::RequestedModel {
            rerouted: false,
            cache_write_input_tokens: 0,
        };
        assert!(estimate(&price(), &u).is_err());
        let p = Price {
            model_policy: ModelPolicy::RequestedModel,
            ..price()
        };
        assert_eq!(estimate(&p, &u).unwrap(), 10);
        for attribution in [
            Attribution::RequestedModel {
                rerouted: true,
                cache_write_input_tokens: 0,
            },
            Attribution::RequestedModel {
                rerouted: false,
                cache_write_input_tokens: 1,
            },
        ] {
            u.attribution = attribution;
            assert!(estimate(&p, &u).is_err());
        }
        // Existing stored command bodies remain byte-identical on replay.
        let wire = serde_json::to_value(price()).unwrap();
        assert!(wire.get("model_policy").is_none());
        assert_eq!(
            serde_json::to_value(serde_json::from_value::<Price>(wire.clone()).unwrap()).unwrap(),
            wire
        );
        let mut wire = serde_json::to_value(usage()).unwrap();
        assert!(wire.get("attribution").is_none());
        wire["attribution"] = serde_json::json!({"kind":"requested_model","rerouted":false});
        assert!(serde_json::from_value::<Usage>(wire).is_err());
    }
    #[test]
    fn token_arithmetic_rejects_invalid_counts_and_overflow() {
        assert!(estimate(
            &price(),
            &Usage {
                cached_input_tokens: 11,
                ..usage()
            }
        )
        .is_err());
        assert!(estimate(
            &Price {
                output_per_million: 4_000_000_000_000_000,
                ..price()
            },
            &Usage {
                output_tokens: 1_000_000_000_000,
                ..usage()
            }
        )
        .is_err());
        assert_eq!(
            estimate(
                &Price {
                    input_per_million: 1,
                    cached_per_million: 1,
                    output_per_million: 1,
                    ..price()
                },
                &usage()
            )
            .unwrap(),
            1
        );
    }
}
