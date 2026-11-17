//! Regression for growing shared Agent registries; isolated HTTP fixture only.
use super::*;

#[tokio::test]
async fn large_agent_documents_remain_durable_authorized_and_bounded() {
    let s = server("document-limit-test", vec![]).await;
    let client = reqwest::Client::new();
    let url = format!("{}/api/v1/messaging/workbench/documents/agents", s.url);
    let prior = s.hub.store.document("agents").unwrap();
    let mut value = prior["value"].clone();
    value["bindings"]["large-fixture"] = json!({"seenInputs":["x".repeat(256 * 1024)]});
    let payload = json!({"expected_revision": prior["revision"], "value": value});
    let bytes = serde_json::to_vec(&payload).unwrap();
    assert!(bytes.len() > 128 * 1024);
    let saved: Value = client.post(&url).bearer_auth("admin-test")
        .json(&payload).send().await.unwrap().error_for_status().unwrap()
        .json().await.unwrap();
    assert_eq!(saved["value"]["bindings"]["large-fixture"], value["bindings"]["large-fixture"]);
    assert_eq!(s.hub.store.document("agents").unwrap(), saved);
    assert_eq!(client.post(&url).bearer_auth("admin-test").json(&payload)
        .send().await.unwrap().status(), 400, "optimistic revision check remains active");
    let owner = register(&s, "fixture-owner").await;
    assert_eq!(client.post(&url).bearer_auth(owner.owner_token).json(&payload)
        .send().await.unwrap().status(), 403, "session credentials cannot edit shared registry");
    let mut oversized = bytes.clone();
    oversized.resize(8 * 1024 * 1024 + 1, b' ');
    assert_eq!(client.post(&url).bearer_auth("admin-test")
        .header("content-type", "application/json").body(oversized)
        .send().await.unwrap().status(), 413, "document exception remains bounded");
    assert_eq!(client.post(format!("{}/api/v1/messaging/sessions", s.url))
        .bearer_auth("admin-test").header("content-type", "application/json").body(bytes)
        .send().await.unwrap().status(), 413, "ordinary endpoint limit is unchanged");
    assert_eq!(s.hub.store.document("agents").unwrap(), saved, "rejections never change the registry");
}
