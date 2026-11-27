//! Archive visibility and mobile/remote session projection.
use crate::messaging::bots::Roster;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

/// Apply the shared workspace archive index without deleting runtime records.
/// GUI adapters also use this against older running backends during upgrades.
pub fn filter_visible_runtime_sessions(result: &mut Value, workspaces: &Value) {
    let archived: HashSet<_> = workspaces
        .pointer("/value/global/archivedSessionIds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if let Some(rows) = result["sessions"].as_array_mut() {
        rows.retain(|row| {
            row["runtime"] != "dsh"
                || !row["runtime_session_id"]
                    .as_str()
                    .is_some_and(|id| archived.contains(id))
        });
    }
}

/// Mobile groups by cwd, while desktop groups by the durable workspace account.
/// Keep execution cwd separately in the cloud DTO so older monitors also follow
/// workspace moves and worktree parent groups without rewriting session logs.
pub(crate) fn project_mobile_workspaces(
    snapshots: &mut [Value],
    workspaces: &Value,
    index: &Value,
) {
    let Some(table) = workspaces.pointer("/value/tables/workspaces").and_then(Value::as_object) else {
        return;
    };
    let parents = index.pointer("/value/worktreeParents");
    let mut projects = std::collections::HashMap::new();
    for (id, workspace) in table {
        let mut root = id.as_str();
        let mut seen = HashSet::from([root]);
        while let Some(parent) = parents.and_then(|rows| rows[root].as_str()) {
            if !table.contains_key(parent) || !seen.insert(parent) {
                break;
            }
            root = parent;
        }
        let Some(path) = table[root]["path"].as_str().filter(|path| !path.is_empty()) else {
            continue;
        };
        for session in workspace["sessionIds"].as_array().into_iter().flatten().filter_map(Value::as_str) {
            projects.insert(session, (root, path));
        }
    }
    for snapshot in snapshots {
        let dto = &mut snapshot["dto"];
        if dto["runtime"] != "dsh" {
            continue;
        }
        let project = dto["runtime_session_id"].as_str()
            .or_else(|| dto["session_uuid"].as_str())
            .and_then(|id| projects.get(id));
        if let Some((id, path)) = project {
            if dto.get("execution_cwd").is_none() {
                dto["execution_cwd"] = dto["cwd"].clone();
            }
            dto["cwd"] = Value::from(*path);
            dto["workspace_id"] = Value::from(*id);
        }
    }
}

/// Shared gallery root matching GUI (`list_avatar_library`) and DSH (`SessionAppearance`).
pub(crate) fn avatar_root_dir() -> Option<PathBuf> {
    if let Ok(env_dir) = std::env::var("KODE_AVATAR_DIR") {
        let trimmed = env_dir.trim();
        if !trimmed.is_empty() {
            if let Some(rest) = trimmed.strip_prefix("~/") {
                if let Some(home) = dirs::home_dir() {
                    return Some(home.join(rest));
                }
            }
            return Some(PathBuf::from(trimmed));
        }
    }
    dirs::config_dir().map(|base| base.join("kode").join("avatars"))
}

fn valid_gallery_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix("gallery/") else {
        return false;
    };
    !rest.is_empty()
        && !rest.contains('/')
        && !rest.contains('\\')
        && !rest.contains('\0')
        && !id.contains("..")
}

fn load_gallery_renames(avatar_root: &Path) -> HashMap<String, String> {
    let path = avatar_root.join(".dsh-gallery.json");
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return HashMap::new();
    };
    parsed
        .get("renamed")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn resolve_gallery_id(id: &str, renamed: &HashMap<String, String>) -> Option<String> {
    let mut current = id.to_string();
    let mut seen = HashSet::new();
    while let Some(next) = renamed.get(&current) {
        if !seen.insert(current.clone()) || seen.len() >= 32 {
            return None;
        }
        current = next.clone();
    }
    valid_gallery_id(&current).then_some(current)
}

