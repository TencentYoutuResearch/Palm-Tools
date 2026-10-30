//! Isolated real-CLI smoke test for native permission switching. Never
//! attaches to an existing desktop session or sends an agent prompt.
#![cfg(unix)]
use kode_core::{
    config::Config,
    session::{state::Status, Session},
};
use std::{path::PathBuf, time::Duration};

#[tokio::test]
#[ignore = "requires an installed authenticated CLI and a trusted cwd"]
async fn switches_permission_in_isolated_cli_session() {
    let backend_key = std::env::var("KODE_TEST_PERMISSION_BACKEND").expect("backend");
    let cwd = PathBuf::from(std::env::var("KODE_TEST_PERMISSION_CWD").expect("trusted cwd"));
    let config = Config::load();
    let backend = config.backend(&backend_key).expect("configured backend").clone();
    let ctx = kode_bridge::build_test_ctx(config, "test".into());
    let session = Session::new(
        992, &backend_key, &backend, 140, 40, Duration::from_millis(1200), 1000, &cwd,
        ctx.core_tx.clone(), None, None, None, false, None, &[], None,
    )
    .expect("spawn test session");
    ctx.sessions.lock().insert(992, session);
    tokio::time::timeout(Duration::from_secs(30), async {
        while !ctx.sessions.lock().get(&992).is_some_and(|s| {
            s.has_empty_model_command_prompt() && s.state.status == Status::Idle
        }) {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await
    .unwrap_or_else(|_| {
        panic!("CLI not ready:\n{}", ctx.sessions.lock()[&992].screen_text())
    });
    let mut results = vec![];
    for mode in ["bypassPermissions", "default"] {
        let result = kode_bridge::set_session_permission_mode(&ctx, 992, mode).await;
        let screen = ctx.sessions.lock()[&992].screen_text();
        eprintln!("{backend_key} -> {mode}: {result:?}\n{screen}");
        results.push(result.map(|(mode, _)| mode));
    }
    if let Some(session) = ctx.sessions.lock().remove(&992) {
        session.pty.as_ref().unwrap().kill();
    }
    assert_eq!(results, vec![Ok("bypassPermissions".to_string()), Ok("default".to_string())]);
}
