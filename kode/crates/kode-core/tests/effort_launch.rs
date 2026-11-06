//! Real PTY argv capture; no model executable or provider credentials.
use kode_core::effort::{EffortAdapter, EffortConfig};
use kode_core::{BackendConfig, Config, Session};
use std::time::Duration;
fn backend(script: &std::path::Path, adapter: EffortAdapter) -> BackendConfig {
    let mut config = Config::default().backends["codex"].clone();
    config.protocol = Some("raw".into());
    config.command = "/bin/sh".into();
    config.args = vec![script.to_string_lossy().into()];
    config.default_model = Some("fixture-model".into());
    config.model_flag = Some("--model".into());
    config.permission_mode_flag = None;
    config.effort = Some(EffortConfig {
        default: Some("high".into()),
        levels: vec!["high".into()],
        adapter,
    });
    config
}
#[tokio::test]
async fn configured_effort_reaches_pty_without_a_prompt() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("capture.sh");
    std::fs::write(&script, "printf '%s\\n' \"$@\" > \"$EFFORT_CAPTURE\"\n").unwrap();
    for (i, adapter, expected) in [
        (
            0,
            EffortAdapter::Flag {
                flag: "--effort".into(),
            },
            vec!["--model", "fixture-model", "--effort", "high"],
        ),
        (
            1,
            EffortAdapter::ConfigOverride {
                flag: "-c".into(),
                key: "reasoning_effort".into(),
            },
            vec![
                "--model",
                "fixture-model",
                "-c",
                "reasoning_effort=\"high\"",
            ],
        ),
        (
            2,
            EffortAdapter::ModelSuffix {
                prefix: "[effort=".into(),
                suffix: "]".into(),
            },
            vec!["--model", "fixture-model[effort=high]"],
        ),
    ] {
        let capture = root.path().join(format!("capture-{i}"));
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let _session = Session::new(
            700 + i,
            "fixture",
            &backend(&script, adapter),
            80,
            24,
            Duration::from_secs(1),
            100,
            root.path(),
            tx,
            None,
            None,
            None,
            false,
            None,
            &[("EFFORT_CAPTURE".into(), capture.to_string_lossy().into())],
            None,
        )
        .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Ok(content) = std::fs::read_to_string(&capture) {
                    if !content.is_empty() {
                        assert_eq!(content.lines().collect::<Vec<_>>(), expected);
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
    }
}
#[tokio::test]
async fn unsupported_effort_rejects_before_child_creation() {
    let root = tempfile::tempdir().unwrap();
    let marker = root.path().join("must-not-exist");
    let script = root.path().join("capture.sh");
    std::fs::write(&script, "touch \"$EFFORT_CAPTURE\"\n").unwrap();
    let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
    let result = Session::new(
        710,
        "fixture",
        &backend(
            &script,
            EffortAdapter::TurnRpc {
                field: "effort".into(),
            },
        ),
        80,
        24,
        Duration::from_secs(1),
        100,
        root.path(),
        tx,
        None,
        None,
        None,
        false,
        None,
        &[("EFFORT_CAPTURE".into(), marker.to_string_lossy().into())],
        None,
    );
    assert!(result.is_err());
    assert!(!marker.exists());
}