fn first_frame_in_dir(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let direct = dir.join("frame-01.png");
    if direct.is_file() {
        return Some(direct);
    }
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().map(|t| t.is_dir()).unwrap_or(false)
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .map(|e| e.path())
        .collect();
    subdirs.sort();
    for sub in subdirs {
        let candidate = sub.join("frame-01.png");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn gallery_avatar_still_path(avatar_root: &Path, gallery_id: &str) -> Option<PathBuf> {
    let base = avatar_root.join(gallery_id);
    if !base.is_dir() {
        return None;
    }
    first_frame_in_dir(&base.join("idle")).or_else(|| first_frame_in_dir(&base))
}

fn gallery_named_image(
    avatar_root: &Path,
    gallery_id: &str,
    stem: &str,
) -> Option<(PathBuf, &'static str)> {
    let base = avatar_root.join(gallery_id);
    if !base.is_dir() {
        return None;
    }
    for (ext, mime) in [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("webp", "image/webp"),
    ] {
        let candidate = base.join(format!("{stem}.{ext}"));
        if candidate.is_file() {
            return Some((candidate, mime));
        }
    }
    None
}

fn cached_image_ref(path: &Path, mime: &str) -> Option<Value> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u128, u64, Value)>>> = OnceLock::new();
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() == 0 {
        return None;
    }
    let mtime_nanos = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let size = meta.len();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(guard) = cache.lock() {
        if let Some((cached_mtime, cached_size, ref_val)) = guard.get(path) {
            if *cached_mtime == mtime_nanos && *cached_size == size {
                return Some(ref_val.clone());
            }
        }
    }
    let stored = crate::session_images::from_file(path.to_str()?, Some(mime))?;
    if let Ok(mut guard) = cache.lock() {
        if guard.len() > 512 {
            guard.clear();
        }
        guard.insert(path.to_path_buf(), (mtime_nanos, size, stored.clone()));
    }
    Some(stored)
}

fn is_local_endpoint(row: &Value) -> bool {
    match row.get("endpoint_id") {
        None | Some(Value::Null) => true,
        Some(ep) => ep.get("kind").and_then(Value::as_str).unwrap_or("local") == "local",
    }
}

fn imported_session_id(row: &Value) -> Option<String> {
    let backend = row.get("backend_key").and_then(Value::as_str)?;
    let session = row.get("session_id").and_then(Value::as_str)?;
    if backend.is_empty() || session.is_empty() {
        return None;
    }
    Some(format!("{backend}:{session}"))
}

fn resolve_session_avatar_from_index(
    dto: &Value,
    index: &Value,
    session_keys: &[String],
) -> Option<String> {
    let value = index.get("value").unwrap_or(index);
    let backend = dto.get("backend_key").and_then(Value::as_str).unwrap_or("");
    let session_uuid = dto.get("session_uuid").and_then(Value::as_str).unwrap_or("");

    let matches_row = |row: &Value| -> bool {
        if !is_local_endpoint(row) {
            return false;
        }
        let dsh_id = row.get("dsh_session_id").and_then(Value::as_str);
        let imported = imported_session_id(row);
        if session_keys.iter().any(|k| {
            dsh_id == Some(k.as_str()) || imported.as_deref() == Some(k.as_str())
        }) {
            return true;
        }
        if !backend.is_empty() && !session_uuid.is_empty() {
            let rb = row.get("backend_key").and_then(Value::as_str);
            let rs = row.get("session_id").and_then(Value::as_str);
            if rb == Some(backend) && rs == Some(session_uuid) {
                return true;
            }
        }
        false
    };

    if let Some(tabs) = value.pointer("/gui/tabs").and_then(Value::as_array) {
        for row in tabs {
            if matches_row(row) {
                if let Some(avatar) = row.get("avatar_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    return Some(avatar.to_string());
                }
            }
        }
    }
    if let Some(native) = value.get("native_sessions").and_then(Value::as_array) {
        for row in native {
            if matches_row(row) {
                if let Some(avatar) = row.get("avatar_id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    return Some(avatar.to_string());
                }
            }
        }
    }
    if let Some(pending) = value
        .pointer("/presentation/sessionAvatars")
        .and_then(Value::as_object)
    {
        for key in session_keys {
            if let Some(entry) = pending.get(key) {
                return entry
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
            }
        }
    }
    if !backend.is_empty() {
        if let Some(fallback) = value
            .pointer("/presentation/agentAvatars")
            .and_then(Value::as_object)
            .and_then(|map| map.get(backend))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(fallback.to_string());
        }
    }
    None
}

fn path_within(child: &str, parent: &Path) -> bool {
    let child_path = Path::new(child);
    child_path == parent || child_path.starts_with(parent)
}

