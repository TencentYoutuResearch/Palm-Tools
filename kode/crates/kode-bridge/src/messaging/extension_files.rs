//! Backend-owned extension snapshots and native installers. No frontend runtime dependency.
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
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
            {
                // Windows symlinks require elevated/Developer Mode and often
                // fail. A plugin snapshot only needs the linked content, so
                // materialize it as a regular file/directory instead.
                let target = if link.is_absolute() {
                    link
                } else {
                    from.parent().unwrap_or_else(|| Path::new(".")).join(link)
                };
                if target.is_dir() {
                    copy_tree(&target, &to, count, depth + 1)?;
                } else {
                    fs::copy(target, to)?;
                }
            }
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
fn display_text(value: &Value, limit: usize) -> Option<String> {
    let text = value.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.chars().take(limit).collect())
}
fn at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter().try_fold(value, |current, key| current.get(*key))
}
fn display_at(value: &Value, path: &[&str], limit: usize) -> Option<String> {
    display_text(at(value, path)?, limit)
}
fn first_display(values: &[Option<String>]) -> Option<String> {
    values.iter().find_map(|value| value.clone())
}
fn optional_json(path: &Path) -> Option<Value> {
    if fs::metadata(path).ok()?.len() > 256 * 1024 {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}
fn frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    let Some(bytes) = fs::read(path).ok() else { return (None, None) };
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(64 * 1024)]);
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let mut name = None;
    let mut description = None;
    let mut folded = false;
    let mut folded_lines = vec![];
    for line in lines {
        let line = line.trim_end();
        if folded {
            if line.trim() == "---" {
                break;
            }
            if line.starts_with(char::is_whitespace) {
                if !line.trim().is_empty() {
                    folded_lines.push(line.trim().to_string());
                }
                continue;
            }
            folded = false;
        }
        if line.trim() == "---" {
            break;
        }
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        if key.trim() == "description" && matches!(value.trim(), ">" | ">-" | ">+" | "|" | "|-" | "|+") {
            folded = true;
            description = None;
            continue;
        }
        let value = Value::String(value.trim().trim_matches(['"', '\'']).to_string());
        match key.trim() {
            "name" => name = display_text(&value, 128),
            "description" => description = display_text(&value, 2000),
            _ => {}
        }
    }
    if !folded_lines.is_empty() {
        description = display_text(&Value::String(folded_lines.join(" ")), 2000);
    }
    (name, description)
}
fn safe_relative(path: &Path) -> Option<String> {
    let mut parts = vec![];
    for part in path.components() {
        match part {
            Component::Normal(value) => parts.push(value.to_string_lossy().to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    Some(if parts.is_empty() { ".".into() } else { parts.join("/") })
}
fn package_logo(path: &Path, mut candidates: Vec<Option<String>>) -> Option<String> {
    candidates.push(Some("./assets/logo.png".into()));
    let root = fs::canonicalize(path).ok()?;
    for candidate in candidates.into_iter().flatten() {
        if candidate.contains('\\') || candidate.contains('\0') {
            continue;
        }
        let Some(relative) = safe_relative(Path::new(&candidate)) else { continue };
        if relative == "." {
            continue;
        }
        let file = root.join(&relative);
        let Ok(real) = fs::canonicalize(&file) else { continue };
        if !real.starts_with(&root) {
            continue;
        }
        let extension = real.extension().and_then(|v| v.to_str()).unwrap_or("").to_ascii_lowercase();
        if !["png", "jpg", "jpeg", "webp"].contains(&extension.as_str()) {
            continue;
        }
        let Ok(meta) = fs::metadata(&real) else { continue };
        if meta.is_file() && meta.len() <= 4 * 1024 * 1024 {
            return Some(relative);
        }
    }
    None
}
fn collect_mcp(value: &Value, rows: &mut BTreeMap<String, String>) {
    let servers = value.get("mcpServers").unwrap_or(value);
    let Some(servers) = servers.as_object() else { return };
    for (name, config) in servers {
        if rows.len() >= 64 || name.is_empty() || name.len() > 128 || !config.is_object() {
            continue;
        }
        let transport = display_text(&config["type"], 32).unwrap_or_else(|| {
            if config.get("url").is_some() {
                "http".into()
            } else if config.get("command").is_some() {
                "stdio".into()
            } else {
                "unknown".into()
            }
        });
        rows.entry(name.clone()).or_insert(transport);
    }
}
fn referenced_json(path: &Path, reference: &str) -> Option<Value> {
    if reference.contains('\\') || reference.contains('\0') {
        return None;
    }
    let relative = safe_relative(Path::new(reference))?;
    if relative == "." {
        return None;
    }
    let root = fs::canonicalize(path).ok()?;
    let file = fs::canonicalize(root.join(relative)).ok()?;
    if !file.starts_with(root) {
        return None;
    }
    optional_json(&file)
}
fn mcp_preview(path: &Path, manifests: &[Value]) -> Value {
    let mut rows = BTreeMap::new();
    let mut referenced = false;
    for manifest in manifests {
        let Some(servers) = manifest.get("mcpServers") else { continue };
        if let Some(reference) = servers.as_str() {
            referenced = true;
            if let Some(value) = referenced_json(path, reference) {
                collect_mcp(&value, &mut rows);
            }
        } else {
            collect_mcp(manifest, &mut rows);
        }
    }
    if !referenced {
        for name in ["mcp.json", ".mcp.json"] {
            if let Some(value) = optional_json(&path.join(name)) {
                collect_mcp(&value, &mut rows);
            }
        }
    }
    rows.into_iter().map(|(name, kind)| json!({"name":name,"type":kind})).collect()
}
fn collect_hooks(value: &Value, rows: &mut BTreeMap<String, Option<String>>) {
    let Some(hooks) = value.get("hooks").and_then(Value::as_object) else { return };
    let description = display_text(&value["description"], 2000);
    for (event, entries) in hooks {
        if rows.len() >= 128 || event.is_empty() || event.len() > 128 || !entries.is_array() {
            continue;
        }
        rows.entry(event.clone()).or_insert_with(|| description.clone());
    }
}
fn hooks_preview(path: &Path, manifests: &[Value]) -> Value {
    let mut rows = BTreeMap::new();
    let mut referenced = false;
    for manifest in manifests {
        let Some(hooks) = manifest.get("hooks") else { continue };
        if let Some(reference) = hooks.as_str() {
            referenced = true;
            if let Some(value) = referenced_json(path, reference) {
                collect_hooks(&value, &mut rows);
            }
        } else {
            collect_hooks(manifest, &mut rows);
        }
    }
    if !referenced {
        if let Some(value) = optional_json(&path.join("hooks/hooks.json")) {
            collect_hooks(&value, &mut rows);
        }
    }
    rows.into_iter().map(|(name, description)| json!({"name":name,"description":description})).collect()
}
fn rules_preview(path: &Path) -> Value {
    let Ok(entries) = fs::read_dir(path.join("rules")) else { return json!([]) };
    let mut rows = BTreeMap::new();
    for path in entries.filter_map(|entry| entry.ok().map(|entry| entry.path())) {
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("");
        if !["md", "mdc"].contains(&extension)
            || path.file_name().and_then(|value| value.to_str()).unwrap_or("").starts_with('.')
        {
            continue;
        }
        let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("rule").to_string();
        let (name, description) = frontmatter(&path);
        rows.entry(fallback.clone()).or_insert_with(|| {
            json!({"name":name.unwrap_or(fallback),"description":description})
        });
    }
    rows.into_values().take(500).collect()
}
fn agents_preview(path: &Path) -> Value {
    let Ok(entries) = fs::read_dir(path.join("agents")) else { return json!([]) };
    let mut files = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("md")
                && !path.file_name().and_then(|value| value.to_str()).unwrap_or("").starts_with('.')
        })
        .collect::<Vec<_>>();
    files.sort();
    files
        .into_iter()
        .take(500)
        .map(|path| {
            let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("agent");
            let (name, description) = frontmatter(&path);
            json!({"name":name.unwrap_or_else(||fallback.into()),"description":description})
        })
        .collect()
}
fn commands_preview(path: &Path) -> Value {
    let Ok(entries) = fs::read_dir(path.join("commands")) else { return json!([]) };
    let mut files = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.extension().and_then(|value| value.to_str()) == Some("md")
                && !path.file_name().and_then(|value| value.to_str()).unwrap_or("").starts_with('.')
        })
        .collect::<Vec<_>>();
    files.sort();
    files
        .into_iter()
        .take(500)
        .map(|path| {
            let fallback = path.file_stem().and_then(|value| value.to_str()).unwrap_or("command");
            let (name, description) = frontmatter(&path);
            json!({"name":name.unwrap_or_else(||fallback.into()),"description":description})
        })
        .collect()
}
fn author_text(value: &Value) -> Option<String> {
    display_text(value, 128).or_else(|| display_at(value, &["name"], 128))
}
fn package_preview(path: &Path, manifests: &[Value]) -> Value {
    let meta = optional_json(&path.join("plugin.meta.json")).unwrap_or(Value::Null);
    let codex = optional_json(&path.join(".codex-plugin/plugin.json")).unwrap_or(Value::Null);
    let cursor = optional_json(&path.join(".cursor-plugin/plugin.json")).unwrap_or(Value::Null);
    let interface = &codex["interface"];
    let meta_interface = &meta["codex"]["interface"];
    let fallback = |key: &str| manifests.iter().find_map(|row| display_text(&row[key], 2000));
    let name = first_display(&[
        display_at(&meta, &["id"], 128),
        fallback("name"),
        path.file_name().and_then(|value| value.to_str()).map(|value| value.to_string()),
    ]).unwrap_or_else(|| "plugin".into());
    let display_name = first_display(&[
        display_at(&meta, &["displayName"], 128),
        display_at(interface, &["displayName"], 128),
        display_at(meta_interface, &["displayName"], 128),
        Some(name.clone()),
    ]);
    let description = first_display(&[
        display_at(interface, &["shortDescription"], 2000),
        display_at(meta_interface, &["shortDescription"], 2000),
        display_at(&meta, &["description"], 2000),
        fallback("description"),
    ]);
    let long_description = first_display(&[
        display_at(interface, &["longDescription"], 2000),
        display_at(meta_interface, &["longDescription"], 2000),
        display_at(&meta, &["description"], 2000),
        fallback("description"),
    ]);
    let version = first_display(&[display_at(&meta, &["version"], 64), fallback("version")]);
    let author = first_display(&[
        author_text(&meta["author"]),
        display_at(interface, &["developerName"], 128),
        display_at(meta_interface, &["developerName"], 128),
        manifests.iter().find_map(|row| author_text(&row["author"])),
    ]);
    let category = first_display(&[
        display_at(&meta, &["category"], 128),
        display_at(interface, &["category"], 128),
        display_at(meta_interface, &["category"], 128),
    ]);
    let logo = package_logo(path, vec![
        display_at(interface, &["logo"], 4096),
        display_at(interface, &["composerIcon"], 4096),
        display_at(meta_interface, &["logo"], 4096),
        display_at(meta_interface, &["composerIcon"], 4096),
        display_at(&cursor, &["logo"], 4096),
    ]);
    json!({
        "name":name,"path":path.to_string_lossy(),"displayName":display_name,
        "description":description,"longDescription":long_description,"version":version,
        "author":author,"category":category,"logo":logo,"skills":[],"commands":commands_preview(path),
        "agents":agents_preview(path),"hooks":hooks_preview(path, manifests),"rules":rules_preview(path),"mcp":mcp_preview(path, manifests),
    })
}
pub fn logo(root: &Path, source: &Value, package_index: usize) -> Result<(Vec<u8>, &'static str)> {
    let source_id = source["id"].as_str().context("source id missing")?;
    if !id(source_id) {
        bail!("invalid source id")
    }
    let release = source["release"].as_str().context("release missing")?;
    if safe_relative(Path::new(release)).as_deref() != Some(release) || release == "." {
        bail!("invalid release")
    }
    let package = source["packages"].as_array().and_then(|rows| rows.get(package_index)).context("package missing")?;
    let package_path = safe_relative(Path::new(package["path"].as_str().context("package path missing")?)).context("invalid package path")?;
    let logo_path = safe_relative(Path::new(package["logo"].as_str().context("logo missing")?)).context("invalid logo path")?;
    if logo_path == "." {
        bail!("invalid logo path")
    }
    let base = root.join("sources").join(source_id).join("releases").join(release).join("package");
    let base = fs::canonicalize(base)?;
    let package_root = fs::canonicalize(base.join(package_path))?;
    if !package_root.starts_with(&base) {
        bail!("package escapes release")
    }
    let file = fs::canonicalize(package_root.join(logo_path))?;
    if !file.starts_with(&package_root) || !fs::metadata(&file)?.is_file() || fs::metadata(&file)?.len() > 4 * 1024 * 1024 {
        bail!("logo escapes package or is too large")
    }
    let bytes = fs::read(file)?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        bail!("unsupported logo content")
    };
    Ok((bytes, mime))
}
fn scan(
    root: &Path,
    path: &Path,
    depth: usize,
    count: &mut usize,
    skills: &mut Vec<Value>,
    plugins: &mut Value,
    packages: &mut Vec<Value>,
    current_package: Option<usize>,
) -> Result<()> {
    *count += 1;
    if depth > 8 || *count > 5000 {
        bail!("插件目录过大，请缩小子目录")
    }
    let mut manifests = vec![];
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
            manifests.push(value);
        }
    }
    let current_package = if !manifests.is_empty() || path.join("plugin.meta.json").is_file() {
        packages.push(package_preview(path, &manifests));
        Some(packages.len() - 1)
    } else {
        current_package
    };
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
        if let Some(index) = current_package {
            let (display_name, description) = frontmatter(&skill);
            let fallback = path.file_name().and_then(|value| value.to_str()).unwrap_or("skill");
            packages[index]["skills"].as_array_mut().unwrap().push(json!({
                "name":display_name.unwrap_or_else(||fallback.into()),"description":description,
            }));
        }
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
            scan(root, &entry.path(), depth + 1, count, skills, plugins, packages, current_package)?
        }
    }
    Ok(())
}
pub fn snapshot(root: &Path, source: &Value) -> Result<(Vec<Value>, Value, Option<String>, String, Vec<Value>)> {
    let name = source["id"].as_str().context("source id missing")?;
    let release_id = uuid::Uuid::new_v4().to_string();
    let release = root
        .join("sources")
        .join(name)
        .join("releases")
        .join(&release_id);
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
    let mut packages = vec![];
    scan(&selected, &selected, 0, &mut 0, &mut skills, &mut plugins, &mut packages, None)?;
    if skills.is_empty()
        && plugins
            .as_object()
            .unwrap()
            .values()
            .all(|rows| rows.as_array().unwrap().is_empty())
    {
        bail!("未找到 SKILL.md 或原生插件清单")
    }
    for row in &mut packages {
        let path = PathBuf::from(row["path"].as_str().context("package preview path missing")?);
        row["path"] = json!(safe_relative(path.strip_prefix(&package)?).context("invalid package preview path")?);
        row["skills"].as_array_mut().unwrap().sort_by_key(|skill| skill["name"].as_str().unwrap_or("").to_string());
    }
    packages.sort_by_key(|row| row["path"].as_str().unwrap_or("").to_string());
    Ok((skills, plugins, revision, release_id, packages))
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
    {
        let to = link_path(link, "to")?;
        let path = link_path(link, "path")?;
        if to.is_dir() {
            copy_tree(&to, &path, &mut 0, 0)?;
        } else {
            fs::copy(to, path)?;
        }
    }
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
    if plugins.is_empty() {
        native_remove(root, source)?;
        return Ok(());
    }
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
