//! Home-Hub account grouping is owner-declared, never inferred from credentials or CLI homes.
use super::{
    model::{now, valid_id},
    store::Store,
};
use anyhow::{bail, Result};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountCommand {
    pub id: String,
    pub expected_epoch: u64,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    pub epoch: u64,
    pub enabled: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BindingCommand {
    pub host: String,
    pub profile: String,
    pub account_id: String,
    pub account_epoch: u64,
    pub expected_revision: u64,
}
pub(super) fn account_in(tx: &rusqlite::Transaction, input: AccountCommand) -> Result<Account> {
    if !valid_id(&input.id) {
        bail!("invalid opaque account ID")
    }
    let epoch: u64 = tx
        .query_row(
            "SELECT epoch FROM resource_accounts WHERE id=?1",
            [&input.id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if epoch != input.expected_epoch {
        bail!("account epoch conflict")
    }
    let row = Account {
        id: input.id,
        epoch: epoch
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("account epoch exhausted"))?,
        enabled: input.enabled,
    };
    tx.execute("INSERT INTO resource_accounts(id,epoch,enabled) VALUES (?1,?2,?3) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,enabled=excluded.enabled",params![row.id,row.epoch,row.enabled])?;
    tx.execute(
        "INSERT INTO resource_events(body) VALUES (?1)",
        [serde_json::to_string(
            &serde_json::json!({"kind":"account_changed","account":row,"at":now()}),
        )?],
    )?;
    Ok(row)
}
pub(super) fn binding_in(
    tx: &rusqlite::Transaction,
    input: BindingCommand,
) -> Result<serde_json::Value> {
    if !valid_id(&input.host) || !valid_id(&input.profile) || !valid_id(&input.account_id) {
        bail!("invalid resource identity")
    }
    let account: Option<(u64, bool)> = tx
        .query_row(
            "SELECT epoch,enabled FROM resource_accounts WHERE id=?1",
            [&input.account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if account != Some((input.account_epoch, true)) {
        bail!("account is missing, disabled or changed")
    }
    let revision: u64 = tx
        .query_row(
            "SELECT revision FROM resource_bindings WHERE host=?1 AND profile=?2",
            params![input.host, input.profile],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);
    if revision != input.expected_revision {
        bail!("resource binding revision conflict")
    }
    let next = revision
        .checked_add(1)
        .filter(|v| *v <= i64::MAX as u64)
        .ok_or_else(|| anyhow::anyhow!("resource revision exhausted"))?;
    tx.execute("INSERT INTO resource_bindings(host,profile,account_id,account_epoch,revision) VALUES (?1,?2,?3,?4,?5) ON CONFLICT(host,profile) DO UPDATE SET account_id=excluded.account_id,account_epoch=excluded.account_epoch,revision=excluded.revision,enabled=1",params![input.host,input.profile,input.account_id,input.account_epoch,next])?;
    let result = serde_json::json!({"host":input.host,"profile":input.profile,"account_id":input.account_id,"account_epoch":input.account_epoch,"revision":next});
    tx.execute(
        "INSERT INTO resource_events(body) VALUES (?1)",
        [serde_json::to_string(
            &serde_json::json!({"kind":"resource_bound","binding":result,"at":now()}),
        )?],
    )?;
    Ok(result)
}
impl Store {
    pub fn resource_account(&self, id: &str) -> Result<Option<Account>> {
        Ok(self
            .db
            .lock()
            .query_row(
                "SELECT id,epoch,enabled FROM resource_accounts WHERE id=?1",
                [id],
                |r| {
                    Ok(Account {
                        id: r.get(0)?,
                        epoch: r.get(1)?,
                        enabled: r.get(2)?,
                    })
                },
            )
            .optional()?)
    }
    pub fn change_resource_account(&self, input: AccountCommand) -> Result<Account> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = account_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn bind_resource_account(&self, input: BindingCommand) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let result = binding_in(&tx, input)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn resource_bindings(&self, host: &str, after: &str) -> Result<Vec<serde_json::Value>> {
        let db = self.db.lock();
        let mut query=db.prepare("SELECT b.profile,b.account_id,b.account_epoch,b.revision,a.epoch,(a.enabled AND b.enabled) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile>?2 ORDER BY b.profile LIMIT 100")?;
        let rows=query.query_map(params![host,after],|r| {
            let bound:u64=r.get(2)?;let current:u64=r.get(4)?;let enabled:bool=r.get(5)?;
            Ok(serde_json::json!({"host":host,"profile":r.get::<_,String>(0)?,"account_id":r.get::<_,String>(1)?,"account_epoch":bound,"revision":r.get::<_,u64>(3)?,"current_account_epoch":current,"binding_current":enabled&&bound==current,"quota_status":"not_connected"}))
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InvalidateBinding {
    pub host: String,
    pub profile: String,
    pub expected_revision: u64,
}
impl Store {
    pub fn resource_binding(&self, host: &str, profile: &str) -> Result<serde_json::Value> {
        let db = self.db.lock();
        let row:Option<(String,u64,u64,bool)>=db.query_row("SELECT b.account_id,b.account_epoch,b.revision,(b.enabled=1 AND a.enabled=1 AND b.account_epoch=a.epoch) FROM resource_bindings b JOIN resource_accounts a ON a.id=b.account_id WHERE b.host=?1 AND b.profile=?2",params![host,profile],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
        Ok(match row {
            Some((id, epoch, revision, current)) => {
                serde_json::json!({"host":host,"profile":profile,"account_id":id,"account_epoch":epoch,"revision":revision,"binding_current":current})
            }
            None => serde_json::json!({"host":host,"profile":profile,"binding_current":false}),
        })
    }
    pub fn invalidate_resource_binding(
        &self,
        input: InvalidateBinding,
    ) -> Result<serde_json::Value> {
        let mut db = self.db.lock();
        let tx = db.transaction()?;
        let row: Option<(u64, bool)> = tx
            .query_row(
                "SELECT revision,enabled FROM resource_bindings WHERE host=?1 AND profile=?2",
                params![input.host, input.profile],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((revision, enabled)) = row else {
            bail!("resource binding missing")
        };
        if !enabled && input.expected_revision.checked_add(1) == Some(revision) {
            return Ok(serde_json::json!({"revision":revision,"invalidated":true}));
        }
        if revision != input.expected_revision {
            bail!("resource binding revision conflict")
        }
        let next = revision
            .checked_add(1)
            .filter(|v| *v <= i64::MAX as u64)
            .ok_or_else(|| anyhow::anyhow!("resource revision exhausted"))?;
        tx.execute(
            "UPDATE resource_bindings SET revision=?3,enabled=0 WHERE host=?1 AND profile=?2",
            params![input.host, input.profile, next],
        )?;
        tx.execute("INSERT INTO resource_events(body) VALUES (?1)",[serde_json::to_string(&serde_json::json!({"kind":"resource_invalidated","host":input.host,"profile":input.profile,"revision":next,"at":now()}))?])?;
        tx.commit()?;
        Ok(serde_json::json!({"revision":next,"invalidated":true}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn account_rotation_invalidates_all_shared_bindings_and_survives_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("resources.sqlite");
        let store = Store::open(&path, "home").unwrap();
        let account = store
            .change_resource_account(AccountCommand {
                id: "shared".into(),
                expected_epoch: 0,
                enabled: true,
            })
            .unwrap();
        for profile in ["builder", "worker"] {
            store
                .bind_resource_account(BindingCommand {
                    host: "remote".into(),
                    profile: profile.into(),
                    account_id: account.id.clone(),
                    account_epoch: 1,
                    expected_revision: 0,
                })
                .unwrap();
        }
        assert!(store
            .resource_bindings("remote", "")
            .unwrap()
            .iter()
            .all(|r| r["binding_current"] == true));
        assert!(store
            .change_resource_account(AccountCommand {
                id: "shared".into(),
                expected_epoch: 0,
                enabled: true
            })
            .is_err());
        store
            .change_resource_account(AccountCommand {
                id: "shared".into(),
                expected_epoch: 1,
                enabled: false,
            })
            .unwrap();
        assert!(store
            .resource_bindings("remote", "")
            .unwrap()
            .iter()
            .all(|r| r["binding_current"] == false));
        assert!(store
            .bind_resource_account(BindingCommand {
                host: "remote".into(),
                profile: "worker".into(),
                account_id: "shared".into(),
                account_epoch: 2,
                expected_revision: 1
            })
            .is_err());
        drop(store);
        let store = Store::open(&path, "home").unwrap();
        assert_eq!(store.resource_account("shared").unwrap().unwrap().epoch, 2);
        store
            .change_resource_account(AccountCommand {
                id: "shared".into(),
                expected_epoch: 2,
                enabled: true,
            })
            .unwrap();
        let command = BindingCommand {
            host: "remote".into(),
            profile: "worker".into(),
            account_id: "shared".into(),
            account_epoch: 3,
            expected_revision: 1,
        };
        store.bind_resource_account(command.clone()).unwrap();
        assert!(store.bind_resource_account(command).is_err());
        let rows = store.resource_bindings("remote", "").unwrap();
        assert_eq!(rows[0]["binding_current"], false);
        assert_eq!(rows[1]["binding_current"], true);
        assert_eq!(
            store.resource_bindings("remote", "builder").unwrap().len(),
            1
        );
        assert_eq!(
            store
                .db
                .lock()
                .query_row("SELECT count(*) FROM resource_events", [], |r| r
                    .get::<_, u64>(0))
                .unwrap(),
            6
        );
    }
}