/// Attach bot identity (`bot_id`, `bot_name`, `bot_tagline`, `bot_kind`, `banner`)
/// and synced gallery artwork (`avatar_id`, `avatar_image`, `background_image`,
/// `banner_image`) to session DTOs so mobile clients and remote desktops receive
/// the same partner identity, avatars, and backgrounds as desktop GUI/DSH.
pub(crate) fn project_session_identity(
    snapshots: &mut [Value],
    bots_doc: &Value,
    index_doc: &Value,
    avatar_root: Option<&Path>,
) {
    let roster: Roster = bots_doc
        .get("value")
        .filter(|v| !v.is_null())
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let bots_root = roster.root();
    let bots_by_id: HashMap<&str, &crate::messaging::bots::Bot> = roster
        .bots
        .iter()
        .map(|b| (b.id.as_str(), b))
        .collect();
    let renamed = avatar_root.map(load_gallery_renames).unwrap_or_default();
    let alias_graph = crate::messaging::bot_prompt::build_session_aliases(index_doc, snapshots);

    for snapshot in snapshots {
        let local_id = snapshot.get("local_id").and_then(Value::as_u64);
        let dto = &mut snapshot["dto"];
        if !dto.is_object() {
            continue;
        }
        let runtime = dto
            .get("runtime")
            .and_then(Value::as_str)
            .unwrap_or("gui");
        let mut seed_keys: Vec<String> = Vec::new();
        for field in ["runtime_session_id", "session_uuid", "native_thread_id"] {
            if let Some(s) = dto.get(field).and_then(Value::as_str).filter(|s| !s.is_empty()) {
                if !seed_keys.iter().any(|k| k == s) {
                    seed_keys.push(s.to_string());
                }
            }
        }
        if let Some(local_id) = local_id {
            seed_keys.push(format!("kode:runtime:gui:{local_id}"));
        }
        let mut session_keys: Vec<String> = Vec::new();
        for seed in &seed_keys {
            for alias in crate::messaging::bot_prompt::expand_session_key(seed, &alias_graph) {
                if !session_keys.iter().any(|k| k == &alias) {
                    session_keys.push(alias);
                }
            }
        }
        let exec_cwd = dto
            .get("execution_cwd")
            .and_then(Value::as_str)
            .or_else(|| dto.get("cwd").and_then(Value::as_str))
            .unwrap_or("");

        // 1. Resolve owning bot: main_session -> adopted -> bot home directory.
        // Cross-runtime aliases keep bot ownership intact across TUI <-> DSH switches.
        let mut matched_bot: Option<(&crate::messaging::bots::Bot, &'static str)> = None;
        for bot in &roster.bots {
            if let Some(main) = &bot.main_session {
                let same_or_bridged = main.runtime.is_empty()
                    || main.runtime == runtime
                    || session_keys.len() > seed_keys.len();
                if same_or_bridged && session_keys.iter().any(|k| k == &main.session_id) {
                    matched_bot = Some((bot, "main"));
                    break;
                }
            }
        }
        if matched_bot.is_none() {
            for key in &session_keys {
                if let Some(bot_id) = roster.adopted.get(key) {
                    if let Some(bot) = bots_by_id.get(bot_id.as_str()) {
                        matched_bot = Some((*bot, "adopted"));
                        break;
                    }
                }
            }
        }
        if matched_bot.is_none() && !exec_cwd.is_empty() {
            for bot in &roster.bots {
                let home = bots_root.join(&bot.id);
                if path_within(exec_cwd, &home) {
                    matched_bot = Some((bot, "subtask"));
                    break;
                }
            }
        }

        if let Some((bot, kind)) = matched_bot {
            dto["bot_id"] = json!(bot.id);
            dto["bot_name"] = json!(bot.name);
            dto["bot_kind"] = json!(kind);
            if let Some(tagline) = bot.tagline.as_deref().filter(|t| !t.trim().is_empty()) {
                dto["bot_tagline"] = json!(tagline);
            }
            if let Some(banner) = bot.banner.as_deref().filter(|b| !b.trim().is_empty()) {
                dto["banner"] = json!(banner);
            }
        }

        // 2. Resolve gallery avatar id: bot avatar -> existing dto avatar_id -> session-index.
        let raw_avatar = matched_bot
            .and_then(|(bot, _)| bot.avatar.as_deref().filter(|a| !a.trim().is_empty()))
            .map(str::to_string)
            .or_else(|| {
                dto.get("avatar_id")
                    .and_then(Value::as_str)
                    .filter(|a| !a.trim().is_empty())
                    .map(str::to_string)
            })
            .or_else(|| resolve_session_avatar_from_index(dto, index_doc, &session_keys));

        let Some(avatar_id) = raw_avatar
            .as_deref()
            .and_then(|id| resolve_gallery_id(id, &renamed))
        else {
            continue;
        };

        dto["avatar_id"] = json!(avatar_id);

        // 3. Cache local gallery still / background / banner images into session_images
        // so phones can download them via existing `/api/v1/images/:id`.
        let Some(root) = avatar_root else {
            continue;
        };
        if let Some(still) = gallery_avatar_still_path(root, &avatar_id) {
            if let Some(image_ref) = cached_image_ref(&still, "image/png") {
                dto["avatar_image"] = image_ref;
            }
        }
        if let Some((bg_path, mime)) = gallery_named_image(root, &avatar_id, "background") {
            if let Some(image_ref) = cached_image_ref(&bg_path, mime) {
                dto["background_image"] = image_ref;
            }
        }
        if let Some((banner_path, mime)) = gallery_named_image(root, &avatar_id, "banner") {
            if let Some(image_ref) = cached_image_ref(&banner_path, mime) {
                dto["banner_image"] = image_ref;
            }
        }
    }
}

/// Run workspace + bot + gallery artwork projection against a live `Ctx`
/// for both Cloud Sync snapshots and direct `/api/v1/sessions` / `/ws` callers.
pub(crate) fn project_ctx_sessions(ctx: &crate::Ctx, snapshots: &mut [Value]) {
    let store = ctx.runtimes.workbench_store.lock().upgrade();
    if let Some(store) = store {
        let workspaces = store.document("workspaces").unwrap_or_else(|error| {
            tracing::warn!(%error, "mobile workspace projection unavailable");
            json!({"value": null})
        });
        let index = store.document("session-index").unwrap_or_else(|error| {
            tracing::warn!(%error, "mobile session-index projection unavailable");
            json!({"value": null})
        });
        let bots = store.document("bots").unwrap_or_else(|error| {
            tracing::warn!(%error, "mobile bot projection unavailable");
            json!({"value": null})
        });
        project_mobile_workspaces(snapshots, &workspaces, &index);
        let avatar_root = avatar_root_dir();
        project_session_identity(snapshots, &bots, &index, avatar_root.as_deref());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mobile_uses_current_workspace_and_worktree_parent_without_changing_execution_paths() {
        let workspaces = json!({"value":{"tables":{"workspaces":{
            "project":{"path":"/projects/kode","sessionIds":["restored"]},
            "tree":{"path":"/worktrees/feature","sessionIds":["worktree"]},
            "broken":{"path":"/projects/other","sessionIds":["orphan"]}
        }}}});
        let index = json!({"value":{"worktreeParents":{"tree":"project","broken":"missing"}}});
        let original = vec![
            json!({"local_id":1,"dto":{"runtime":"dsh","runtime_session_id":"restored","cwd":"/deleted/kode"}}),
            json!({"local_id":2,"dto":{"runtime":"dsh","runtime_session_id":"worktree","cwd":"/worktrees/feature"}}),
            json!({"local_id":3,"dto":{"runtime":"dsh","session_uuid":"orphan","cwd":"/projects/other"}}),
            json!({"local_id":4,"dto":{"runtime":"dsh","runtime_session_id":"unassigned","cwd":"/unassigned"}}),
            json!({"local_id":5,"dto":{"runtime":"gui","runtime_session_id":"restored","cwd":"/native"}}),
        ];
        let mut mobile = original.clone();
        project_mobile_workspaces(&mut mobile, &workspaces, &index);
        for session in &mobile[..2] {
            assert_eq!(session["dto"]["cwd"], "/projects/kode");
            assert_eq!(session["dto"]["workspace_id"], "project");
        }
        assert_eq!(mobile[0]["dto"]["execution_cwd"], "/deleted/kode");
        assert_eq!(mobile[1]["dto"]["execution_cwd"], "/worktrees/feature");
        assert_eq!(mobile[2]["dto"]["cwd"], "/projects/other");
        assert_eq!(mobile[3], original[3]);
        assert_eq!(mobile[4], original[4]);
        assert_eq!(original[0]["dto"]["cwd"], "/deleted/kode");
        project_mobile_workspaces(&mut mobile, &workspaces, &index);
        assert_eq!(mobile[0]["dto"]["execution_cwd"], "/deleted/kode");
        project_mobile_workspaces(&mut mobile, &json!({"value":null}), &index);
        assert_eq!(mobile[0]["dto"]["cwd"], "/projects/kode");
    }

    #[test]
    fn archive_hides_live_and_cold_dsh_rows_and_unarchive_restores_identity() {
        let original = json!({"sessions":[
            {"id":1,"runtime":"dsh","runtime_session_id":"session-a","status":"busy"},
            {"id":2,"runtime":"dsh","runtime_session_id":"session-b","runtime_online":false},
            {"id":3,"runtime":"dsh","runtime_session_id":"session-c"},
            {"id":4,"runtime":"gui","runtime_session_id":"session-a"}
        ],"runtimes":{"dsh":true}});
        let mut visible = original.clone();
        filter_visible_runtime_sessions(
            &mut visible,
            &json!({"value":{"global":{"archivedSessionIds":["session-a","session-b"]}}}),
        );
        assert_eq!(
            visible["sessions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![3, 4]
        );
        assert_eq!(visible["runtimes"], original["runtimes"]);
        let mut restored = original.clone();
        filter_visible_runtime_sessions(
            &mut restored,
            &json!({"value":{"global":{"archivedSessionIds":[]}}}),
        );
        assert_eq!(restored, original);
    }

    #[test]
    fn projects_bot_identity_and_gallery_artwork_refs() {
        let dir = tempfile::tempdir().unwrap();
        let gallery = dir.path().join("gallery");
        let fox = gallery.join("fox");
        std::fs::create_dir_all(fox.join("idle")).unwrap();
        // Minimal valid 1x1 PNG bytes
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82";
        std::fs::write(fox.join("idle/frame-01.png"), png).unwrap();
        std::fs::write(fox.join("background.png"), png).unwrap();
        std::fs::write(fox.join("banner.webp"), b"RIFF....WEBP").unwrap();
        std::fs::write(
            dir.path().join(".dsh-gallery.json"),
            r#"{"version":1,"renamed":{"gallery/old-fox":"gallery/fox"}}"#,
        )
        .unwrap();

        let bots_root = dir.path().join("bots");
        let bots_doc = json!({
            "value": {
                "root": bots_root.to_string_lossy(),
                "bots": [
                    {
                        "id": "assistant",
                        "name": "小狐狸",
                        "avatar": "gallery/old-fox",
                        "banner": "preset:blurple",
                        "tagline": "日常随行伙伴",
                        "backend_key": "claude",
                        "main_session": { "runtime": "dsh", "session_id": "s-main" }
                    }
                ],
                "adopted": { "s-adopted": "assistant" }
            }
        });
        let index_doc = json!({
            "value": {
                "presentation": {
                    "sessionAvatars": { "s-plain": "gallery/fox" },
                    "agentAvatars": { "codex": "gallery/fox" }
                }
            }
        });
        let mut snapshots = vec![
            json!({"local_id":1,"dto":{"runtime":"dsh","runtime_session_id":"s-main","backend_key":"claude","cwd":"/tmp"}}),
            json!({"local_id":2,"dto":{"runtime":"dsh","runtime_session_id":"s-adopted","backend_key":"claude","cwd":"/tmp"}}),
            json!({"local_id":3,"dto":{"runtime":"dsh","runtime_session_id":"s-sub","backend_key":"claude","cwd":bots_root.join("assistant/task").to_string_lossy()}}),
            json!({"local_id":4,"dto":{"runtime":"dsh","runtime_session_id":"s-plain","backend_key":"claude","cwd":"/work"}}),
            json!({"local_id":5,"dto":{"runtime":"gui","session_uuid":"g-1","backend_key":"codex","cwd":"/work"}}),
        ];

        project_session_identity(&mut snapshots, &bots_doc, &index_doc, Some(dir.path()));

        assert_eq!(snapshots[0]["dto"]["bot_id"], "assistant");
        assert_eq!(snapshots[0]["dto"]["bot_name"], "小狐狸");
        assert_eq!(snapshots[0]["dto"]["bot_kind"], "main");
        assert_eq!(snapshots[0]["dto"]["bot_tagline"], "日常随行伙伴");
        assert_eq!(snapshots[0]["dto"]["banner"], "preset:blurple");
        assert_eq!(snapshots[0]["dto"]["avatar_id"], "gallery/fox");
        assert!(snapshots[0]["dto"]["avatar_image"]["id"].as_str().is_some());
        assert!(snapshots[0]["dto"]["background_image"]["id"].as_str().is_some());
        assert!(snapshots[0]["dto"]["banner_image"]["id"].as_str().is_some());
        assert_eq!(snapshots[0]["dto"]["banner_image"]["mime"], "image/webp");

        assert_eq!(snapshots[1]["dto"]["bot_id"], "assistant");
        assert_eq!(snapshots[1]["dto"]["bot_kind"], "adopted");

        assert_eq!(snapshots[2]["dto"]["bot_id"], "assistant");
        assert_eq!(snapshots[2]["dto"]["bot_kind"], "subtask");

        assert!(snapshots[3]["dto"].get("bot_id").is_none());
        assert_eq!(snapshots[3]["dto"]["avatar_id"], "gallery/fox");
        assert!(snapshots[3]["dto"]["avatar_image"]["id"].as_str().is_some());

        assert!(snapshots[4]["dto"].get("bot_id").is_none());
        assert_eq!(snapshots[4]["dto"]["avatar_id"], "gallery/fox");
    }
}
