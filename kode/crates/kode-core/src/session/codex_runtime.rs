//! Keep a Kode PTY's hooks and tools in its own Codex process environment.

use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

pub(super) fn isolated_args(command: &str, args: &[String]) -> Result<Vec<String>> {
    // A remote server cannot inherit this PTY's KODE_SESSION_ID either.
    if args
        .iter()
        .any(|arg| arg == "--remote" || arg.starts_with("--remote="))
    {
        bail!("Kode Codex sessions require a local process; remove --remote from the backend arguments");
    }
    if args.iter().any(|arg| arg == "--no-daemon") {
        return Ok(args.to_vec());
    }
    let command = crate::pty::resolve_spawn_command(command);
    static SUPPORT: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let cache = SUPPORT.get_or_init(|| Mutex::new(HashMap::new()));
    let cached = cache.lock().unwrap().get(&command).copied();
    let supported = match cached {
        Some(supported) => supported,
        None => {
            let supported = supports_no_daemon(&command)?;
            cache.lock().unwrap().insert(command, supported);
            supported
        }
    };
    Ok(with_isolation_flag(args, supported))
}

fn with_isolation_flag(args: &[String], supported: bool) -> Vec<String> {
    let mut result = args.to_vec();
    if supported && !result.iter().any(|arg| arg == "--no-daemon") {
        // Must precede `resume` and its positional prompt.
        result.insert(0, "--no-daemon".into());
    }
    result
}

fn supports_no_daemon(command: &str) -> Result<bool> {
    let mut child = Command::new(command)
        .arg("--help")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("inspect Codex process isolation support")?;
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            if !output.status.success() {
                bail!("Codex --help failed while checking process isolation support");
            }
            return Ok(String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .any(|word| word == "--no-daemon"));
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Codex --help timed out while checking process isolation support");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolation_precedes_resume_and_preserves_older_clis() {
        let args = vec![
            "--model".into(),
            "gpt-test".into(),
            "resume".into(),
            "thread-a".into(),
        ];
        assert_eq!(with_isolation_flag(&args, false), args);
        let isolated = with_isolation_flag(&args, true);
        assert_eq!(isolated[0], "--no-daemon");
        assert_eq!(&isolated[1..], &args);
        assert_eq!(with_isolation_flag(&isolated, true), isolated);
    }
}
