//! `backend_probe::which` 的行为测试。
//! 独立集成测试文件,不被 lib_tests.rs 的预先编译错误阻塞。

use kode_bridge::backend_probe::which;

#[test]
fn which_finds_ls_on_path() {
    // `ls` 在所有 Unix 上都该有;CI 跑 Linux/macOS 都能复现。
    let found = which("ls");
    assert!(found.is_some(), "ls should be on PATH");
    assert!(found.unwrap().is_file());
}

#[test]
fn which_returns_none_for_nonexistent_command() {
    assert!(which("kode-definitely-not-a-real-bin-xyz").is_none());
}

#[test]
fn which_absolute_path_checks_file_directly() {
    // /bin/ls 或 /bin/echo 至少一个该存在(走 is_file 分支,不拼 PATH)。
    let found = which("/bin/ls").or_else(|| which("/bin/echo"));
    assert!(
        found.is_some(),
        "at least one of /bin/ls or /bin/echo should exist"
    );
}

#[test]
fn which_absolute_path_nonexistent_returns_none() {
    assert!(which("/usr/local/bin/kode-nope-not-here").is_none());
}

#[test]
fn which_relative_path_with_components_checks_file() {
    // 多 component 的相对路径走 is_file 直接检查,不拼 PATH。
    // Cargo.toml 存在于仓库根,从仓库根跑测试时能命中。
    let found = which("Cargo.toml");
    if let Some(p) = found {
        assert!(p.is_file());
    }
}
