//! Backend-owned extension snapshots and native installers. No frontend runtime dependency.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};
pub const TARGETS: &[(&str, &str)] = &[
    ("dsh", ".agents/skills"),
    ("codex", ".codex/skills"),
    ("claude", ".claude/skills"),
    ("codebuddy", ".codebuddy/skills"),
    ("cursor", ".cursor/skills"),
];
pub fn targets() -> Value {
    TARGETS
        .iter()
        .map(|(key, path)| (key.to_string(), json!(path)))
        .collect()
}
pub fn id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(i, c)| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || i > 0 && matches!(c, b'-' | b'_')
        })
}
pub fn validate(source: &Value) -> Result<Value> {
    let name = source["id"].as_str().context("source id required")?;
    if !id(name) {
        bail!("来源标识需要 1–64 个小写字母、数字、短横线或下划线")
    }
    let kind = source["kind"].as_str().context("source kind required")?;
    let location = source["location"]
        .as_str()
        .context("source location required")?
        .trim();
    if location.is_empty() || location.len() > 4096 || location.contains('\0') {
        bail!("invalid source location")
    }
    match kind {
        "local" if Path::new(location).is_absolute() => {}
        "git"
            if ["https://", "ssh://", "git@"]
                .iter()
                .any(|prefix| location.starts_with(prefix))
                && !location.chars().any(char::is_whitespace) => {}
        _ => bail!("来源需要本地绝对路径或 HTTPS/SSH Git 地址"),
    }
    let subdir = source["subdir"].as_str().unwrap_or(".");
    if subdir.len() > 4096
        || subdir.contains('\0')
        || subdir.contains('\\')
        || Path::new(subdir).components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        bail!("子目录必须位于来源目录内")
    }
    let wanted = source
        .get("targets")
        .cloned()
        .unwrap_or_else(|| json!(TARGETS.iter().map(|(key, _)| key).collect::<Vec<_>>()));
    let rows = wanted.as_array().context("targets must be an array")?;
    if rows.is_empty()
        || rows
            .iter()
            .any(|row| !TARGETS.iter().any(|(key, _)| row.as_str() == Some(key)))
    {
        bail!("请选择有效的同步目标")
    }
    let mut seen = HashSet::new();
    let rows = rows
        .iter()
        .filter(|row| seen.insert(row.to_string()))
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({"id":name,"kind":kind,"location":location,"subdir":subdir,"targets":rows}))
}
pub fn run(root: &Path, executable: &str, args: &[String], seconds: u64) -> Result<String> {
    fs::create_dir_all(root)?;
    let log = root.join(format!("command-{}.log", uuid::Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let output = options.open(&log)?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output)
        .env("GIT_TERMINAL_PROMPT", "0");
    for key in [
        "KODE_BRIDGE_TOKEN",
        "KODE_MESSAGING_ADMIN_TOKEN_FILE",
        "KODE_MESSAGING_TOKEN_FILE",
        "KODE_SESSION_ID",
    ] {
        command.env_remove(key);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .with_context(|| format!("无法启动 {executable}"))?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > Duration::from_secs(seconds) {
            #[cfg(unix)]
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.kill();
            let _ = child.wait();
            bail!("{executable} operation timed out")
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let bytes = fs::read(&log)?;
    let _ = fs::remove_file(&log);
    let text = String::from_utf8_lossy(&bytes[bytes.len().saturating_sub(16384)..])
        .trim()
        .to_string();
    if !status.success() {
        bail!("{executable} failed: {text}")
    }
    Ok(text)
}
fn copy_tree(source: &Path, target: &Path, count: &mut usize, depth: usize) -> Result<()> {
    if depth > 32 {
        bail!("extension source tree is too deep")
    }
    fs::create_dir_all(target)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        if [".git", "node_modules", "target"]
            .iter()
            .any(|name| entry.file_name() == *name)
        {
            continue;
        }
        *count += 1;
        if *count > 30000 {
            bail!("来源文件过多，请缩小目录")
        }
        let from = entry.path();
        let to = target.join(entry.file_name());
        let ty = entry.file_type()?;
        if ty.is_symlink() {
            let link = fs::read_link(&from)?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(link, &to)?;
            #[cfg(not(unix))]
            bail!("symbolic links are unsupported on this Host");
        } else if ty.is_dir() {
            copy_tree(&from, &to, count, depth + 1)?
        } else if ty.is_file() {
            fs::copy(from, to)?;
        } else {
            bail!("unsupported special file in extension source")
        }
    }
    Ok(())
}
fn validate_tree(root: &Path, path: &Path, count: &mut usize, depth: usize) -> Result<()> {
    if depth > 32 {
        bail!("extension source tree is too deep")
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_name() == ".git" {
            continue;
        }
        *count += 1;
        if *count > 30000 {
            bail!("extension source has too many files")
        }
        let ty = entry.file_type()?;
        if ty.is_symlink() && !fs::canonicalize(entry.path())?.starts_with(root) {
            bail!("来源符号链接超出包目录")
        }
        if ty.is_dir() {
            validate_tree(root, &entry.path(), count, depth + 1)?
        }
    }
    Ok(())
}
fn scan(
    root: &Path,
    path: &Path,
    depth: usize,
    count: &mut usize,
    skills: &mut Vec<Value>,
    plugins: &mut Value,
) -> Result<()> {
    *count += 1;
    if depth > 8 || *count > 5000 {
        bail!("插件目录过大，请缩小子目录")
    }
    for target in ["claude", "codebuddy", "cursor", "codex"] {
        let manifest = path.join(format!(".{target}-plugin/plugin.json"));
        if manifest.exists() {
            let value: Value = serde_json::from_slice(&fs::read(manifest)?)?;
            let name = value["name"].as_str().context("plugin name required")?;
            if name.is_empty()
                || name.len() > 128
                || !name.bytes().all(|c| {
                    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'-' | b'_' | b'.')
                })
            {
                bail!("invalid native plugin name")
            }
            plugins[target]
                .as_array_mut()
                .unwrap()
                .push(json!({"name":name,"path":path}));
        }
    }
    let skill = path.join("SKILL.md");
    if skill.is_file() {
        let rel = path.strip_prefix(root)?;
        let name = if rel.as_os_str().is_empty() {
            "package".into()
        } else {
            rel.components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("--")
        };
        if !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
        {
            bail!("invalid skill directory name")
        }
        skills.push(json!({"name":name,"path":path}));
        return Ok(());
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if entry.file_type()?.is_dir()
            && !name.starts_with('.')
            && !["node_modules", "target"].contains(&name.as_ref())
        {
            scan(root, &entry.path(), depth + 1, count, skills, plugins)?
        }
    }
    Ok(())
}
pub fn snapshot(root: &Path, source: &Value) -> Result<(Vec<Value>, Value, Option<String>)> {
    let name = source["id"].as_str().context("source id missing")?;
    let release = root
        .join("sources")
        .join(name)
        .join("releases")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&release)?;
    let package = release.join("package");
    let location = source["location"]
        .as_str()
        .context("source location missing")?;
    let revision = if source["kind"] == "git" {
        run(
            &release,
            "git",
            &[
                "clone".into(),
                "--depth".into(),
                "1".into(),
                "--".into(),
                location.into(),
                package.to_string_lossy().into(),
            ],
            120,
        )?;
        Some(run(
            &release,
            "git",
            &[
                "-C".into(),
                package.to_string_lossy().into(),
                "rev-parse".into(),
                "HEAD".into(),
            ],
            10,
        )?)
    } else {
        let origin = fs::canonicalize(location)?;
        let cache = fs::canonicalize(root)?;
        if cache.starts_with(&origin) || origin.starts_with(&cache) {
            bail!("来源不能包含或位于 Kode 缓存目录内")
        }
        copy_tree(&origin, &package, &mut 0, 0)?;
        None
    };
    let package = fs::canonicalize(package)?;
    validate_tree(&package, &package, &mut 0, 0)?;
    let selected = fs::canonicalize(package.join(source["subdir"].as_str().unwrap_or(".")))?;
    if !selected.starts_with(&package) {
        bail!("子目录超出来源范围")
    }
    let mut skills = vec![];
    let mut plugins = json!({"claude":[],"codebuddy":[],"cursor":[],"codex":[]});
    scan(&selected, &selected, 0, &mut 0, &mut skills, &mut plugins)?;
    if skills.is_empty()
        && plugins
            .as_object()
            .unwrap()
            .values()
            .all(|rows| rows.as_array().unwrap().is_empty())
    {
        bail!("未找到 SKILL.md 或原生插件清单")
    }
    Ok((skills, plugins, revision))
}
fn link_path(link: &Value, key: &str) -> Result<PathBuf> {
    Ok(PathBuf::from(
        link[key].as_str().context("invalid managed link")?,
    ))
}
pub fn desired(home: &Path, source: &Value, skills: &[Value]) -> Result<Vec<Value>> {
    let mut links = vec![];
    let mut seen = HashSet::new();
    for target in source["targets"].as_array().context("targets missing")? {
        let directory = TARGETS
            .iter()
            .find(|(key, _)| target.as_str() == Some(key))
            .context("invalid target")?
            .1;
        let directory = home.join(directory);
        fs::create_dir_all(&directory)?;
        let directory = fs::canonicalize(directory)?;
        for skill in skills {
            let path = directory.join(format!(
                "{}--{}",
                source["id"].as_str().unwrap(),
                skill["name"].as_str().unwrap()
            ));
            if !seen.insert(path.clone()) {
                continue;
            }
            let prior = source["links"].as_array().and_then(|rows| {
                rows.iter()
                    .find(|link| link["path"].as_str() == path.to_str())
            });
            match fs::symlink_metadata(&path) {
                Ok(meta) => {
                    if !meta.file_type().is_symlink()
                        || prior.is_none()
                        || fs::read_link(&path)? != link_path(prior.unwrap(), "to")?
                    {
                        bail!("同步冲突，已有文件已保留：{}", path.display())
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            links.push(json!({"path":path,"to":skill["path"]}));
        }
    }
    Ok(links)
}
fn owned(link: &Value) -> Result<bool> {
    let path = link_path(link, "path")?;
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            Ok(meta.file_type().is_symlink() && fs::read_link(path)? == link_path(link, "to")?)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}
fn make(link: &Value) -> Result<()> {
    #[cfg(unix)]
    std::os::unix::fs::symlink(link_path(link, "to")?, link_path(link, "path")?)?;
    #[cfg(not(unix))]
    bail!("managed skill links unsupported on this Host");
    Ok(())
}
pub fn replace(
    previous: &[Value],
    next: &[Value],
    commit: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let mut removed = vec![];
    let mut created = vec![];
    let operation = (|| {
        for link in previous {
            if owned(link)? {
                fs::remove_file(link_path(link, "path")?)?;
                removed.push(link.clone());
            }
        }
        for link in next {
            make(link)?;
            created.push(link.clone());
        }
        commit()
    })();
    if operation.is_err() {
        for link in created.iter().rev() {
            if owned(link).unwrap_or(false) {
                let _ = fs::remove_file(link_path(link, "path")?);
            }
        }
        for link in removed {
            make(&link)?;
        }
    }
    operation
}
pub fn native_sync(root: &Path, source: &mut Value) -> Result<()> {
    let name = source["id"]
        .as_str()
        .context("source id missing")?
        .to_string();
    let targets = source["targets"]
        .as_array()
        .context("targets missing")?
        .clone();
    source["nativeStatus"] = json!({});
    for target in &targets {
        let target = target.as_str().unwrap();
        let native = source["plugins"][target]
            .as_array()
            .is_some_and(|rows| !rows.is_empty());
        source["nativeStatus"][target] = json!(if native { "ready" } else { "skills-only" });
    }
    let plugins = if targets.contains(&json!("codex")) {
        source["plugins"]["codex"]
            .as_array()
            .cloned()
            .unwrap_or_default()
    } else {
        vec![]
    };
    let selectors = plugins
        .iter()
        .map(|plugin| json!(format!("{}@kode-{name}", plugin["name"].as_str().unwrap())))
        .collect::<Vec<_>>();
    let installed = source["codexInstalled"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for selector in installed {
        if !selectors.contains(&selector) {
            run(
                root,
                "codex",
                &[
                    "plugin".into(),
                    "remove".into(),
                    selector.as_str().unwrap().into(),
                ],
                60,
            )?;
            source["codexInstalled"]
                .as_array_mut()
                .unwrap()
                .retain(|v| v != &selector);
        }
    }
    if plugins.is_empty() {
        return Ok(());
    }
    let marketplace_root = root.join("sources").join(&name);
    let canonical = fs::canonicalize(&marketplace_root)?;
    let mut entries = vec![];
    let mut names = HashSet::new();
    for plugin in &plugins {
        let plugin_name = plugin["name"].as_str().unwrap();
        if !names.insert(plugin_name) {
            bail!("duplicate native plugin name")
        }
        let path = Path::new(plugin["path"].as_str().unwrap()).strip_prefix(&canonical)?;
        entries.push(json!({"name":plugin_name,"source":{"source":"local","path":format!("./{}",path.display())}}));
    }
    fs::create_dir_all(canonical.join(".agents/plugins"))?;
    fs::write(
        canonical.join(".agents/plugins/marketplace.json"),
        serde_json::to_vec(&json!({"name":format!("kode-{name}"),"plugins":entries}))?,
    )?;
    run(
        root,
        "codex",
        &[
            "plugin".into(),
            "marketplace".into(),
            "add".into(),
            canonical.to_string_lossy().into(),
            "--json".into(),
        ],
        60,
    )?;
    source["codexMarketplace"] = json!(format!("kode-{name}"));
    for selector in &selectors {
        run(
            root,
            "codex",
            &[
                "plugin".into(),
                "add".into(),
                selector.as_str().unwrap().into(),
                "--json".into(),
            ],
            60,
        )?;
        if !source["codexInstalled"].is_array() {
            source["codexInstalled"] = json!([])
        }
        let installed = source["codexInstalled"].as_array_mut().unwrap();
        if !installed.contains(selector) {
            installed.push(selector.clone());
        }
    }
    source["nativeStatus"]["codex"] = json!("installed");
    Ok(())
}
pub fn native_remove(root: &Path, source: &mut Value) -> Result<()> {
    let installed = source["codexInstalled"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    for selector in installed {
        run(
            root,
            "codex",
            &[
                "plugin".into(),
                "remove".into(),
                selector.as_str().context("invalid managed plugin")?.into(),
            ],
            60,
        )?;
        source["codexInstalled"]
            .as_array_mut()
            .unwrap()
            .retain(|row| row != &selector);
    }
    if let Some(name) = source["codexMarketplace"].as_str() {
        run(
            root,
            "codex",
            &[
                "plugin".into(),
                "marketplace".into(),
                "remove".into(),
                name.into(),
            ],
            60,
        )?;
        source.as_object_mut().unwrap().remove("codexMarketplace");
    }
    Ok(())
}
