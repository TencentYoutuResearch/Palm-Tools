//! Inspect and update the installation an Agent profile actually resolves to.
use super::{extension_files, Hub};
use anyhow::{bail, Context, Result};
use futures_util::{stream, StreamExt};
use parking_lot::Mutex;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const CACHE_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(super) struct AgentUpdates {
    cache: Mutex<HashMap<PathBuf, (Instant, Status)>>,
    update: tokio::sync::Mutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Status {
    current: Option<Version>,
    latest: Option<Version>,
    can_update: bool,
    update_available: bool,
    issue: Option<&'static str>,
}

impl Status {
    fn unavailable(issue: &'static str) -> Self {
        Self {
            current: None,
            latest: None,
            can_update: false,
            update_available: false,
            issue: Some(issue),
        }
    }
}

#[derive(Deserialize)]
pub(super) struct Request {
    #[serde(default)]
    pub profile_ids: Vec<String>,
    pub refresh: Option<bool>,
    pub update_profile: Option<String>,
}

#[derive(Deserialize)]
struct Profile {
    id: String,
    executable: Option<String>,
    #[serde(default)]
    env: HashMap<String, String>,
}

enum Installer {
    Npm {
        npm: PathBuf,
        prefix: PathBuf,
        package: &'static str,
    },
    Codex,
    Claude,
    Cursor,
    Brew {
        brew: PathBuf,
        kind: &'static str,
        token: &'static str,
    },
}

struct Installation {
    command: PathBuf,
    path: OsString,
    installer: Option<Installer>,
}

fn resolve(profile: &Profile, home: &Path) -> Option<Installation> {
    let name = Path::new(profile.executable.as_deref()?);
    let path = profile
        .env
        .get("PATH")
        .map(OsString::from)
        .or_else(|| std::env::var_os("PATH"))?;
    let command = if name.is_absolute() {
        name.to_owned()
    } else {
        if name.components().count() != 1 {
            return None;
        }
        std::env::split_paths(&path)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join(name))
            .find(|path| executable(path))?
    };
    if !executable(&command) {
        return None;
    }
    let canonical = fs::canonicalize(&command).ok()?;
    let installer = npm_installation(&command, &canonical)
        .or_else(|| brew_installation(&canonical))
        .or_else(|| {
            if command == home.join(".local/bin/codex")
                && canonical.starts_with(home.join(".codex/packages/standalone/releases"))
            {
                Some(Installer::Codex)
            } else if command == home.join(".local/bin/claude")
                && canonical.starts_with(home.join(".local/share/claude/versions"))
            {
                Some(Installer::Claude)
            } else if ["agent", "cursor-agent"]
                .iter()
                .any(|file| command == home.join(".local/bin").join(file))
                && canonical.starts_with(home.join(".local/share/cursor-agent/versions"))
            {
                Some(Installer::Cursor)
            } else {
                None
            }
        });
    Some(Installation {
        command,
        path,
        installer,
    })
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

fn npm_installation(command: &Path, canonical: &Path) -> Option<Installer> {
    const PACKAGES: &[&str] = &[
        "@openai/codex",
        "@anthropic-ai/claude-code",
        "@tencent-ai/codebuddy-code",
        "@tencent/tclaude",
        "@tencent/tcodex",
    ];
    let bin = command.parent()?;
    let prefix = fs::canonicalize(bin.parent()?).ok()?;
    if bin.file_name()?.to_str()? != "bin" {
        return None;
    }
    let npm = bin.join("npm");
    if !executable(&npm) {
        return None;
    }
    let root = prefix.join("lib/node_modules");
    let package = PACKAGES
        .iter()
        .copied()
        .find(|name| canonical.starts_with(root.join(name)))?;
    let manifest: Value =
        serde_json::from_slice(&fs::read(root.join(package).join("package.json")).ok()?).ok()?;
    if manifest["name"].as_str()? != package {
        return None;
    }
    Some(Installer::Npm {
        npm,
        prefix,
        package,
    })
}

fn brew_installation(executable: &Path) -> Option<Installer> {
    let root = executable.ancestors().find(|path| {
        matches!(
            path.file_name().and_then(|name| name.to_str()),
            Some("Caskroom" | "Cellar")
        )
    })?;
    let package = executable
        .strip_prefix(root)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()?;
    let token = ["codex", "claude-code", "codebuddy-code"]
        .into_iter()
        .find(|token| *token == package)?;
    let kind = if root.ends_with("Caskroom") {
        "--cask"
    } else {
        "--formula"
    };
    let brew = root.parent()?.join("bin/brew");
    if !self::executable(&brew) {
        return None;
    }
    Some(Installer::Brew { brew, kind, token })
}

fn parse_version(output: &str) -> Option<Version> {
    output
        .split(|ch: char| ch.is_whitespace() || matches!(ch, '"' | '(' | ')' | ','))
        .find_map(|word| Version::parse(word.strip_prefix('v').unwrap_or(word)).ok())
}

fn newer(current: &Version, latest: &Version, installer: &Installer) -> bool {
    if matches!(installer, Installer::Cursor) {
        // A Cursor build hash is an identity, not an ordered prerelease number.
        let date = |version: &Version| (version.major, version.minor, version.patch);
        date(latest) > date(current)
            || date(latest) == date(current)
                && (latest.pre != current.pre || latest.build != current.build)
    } else {
        latest.cmp_precedence(current).is_gt()
    }
}

async fn run(
    root: &Path,
    command: &Path,
    args: Vec<String>,
    path: &OsString,
    seconds: u64,
) -> Result<String> {
    let root = root.to_owned();
    let command = command.to_owned();
    let path = path.clone();
    tokio::task::spawn_blocking(move || {
        extension_files::run_with_path(
            &root,
            command.to_str().context("invalid executable path")?,
            &args,
            seconds,
            Some(&path),
        )
    })
    .await?
}

impl Installation {
    async fn version(&self, root: &Path) -> Option<Version> {
        let mut path = vec![self.command.parent()?.to_owned()];
        path.extend(std::env::split_paths(&self.path));
        let path = std::env::join_paths(path).ok()?;
        let output = run(root, &self.command, vec!["--version".into()], &path, 5)
            .await
            .ok()?;
        if matches!(self.installer, Some(Installer::Cursor)) {
            output.split_whitespace().find_map(cursor_build)
        } else {
            parse_version(&output)
        }
    }

    async fn latest(&self, root: &Path, home: &Path, installer: &Installer) -> Option<Version> {
        match installer {
            Installer::Npm { npm, package, .. } => {
                let path = std::env::join_paths(
                    std::iter::once(npm.parent()?.to_owned())
                        .chain(std::env::split_paths(&self.path)),
                )
                .ok()?;
                let output = run(
                    root,
                    npm,
                    vec![
                        "view".into(),
                        format!("{package}@latest"),
                        "version".into(),
                        "--json".into(),
                        "--fetch-retries=0".into(),
                    ],
                    &path,
                    12,
                )
                .await
                .ok()?;
                let value = output
                    .lines()
                    .rev()
                    .find_map(|line| serde_json::from_str::<String>(line).ok())?;
                Version::parse(&value).ok()
            }
            Installer::Brew { brew, kind, token } => {
                let output = run(
                    root,
                    brew,
                    vec![
                        "info".into(),
                        "--json=v2".into(),
                        (*kind).into(),
                        (*token).into(),
                    ],
                    &self.path,
                    15,
                )
                .await
                .ok()?;
                let info: Value = serde_json::from_str(&output).ok()?;
                let version = if *kind == "--cask" {
                    &info["casks"][0]["version"]
                } else {
                    &info["formulae"][0]["versions"]["stable"]
                };
                Version::parse(version.as_str()?).ok()
            }
            Installer::Codex => {
                let release: Value = serde_json::from_str(
                    &download("https://api.github.com/repos/openai/codex/releases/latest").await?,
                )
                .ok()?;
                let version = release["tag_name"].as_str()?;
                Version::parse(version.trim_start_matches("rust-v")).ok()
            }
            Installer::Claude => {
                let settings = fs::read(home.join(".claude/settings.json"))
                    .ok()
                    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
                let channel = if settings
                    .as_ref()
                    .and_then(|s| s["autoUpdatesChannel"].as_str())
                    == Some("stable")
                {
                    "stable"
                } else {
                    "latest"
                };
                let url = format!("https://downloads.claude.ai/claude-code-releases/{channel}");
                Version::parse(download(&url).await?.trim()).ok()
            }
            Installer::Cursor => cursor_version(&download("https://cursor.com/install").await?),
        }
    }

    async fn status(&self, root: &Path, home: &Path) -> Status {
        let Some(current) = self.version(root).await else {
            return Status::unavailable("version");
        };
        let Some(installer) = &self.installer else {
            return Status {
                current: Some(current),
                ..Status::unavailable("manual")
            };
        };
        let latest = self.latest(root, home, installer).await;
        let update_available = latest
            .as_ref()
            .is_some_and(|latest| newer(&current, latest, installer));
        let issue = latest.is_none().then_some("registry");
        Status {
            current: Some(current),
            latest,
            can_update: true,
            update_available,
            issue,
        }
    }

    async fn upgrade(&self, root: &Path, installer: &Installer, version: &Version) -> Result<()> {
        let (command, args) = match installer {
            Installer::Npm {
                npm,
                prefix,
                package,
            } => (
                npm,
                vec![
                    "install".into(),
                    "--global".into(),
                    "--prefix".into(),
                    prefix.to_str().context("invalid npm prefix")?.into(),
                    format!("{package}@{version}"),
                    "--no-audit".into(),
                    "--no-fund".into(),
                ],
            ),
            Installer::Brew { brew, kind, token } => (
                brew,
                vec!["upgrade".into(), (*kind).into(), (*token).into()],
            ),
            Installer::Codex | Installer::Claude | Installer::Cursor => {
                (&self.command, vec!["update".into()])
            }
        };
        let path = std::env::join_paths(
            std::iter::once(
                command
                    .parent()
                    .context("missing CLI directory")?
                    .to_owned(),
            )
            .chain(std::env::split_paths(&self.path)),
        )?;
        // Cursor downloads the complete CLI archive; a slow but healthy download can take several minutes.
        let timeout = if matches!(installer, Installer::Cursor) {
            3600
        } else {
            180
        };
        run(root, command, args, &path, timeout)
            .await
            .map_err(|error| anyhow::anyhow!(upgrade_failure(&format!("{error:#}"))))?;
        Ok(())
    }
}

// Report actionable categories without forwarding installer output (which may contain credentials).
fn upgrade_failure(error: &str) -> &'static str {
    let reason = error.to_ascii_lowercase();
    if ["timed out", "etimedout", "timeout"]
        .iter()
        .any(|s| reason.contains(s))
    {
        "更新超时，请检查下载连接后重试。"
    } else if [
        "permission denied",
        "eacces",
        "eperm",
        "read-only file system",
    ]
    .iter()
    .any(|s| reason.contains(s))
    {
        "更新失败，安装目录缺少写入权限。"
    } else if ["checksum", "integrity", "signature verification"]
        .iter()
        .any(|s| reason.contains(s))
    {
        "更新失败，安装包校验未通过。"
    } else if [
        "curl:",
        "could not resolve",
        "connection refused",
        "econnreset",
        "enotfound",
    ]
    .iter()
    .any(|s| reason.contains(s))
    {
        "更新失败，无法从发布源下载，请检查网络连接。"
    } else if reason.contains("no space left") || reason.contains("enospc") {
        "更新失败，磁盘空间不足。"
    } else {
        "更新失败，请检查安装权限和发布源后重试。"
    }
}

