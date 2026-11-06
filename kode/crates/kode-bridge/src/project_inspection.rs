//! Bounded public project-document inspection anchored to directory descriptors.
use anyhow::{bail, Result};
use serde::Deserialize;
use serde_json::{json, Value};

pub const SELECTORS: &[&str] = &[
    "README.md",
    "AGENTS.md",
    "CODEBUDDY.md",
    "CLAUDE.md",
    "package.json",
    "Cargo.toml",
    "Makefile",
    "pyproject.toml",
    ".gitlab-ci.yml",
    ".codex-plugin/plugin.json",
    ".github/workflows",
    "skills",
    ".agents/skills",
    ".codex/skills",
    ".claude/skills",
];

pub fn directory_selector(path: &str) -> bool {
    matches!(
        path,
        ".github/workflows" | "skills" | ".agents/skills" | ".codex/skills" | ".claude/skills"
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub root: String,
    pub workspace_id: String,
    pub device: String,
    pub inode: String,
    pub paths: Vec<String>,
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{symlink, MetadataExt},
    };

    fn request(root: &std::path::Path, paths: &[&str]) -> Request {
        let identity = fs::metadata(root).unwrap();
        Request {
            root: root.to_str().unwrap().to_owned(),
            workspace_id: "selected".into(),
            device: identity.dev().to_string(),
            inode: identity.ino().to_string(),
            paths: paths.iter().map(|path| (*path).to_owned()).collect(),
        }
    }

    #[test]
    fn selected_ci_and_skill_bytes_have_hashes_and_supported_inventory_markers() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join(".github/workflows")).unwrap();
        fs::create_dir_all(root.path().join(".agents/skills/verify")).unwrap();
        fs::write(
            root.path().join(".github/workflows/check.yml"),
            "name: check\n",
        )
        .unwrap();
        fs::write(
            root.path().join(".agents/skills/verify/SKILL.md"),
            "# Verify\n",
        )
        .unwrap();
        let result = inspect(request(
            root.path(),
            &[
                ".github/workflows",
                ".gitlab-ci.yml",
                "skills",
                ".agents/skills",
                ".codex/skills",
                ".claude/skills",
                ".codex-plugin/plugin.json",
            ],
        ))
        .unwrap();
        let facts = result["facts"].as_array().unwrap();
        assert_eq!(
            facts
                .iter()
                .filter(|fact| fact["status"] == "observed")
                .count(),
            2
        );
        assert_eq!(
            facts
                .iter()
                .find(|fact| fact["path"] == ".agents/skills")
                .unwrap()["status"],
            "directory_scanned"
        );
        assert_eq!(
            facts
                .iter()
                .find(|fact| fact["path"] == ".agents/skills/verify/SKILL.md")
                .unwrap()["bytes"],
            9
        );
        assert!(facts
            .iter()
            .filter(|fact| fact["status"] == "observed")
            .all(|fact| fact["sha256"].as_str().unwrap().len() == 64));
        assert!(!result["pending_checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str().unwrap().contains("not_inspected")));
        assert_eq!(result["eligible_for_execution"], false);
    }

    #[test]
    fn ancestor_leaf_and_skill_links_never_return_outside_bytes() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(
            outside.path().join("outside.yml"),
            "owned-fixture-outside-marker",
        )
        .unwrap();
        fs::write(
            outside.path().join("SKILL.md"),
            "owned-fixture-outside-marker",
        )
        .unwrap();
        symlink(outside.path(), root.path().join(".github")).unwrap();
        let result = inspect(request(root.path(), &[".github/workflows"])).unwrap();
        assert_eq!(result["facts"][0]["status"], "symlink_denied");
        fs::remove_file(root.path().join(".github")).unwrap();
        fs::create_dir_all(root.path().join(".github/workflows")).unwrap();
        symlink(
            outside.path().join("outside.yml"),
            root.path().join(".github/workflows/link.yml"),
        )
        .unwrap();
        fs::hard_link(
            outside.path().join("outside.yml"),
            root.path().join(".github/workflows/hard.yml"),
        )
        .unwrap();
        fs::create_dir_all(root.path().join(".agents/skills")).unwrap();
        symlink(outside.path(), root.path().join(".agents/skills/link")).unwrap();
        fs::write(
            root.path().join(".github/workflows/secrets.yml"),
            "owned-fixture-outside-marker",
        )
        .unwrap();
        let result = inspect(request(
            root.path(),
            &[".github/workflows", ".agents/skills"],
        ))
        .unwrap();
        assert!(!result.to_string().contains("owned-fixture-outside-marker"));
        let facts = result["facts"].as_array().unwrap();
        assert!(facts
            .iter()
            .any(|fact| fact["status"] == "unsupported_file"));
        assert!(facts
            .iter()
            .any(|fact| fact["status"] == "directory_partial"));
        assert!(result["pending_checks"]
            .as_array()
            .unwrap()
            .contains(&json!("project_inspection_incomplete")));
    }

    #[test]
    fn selection_and_identity_fail_before_file_inspection_and_large_inventories_are_partial() {
        let root = tempfile::tempdir().unwrap();
        let mut changed = request(root.path(), &["README.md"]);
        changed.inode = "0".into();
        assert!(inspect(changed).is_err());
        for path in ["../README.md", ".env", ".github/workflows/../../outside"] {
            assert!(inspect(request(root.path(), &[path])).is_err());
        }
        fs::create_dir_all(root.path().join(".github/workflows")).unwrap();
        for index in 0..150 {
            fs::write(
                root.path()
                    .join(format!(".github/workflows/check-{index:03}.yml")),
                "name: bounded",
            )
            .unwrap();
        }
        let result = inspect(request(root.path(), &[".github/workflows"])).unwrap();
        assert!(result["facts"].as_array().unwrap().len() <= 56);
        assert_eq!(result["facts"][0]["status"], "directory_partial");
        assert!(result["pending_checks"]
            .as_array()
            .unwrap()
            .contains(&json!("project_inspection_incomplete")));
    }

    #[test]
    fn aggregate_byte_limit_retains_a_status_for_every_selected_location() {
        let root = tempfile::tempdir().unwrap();
        let paths = &SELECTORS[..8];
        for path in paths {
            fs::write(root.path().join(path), "x".repeat(65536)).unwrap();
        }
        let result = inspect(request(root.path(), paths)).unwrap();
        let facts = result["facts"].as_array().unwrap();
        assert_eq!(facts.len(), paths.len());
        assert!(paths
            .iter()
            .all(|path| facts.iter().any(|fact| fact["path"] == *path)));
        assert!(facts.iter().any(|fact| fact["status"] == "too_large"));
        assert!(serde_json::to_vec(&result).unwrap().len() < 300000);
    }
}

