//! Isolated real-CLI smoke test. Never attaches to an existing desktop session
//! or sends an agent prompt. Select model ids from the installed CLI catalogue.
#![cfg(unix)]
use kode_core::{
    config::Config,
    session::{state::Status, Session},
};
use std::{path::PathBuf, time::Duration};

#[tokio::test]
#[ignore = "requires installed authenticated CLI and explicit model ids"]
async fn switches_model_in_isolated_cli_session() {
    let backend_key = std::env::var("KODE_TEST_MODEL_BACKEND").expect("backend");
    let initial = std::env::var("KODE_TEST_MODEL_INITIAL").expect("initial model");
    let target = std::env::var("KODE_TEST_MODEL_TARGET").expect("target model");
    let cwd = PathBuf::from(std::env::var("KODE_TEST_MODEL_CWD").expect("trusted cwd"));
    let config = Config::load();
    let backend = config
        .backend(&backend_key)
        .expect("configured backend")
        .clone();
    let ctx = kode_bridge::build_test_ctx(config, "test".into());
    if std::env::var("KODE_TEST_MODEL_TRANSPORT").as_deref() == Ok("acp") {
        let client = kode_bridge::acp::Client::start(
            ctx.clone(),
            991,
            &backend,
            &backend_key,
            &cwd,
            None,
            Some(&initial),
            None,
        )
        .await
        .expect("start isolated ACP agent");
        ctx.sessions.lock().insert(
            991,
            Session::structured(
                991,
                &backend_key,
                &backend.command,
                &cwd,
                client.session_id(),
                initial.clone(),
            ),
        );
        let result = client.set_model(&target).await;
        eprintln!("ACP model switch: {result:?}");
        let restored = client.set_model(&initial).await;
        eprintln!("ACP restore initial model: {restored:?}");
        drop(client);
        ctx.sessions.lock().remove(&991);
        assert_eq!(result, Ok(()));
        assert_eq!(restored, Ok(()));
        return;
    }
    let session = Session::new(
        991,
        &backend_key,
        &backend,
        140,
        40,
        Duration::from_millis(1200),
        1000,
        &cwd,
        ctx.core_tx.clone(),
        None,
        None,
        Some(&initial),
        false,
        None,
        &[],
        None,
    )
    .expect("spawn test session");
    ctx.sessions.lock().insert(991, session);
    let ready = tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if ctx.sessions.lock().get(&991).is_some_and(|s| {
                s.has_empty_model_command_prompt() && s.state.status == Status::Idle
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    })
    .await;
    if ready.is_err() {
        let session = ctx.sessions.lock().remove(&991).unwrap();
        eprintln!("Test CLI startup screen:\n{}", session.screen_text());
        let screen = session.parser.screen();
        eprintln!(
            "cursor={:?}, status={:?}",
            screen.cursor_position(),
            session.state.status
        );
        eprintln!(
            "model prompt position={:?}",
            session.model_command_prompt_position()
        );
        let (row, col) = session
            .model_command_prompt_position()
            .unwrap_or(screen.cursor_position());
        for column in col.saturating_sub(4)..(col + 12).min(screen.size().1) {
            if let Some(cell) = screen.cell(row, column) {
                eprintln!(
                    "{column}: {:?} dim={} fg={:?}",
                    cell.contents(),
                    cell.dim(),
                    cell.fgcolor()
                );
            }
        }
        panic!("native CLI did not reach an empty idle prompt");
    }
    let result = kode_bridge::set_session_model(&ctx, 991, &target).await;
    let screen = ctx.sessions.lock().get(&991).unwrap().screen_text();
    eprintln!("{backend_key} switch result: {result:?}\n{screen}");
    if ctx
        .sessions
        .lock()
        .get(&991)
        .unwrap()
        .has_empty_model_command_prompt()
    {
        tokio::time::sleep(Duration::from_millis(1600)).await;
        let restored = kode_bridge::set_session_model(&ctx, 991, &initial).await;
        eprintln!("Restore initial model: {restored:?}");
        if restored.is_err() {
            let session = ctx.sessions.lock().remove(&991).unwrap();
            eprintln!("Restore screen:\n{}", session.screen_text());
            panic!("could not restore initial model");
        }
    }
    ctx.sessions.lock().remove(&991);
    assert_eq!(result, Ok(()));
}