async fn download(url: &str) -> Option<String> {
    let client = reqwest::Client::builder()
        .user_agent("Kode Agent version check")
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let mut response = client.get(url).send().await.ok()?.error_for_status().ok()?;
    let mut bytes = Vec::new();
    while let Some(part) = response.chunk().await.ok()? {
        if bytes.len() + part.len() > 128 * 1024 {
            return None;
        }
        bytes.extend_from_slice(&part);
    }
    String::from_utf8(bytes).ok()
}

// Cursor uses zero-padded calendar dates, which are not valid semver components.
fn cursor_build(build: &str) -> Option<Version> {
    let (date, hash) = build.split_once('-')?;
    let mut parts = date.split('.');
    let year = parts.next()?;
    let month = parts.next()?.parse::<u8>().ok()?;
    let day = parts.next()?.parse::<u8>().ok()?;
    if year.len() != 4
        || parts.next().is_some()
        || !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hash.is_empty()
        || !hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    // Build metadata accepts numeric hashes with leading zeroes, unlike semver prereleases.
    let mut version = Version::new(year.parse().ok()?, month.into(), day.into());
    if let Ok(pre) = semver::Prerelease::new(hash) {
        version.pre = pre;
    } else {
        version.build = semver::BuildMetadata::new(hash).ok()?;
    }
    Some(version)
}