pub fn inspect(request: Request) -> Result<Value> {
    if request.root.len() > 4096
        || request.root.contains('\0')
        || !std::path::Path::new(&request.root).is_absolute()
        || request.workspace_id.is_empty()
        || request.workspace_id.len() > 160
        || !request
            .workspace_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))
        || request.paths.is_empty()
        || request.paths.len() > 8
        || request
            .paths
            .iter()
            .any(|path| !SELECTORS.contains(&path.as_str()))
        || request
            .paths
            .iter()
            .collect::<std::collections::HashSet<_>>()
            .len()
            != request.paths.len()
    {
        bail!("invalid project inspection selection")
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        native::inspect(request)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        bail!("directory-safe project inspection is unavailable on this platform")
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod native {
    use super::*;
    use sha2::{Digest, Sha256};
    use std::{
        ffi::{CStr, CString},
        fs::{File, OpenOptions},
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
    };

    const MAX_FILE: usize = 65536;
    const MAX_FACTS: usize = 56;
    const MAX_BYTES: usize = 262144;
    const MAX_ENTRIES: usize = 128;

    fn open_at(parent: &File, name: &str, directory: bool) -> std::io::Result<File> {
        let name = CString::new(name)?;
        let flags = libc::O_RDONLY
            | libc::O_NOFOLLOW
            | libc::O_CLOEXEC
            | libc::O_NONBLOCK
            | if directory { libc::O_DIRECTORY } else { 0 };
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    fn parent(root: &File, path: &str) -> std::io::Result<(File, String)> {
        let mut parts = path.split('/').collect::<Vec<_>>();
        let leaf = parts.pop().unwrap().to_owned();
        let mut directory = root.try_clone()?;
        for part in parts {
            directory = open_at(&directory, part, true)?;
        }
        Ok((directory, leaf))
    }

    fn status(error: &std::io::Error) -> &'static str {
        match error.raw_os_error() {
            Some(libc::ENOENT) => "missing",
            Some(libc::ELOOP) | Some(libc::ENOTDIR) => "symlink_denied",
            _ => "unavailable",
        }
    }

    fn observed(root: &File, path: &str) -> Value {
        let read = || -> std::io::Result<Value> {
            let (directory, leaf) = parent(root, path)?;
            let mut file = open_at(&directory, &leaf, false)?;
            let before = file.metadata()?;
            if !before.is_file() || before.nlink() != 1 {
                return Ok(json!({"path":path,"status":"unsupported_file"}));
            }
            if before.len() > MAX_FILE as u64 {
                return Ok(json!({"path":path,"status":"too_large"}));
            }
            let mut bytes = Vec::new();
            (&mut file)
                .take(MAX_FILE as u64 + 1)
                .read_to_end(&mut bytes)?;
            let after = file.metadata()?;
            if bytes.len() > MAX_FILE
                || bytes.len() as u64 != before.len()
                || before.len() != after.len()
                || before.mtime() != after.mtime()
                || before.mtime_nsec() != after.mtime_nsec()
                || before.ctime() != after.ctime()
                || before.ctime_nsec() != after.ctime_nsec()
            {
                return Ok(json!({"path":path,"status":"changed_during_read"}));
            }
            let Ok(content) = String::from_utf8(bytes) else {
                return Ok(json!({"path":path,"status":"not_text"}));
            };
            if content.contains('\0') {
                return Ok(json!({"path":path,"status":"not_text"}));
            }
            let at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64;
            Ok(
                json!({"path":path,"status":"observed","sha256":format!("{:x}",Sha256::digest(content.as_bytes())),"bytes":content.len(),"content":content,"observed_at":at,"trust":"untrusted_project_data"}),
            )
        };
        read().unwrap_or_else(|error| json!({"path":path,"status":status(&error)}))
    }

    struct Entries(*mut libc::DIR);
    impl Drop for Entries {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }

    fn names(directory: &File) -> std::io::Result<(Vec<String>, bool)> {
        let fd = unsafe { libc::dup(directory.as_raw_fd()) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let raw = unsafe { libc::fdopendir(fd) };
        if raw.is_null() {
            unsafe {
                libc::close(fd);
            }
            return Err(std::io::Error::last_os_error());
        }
        let entries = Entries(raw);
        let mut names = Vec::new();
        let mut complete = true;
        let mut inspected = 0;
        loop {
            #[cfg(target_os = "macos")]
            unsafe {
                *libc::__error() = 0;
            }
            #[cfg(target_os = "linux")]
            unsafe {
                *libc::__errno_location() = 0;
            }
            let entry = unsafe { libc::readdir(entries.0) };
            if entry.is_null() {
                if std::io::Error::last_os_error().raw_os_error().unwrap_or(0) != 0 {
                    complete = false;
                }
                break;
            }
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
            if name.to_bytes() == b"." || name.to_bytes() == b".." {
                continue;
            }
            inspected += 1;
            if inspected > MAX_ENTRIES {
                complete = false;
                break;
            }
            let Ok(name) = name.to_str() else {
                complete = false;
                continue;
            };
            names.push(name.to_owned());
        }
        names.sort();
        Ok((names, complete))
    }

    fn public_name(name: &str) -> bool {
        let lower = name.to_ascii_lowercase();
        !name.starts_with('.')
            && name.len() <= 160
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
            && ![
                "secret",
                "credential",
                "password",
                "private_key",
                "private-key",
                "token",
            ]
            .iter()
            .any(|part| lower.contains(part))
    }

    struct Collector {
        facts: Vec<Value>,
        bytes: usize,
        complete: bool,
        remaining_selectors: usize,
    }
    impl Collector {
        fn push(&mut self, fact: Value) -> bool {
            let byte_limit = MAX_BYTES - self.remaining_selectors * 256;
            let fact = if self.bytes + serde_json::to_vec(&fact).unwrap().len() > byte_limit
                && fact["status"] == "observed"
            {
                self.complete = false;
                json!({"path":fact["path"],"status":"too_large"})
            } else {
                fact
            };
            let size = serde_json::to_vec(&fact).unwrap().len();
            if !matches!(
                fact["status"].as_str(),
                Some("observed" | "missing" | "directory_scanned" | "directory_partial")
            ) {
                self.complete = false;
            }
            if self.facts.len() >= MAX_FACTS - self.remaining_selectors
                || self.bytes + size > byte_limit
            {
                self.complete = false;
                return false;
            }
            self.bytes += size;
            self.facts.push(fact);
            true
        }
        fn scan(&mut self, root: &File, path: &str) {
            let (directory, leaf) = match parent(root, path) {
                Ok(value) => value,
                Err(error) => {
                    self.push(json!({"path":path,"status":status(&error)}));
                    return;
                }
            };
            let directory = match open_at(&directory, &leaf, true) {
                Ok(value) => value,
                Err(error) => {
                    self.push(json!({"path":path,"status":status(&error)}));
                    return;
                }
            };
            let before = match directory.metadata() {
                Ok(value) => value,
                Err(_) => {
                    self.push(json!({"path":path,"status":"unavailable"}));
                    return;
                }
            };
            let (entries, mut complete) = match names(&directory) {
                Ok(value) => value,
                Err(_) => {
                    self.push(json!({"path":path,"status":"unavailable"}));
                    return;
                }
            };
            let marker = self.facts.len();
            if !self.push(json!({"path":path,"status":"directory_partial"})) {
                return;
            }
            for name in entries {
                if !public_name(&name) {
                    complete = false;
                    continue;
                }
                if path == ".github/workflows" {
                    if !(name.ends_with(".yml") || name.ends_with(".yaml")) {
                        continue;
                    }
                    if !self.push(observed(root, &format!("{path}/{name}"))) {
                        complete = false;
                        break;
                    }
                } else {
                    // A skill manifest is read through the original skill directory handle.
                    let skill = match open_at(&directory, &name, true) {
                        Ok(value) => value,
                        Err(error) => {
                            complete = false;
                            if !self.push(
                                json!({"path":format!("{path}/{name}"),"status":status(&error)}),
                            ) {
                                break;
                            }
                            continue;
                        }
                    };
                    let child = observed(&skill, "SKILL.md");
                    let mut fact = child;
                    fact["path"] = json!(format!("{path}/{name}/SKILL.md"));
                    if !self.push(fact) {
                        complete = false;
                        break;
                    }
                }
            }
            let unchanged = directory.metadata().is_ok_and(|after| {
                before.mtime() == after.mtime()
                    && before.mtime_nsec() == after.mtime_nsec()
                    && before.ctime() == after.ctime()
                    && before.ctime_nsec() == after.ctime_nsec()
            });
            complete &= unchanged;
            self.facts[marker]["status"] = json!(if complete {
                "directory_scanned"
            } else {
                "directory_partial"
            });
            self.complete &= complete;
        }
    }

    pub(super) fn inspect(request: Request) -> Result<Value> {
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(&request.root)?;
        let identity = root.metadata()?;
        if identity.dev().to_string() != request.device
            || identity.ino().to_string() != request.inode
        {
            bail!("selected workspace identity changed")
        }
        let mut collector = Collector {
            facts: Vec::new(),
            bytes: 0,
            complete: true,
            remaining_selectors: request.paths.len(),
        };
        for (index, path) in request.paths.iter().enumerate() {
            // Preserve one bounded marker for every still-selected location.
            collector.remaining_selectors = request.paths.len() - index - 1;
            if directory_selector(path) {
                collector.scan(&root, path);
            } else {
                collector.push(observed(&root, path));
            }
        }
        let mut pending = vec![
            "trusted_resources",
            "workflow_preflight",
            "human_activation",
        ];
        if !collector.complete {
            pending.push("project_inspection_incomplete");
        }
        if ![".github/workflows", ".gitlab-ci.yml"]
            .iter()
            .all(|path| request.paths.iter().any(|selected| selected == path))
        {
            pending.push("ci_locations_not_inspected");
        }
        if ![
            "skills",
            ".agents/skills",
            ".codex/skills",
            ".claude/skills",
        ]
        .iter()
        .all(|path| request.paths.iter().any(|selected| selected == path))
        {
            pending.push("skill_locations_not_inspected");
        }
        if !request
            .paths
            .iter()
            .any(|path| path == ".codex-plugin/plugin.json")
        {
            pending.push("plugin_manifest_not_inspected");
        }
        Ok(
            json!({"schema_version":2,"workspace_id":request.workspace_id,"root_identity":{"device":request.device,"inode":request.inode},"facts":collector.facts,"eligible_for_execution":false,"pending_checks":pending}),
        )
    }

    #[cfg(test)]
    mod anchor_tests {
        use super::*;
        #[test]
        fn directory_handle_survives_namespace_replacement_without_reading_new_target() {
            let parent = tempfile::tempdir().unwrap();
            let original = parent.path().join("project");
            let moved = parent.path().join("moved");
            let outside = parent.path().join("outside");
            std::fs::create_dir(&original).unwrap();
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(original.join("README.md"), "original selected bytes").unwrap();
            std::fs::write(outside.join("README.md"), "outside fixture bytes").unwrap();
            let directory = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&original)
                .unwrap();
            std::fs::rename(&original, &moved).unwrap();
            std::os::unix::fs::symlink(&outside, &original).unwrap();
            assert_eq!(
                observed(&directory, "README.md")["content"],
                "original selected bytes"
            );
        }
    }
}
