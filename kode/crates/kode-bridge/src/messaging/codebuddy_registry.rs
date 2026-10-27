//! Adopt the existing enabled CodeBuddy definition when its native protocol is
//! first supported. Existing identities (including deleted ones) are respected.
use super::Hub;
use anyhow::Result;
use serde_json::json;

pub(super) fn adopt_existing(hub: &Hub) -> Result<()> {
    let row = hub.store.document("agents")?;
    let mut value = row["value"].clone();
    let Some(raw) = value.pointer("/desktop_backends/codebuddy") else {
        return Ok(());
    };
    let config: kode_core::BackendConfig = serde_json::from_value(raw.clone())?;
    if !config.is_enabled()
        || value["desktop_ids"]
            .as_object()
            .is_some_and(|ids| ids.values().any(|key| key == "codebuddy"))
    {
        return Ok(());
    }
    let Some(profiles) = value["profiles"].as_array_mut() else {
        return Ok(());
    };
    if profiles
        .iter()
        .any(|profile| profile["id"] == "kode-codebuddy")
    {
        return Ok(());
    }
    let mut profile = json!({"id":"kode-codebuddy","name":"codebuddy","type":"codebuddy","origin":"custom","executable":config.command,"args":config.args,"env":{}});
    if let Some(model) = config.default_model {
        profile["defaultModel"] = json!(model);
    }
    profiles.push(profile);
    value["desktop_ids"]["kode-codebuddy"] = json!("codebuddy");
    hub.store
        .save_document("agents", row["revision"].as_u64().unwrap(), value)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn capability_adoption_preserves_the_existing_backend_and_does_not_resurrect_deleted_ids()
    {
        let root = tempfile::tempdir().unwrap();
        let mut config = kode_core::Config::default();
        config.backends.clear();
        let ctx = crate::build_runtime_ctx(config, "codebuddy-test-secret".into());
        let hub = Hub::open(
            super::super::Config {
                node_id: "codebuddy-adoption".into(),
                database: root.path().join("state.sqlite"),
                peers: vec![],
            },
            &ctx,
        )
        .unwrap();
        let mut buddy = kode_core::Config::default().backends["codebuddy"].clone();
        buddy.enabled = Some(true);
        buddy.command = "/example/company-codebuddy".into();
        buddy.args = vec!["--agent".into(), "team".into()];
        let existing = hub.store.document("agents").unwrap();
        hub.store.save_document("agents",existing["revision"].as_u64().unwrap(),json!({"version":1,"profiles":[],"bindings":{},"desktop_ids":{},"desktop_backends":{"codebuddy":buddy},"shared_registry_version":1})).unwrap();
        adopt_existing(&hub).unwrap();
        let stored = hub.store.document("agents").unwrap();
        assert_eq!(stored["value"]["profiles"][0]["type"], "codebuddy");
        assert_eq!(
            stored["value"]["profiles"][0]["executable"],
            "/example/company-codebuddy"
        );
        assert_eq!(
            stored["value"]["desktop_backends"]["codebuddy"],
            json!(buddy)
        );
        let mut value = stored["value"].clone();
        value["profiles"] = json!([]);
        hub.store
            .save_document("agents", stored["revision"].as_u64().unwrap(), value)
            .unwrap();
        adopt_existing(&hub).unwrap();
        assert!(hub.store.document("agents").unwrap()["value"]["profiles"]
            .as_array()
            .unwrap()
            .is_empty());
    }
}