fn cursor_version(script: &str) -> Option<Version> {
    let prefix = "DOWNLOAD_URL=\"https://downloads.cursor.com/lab/";
    let version = script
        .lines()
        .find_map(|line| line.strip_prefix(prefix))?
        .split('/')
        .next()?;
    cursor_build(version)
}

impl AgentUpdates {
    async fn inspect(
        &self,
        installation: &Installation,
        root: &Path,
        home: &Path,
        force: bool,
    ) -> Status {
        let key = &installation.command;
        if !force {
            if let Some((instant, status)) = self.cache.lock().get(key) {
                if instant.elapsed() < CACHE_TTL {
                    return status.clone();
                }
            }
        }
        let status = installation.status(root, home).await;
        let mut cache = self.cache.lock();
        cache.retain(|_, (time, _)| time.elapsed() < CACHE_TTL);
        cache.insert(key.clone(), (Instant::now(), status.clone()));
        status
    }

    pub(super) async fn execute(
        &self,
        hub: &Hub,
        request: Request,
    ) -> Result<HashMap<String, Status>> {
        if request.profile_ids.len() > 100 {
            bail!("Agent 列表过长");
        }
        let state = hub.store.document("agents")?;
        let profiles: Vec<Profile> = serde_json::from_value(state["value"]["profiles"].clone())?;
        let home = &hub.extensions.home;
        let root = hub.extensions.root.join("cli-versions");
        if let Some(id) = request.update_profile {
            let _lock = self
                .update
                .try_lock()
                .map_err(|_| anyhow::anyhow!("有 Agent 正在更新，请稍候。"))?;
            let profile = profiles
                .iter()
                .find(|p| p.id == id)
                .context("Agent 配置不存在")?;
            let installation = resolve(profile, home).context("找不到此 Agent 的可执行文件")?;
            let installer = installation
                .installer
                .as_ref()
                .context("请使用此 Agent 的安装工具更新")?;
            let status = self.inspect(&installation, &root, home, true).await;
            let latest = status
                .latest
                .as_ref()
                .context("无法读取此安装渠道的可用版本")?;
            if status.update_available {
                installation.upgrade(&root, installer, latest).await?;
                self.cache.lock().clear();
                let result = resolve(profile, home).context("更新后找不到可执行文件")?;
                let installed = self.inspect(&result, &root, home, true).await;
                if !status
                    .current
                    .as_ref()
                    .zip(installed.current.as_ref())
                    .is_some_and(|(old, new)| newer(old, new, installer))
                {
                    bail!("更新后没有读取到更高的 CLI 版本，请检查安装渠道。");
                }
                return Ok(HashMap::from([(id, installed)]));
            }
            return Ok(HashMap::from([(id, status)]));
        }
        let mut jobs = HashMap::<PathBuf, (Installation, Vec<String>)>::new();
        let mut output = HashMap::new();
        for profile in profiles
            .iter()
            .filter(|p| request.profile_ids.contains(&p.id))
        {
            if profile.executable.is_none() {
                continue;
            }
            if let Some(installation) = resolve(profile, home) {
                jobs.entry(installation.command.clone())
                    .or_insert_with(|| (installation, Vec::new()))
                    .1
                    .push(profile.id.clone());
            } else {
                output.insert(profile.id.clone(), Status::unavailable("missing"));
            }
        }
        let refresh = request.refresh.unwrap_or(false);
        let mut statuses = stream::iter(jobs.into_values().map(|(installation, ids)| {
            let root = &root;
            async move { (self.inspect(&installation, root, home, refresh).await, ids) }
        }))
        .buffer_unordered(6);
        while let Some((installation, ids)) = statuses.next().await {
            for id in ids {
                output.insert(id, installation.clone());
            }
        }
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_failure_classifies_installer_errors_without_exposing_output() {
        assert!(upgrade_failure("npm EACCES (private registry URL)").contains("权限"));
        assert!(upgrade_failure("curl: (28) connection timed out").contains("超时"));
        assert!(upgrade_failure("curl: (6) Could not resolve host").contains("下载"));
        assert!(upgrade_failure("checksum mismatch").contains("校验"));
        assert!(upgrade_failure("ENOSPC").contains("空间"));
        assert!(!upgrade_failure("private registry URL").contains("private"));
    }

    #[test]
    fn versions_respect_semver_and_cursor_build_dates() {
        let current = parse_version("codex-cli 0.9.12").unwrap();
        let latest = parse_version("\"0.10.1\"").unwrap();
        assert!(newer(&current, &latest, &Installer::Claude));
        assert!(!newer(&latest, &current, &Installer::Claude));
        let current = parse_version("2026.11.21-fffffff").unwrap();
        let latest = cursor_version("DOWNLOAD_URL=\"https://downloads.cursor.com/lab/2026.11.21-aaaaaaa/darwin/arm64/agent-cli-package.tar.gz\"").unwrap();
        assert!(newer(&current, &latest, &Installer::Cursor));
        assert!(cursor_version("download=unrecognized").is_none());
        let previous = cursor_build("2026.09.02-c22c1a3").unwrap();
        assert!(newer(&previous, &latest, &Installer::Cursor));
        assert!(newer(
            &cursor_build("2026.09.02-0000123").unwrap(),
            &previous,
            &Installer::Cursor
        ));
    }

    #[cfg(unix)]
    #[test]
    fn npm_detection_keeps_the_configured_prefix() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        let package = root.path().join("lib/node_modules/@openai/codex");
        let command = bin.join("codex");
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&package).unwrap();
        let target = package.join("codex.js");
        fs::write(&target, "").unwrap();
        fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
        fs::write(bin.join("npm"), "").unwrap();
        for path in [&target, &bin.join("npm")] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        symlink(&target, &command).unwrap();
        let installation = resolve(
            &Profile {
                id: "codex".into(),
                executable: Some(command.to_string_lossy().into()),
                env: HashMap::new(),
            },
            root.path(),
        )
        .unwrap();
        assert!(
            matches!(installation.installer, Some(Installer::Npm { prefix, package: "@openai/codex", .. }) if prefix == root.path().canonicalize().unwrap())
        );
        assert!(npm_installation(&command, &bin.join("another-command")).is_none());
    }
}
