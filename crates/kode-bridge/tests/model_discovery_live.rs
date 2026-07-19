//! Opt-in smoke tests against CLIs installed on the developer machine.
//! Run with: `cargo test -p kode-bridge --test model_discovery_live -- --ignored --nocapture`

#[tokio::test]
#[ignore = "requires Codex CLI"]
async fn discovers_installed_codex_models() {
    let result = kode_bridge::model_discovery::discover_models("codex", "codex")
        .await
        .expect("Codex model discovery");
    assert!(!result.models.is_empty());
    eprintln!("Codex: {} models", result.models.len());
}

#[tokio::test]
#[ignore = "requires CodeBuddy CLI"]
async fn discovers_installed_codebuddy_models() {
    let result = kode_bridge::model_discovery::discover_models("codebuddy", "codebuddy")
        .await
        .expect("CodeBuddy model discovery");
    assert!(!result.models.is_empty());
    eprintln!("CodeBuddy: {} models", result.models.len());
}
