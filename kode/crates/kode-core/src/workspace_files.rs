//! Workspace-scoped filesystem edits shared by desktop and remote bridge.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

static EDIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Deserialize, Serialize)]
pub struct FileEdit {
    pub root: String,
    pub path: String,
    pub action: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sources: Vec<String>,
}

fn scoped(root: &Path, path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("Expected an absolute workspace path".into());
    }
    let parent = path
        .parent()
        .ok_or("Cannot modify filesystem root")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let candidate = parent.join(path.file_name().ok_or("Missing file name")?);
    if !candidate.starts_with(root) || candidate == root {
        return Err("Cannot modify paths outside the workspace or its root".into());
    }
    Ok(candidate)
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || matches!(name, "." | "..")
        || name.chars().any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err("Enter a file name without path separators".into());
    }
    Ok(())
}
fn absent(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(format!("Already exists: {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
fn copy_tree(source: &Path, dest: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(source).map_err(|e| e.to_string())?;
    if meta.is_symlink() {
        return Err(format!(
            "Symbolic links cannot be imported: {}",
            source.display()
        ));
    }
    if meta.is_dir() {
        fs::create_dir(dest).map_err(|e| e.to_string())?;
        for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            copy_tree(&entry.path(), &dest.join(entry.file_name()))?;
        }
    } else if meta.is_file() {
        let mut input = fs::File::open(source).map_err(|e| e.to_string())?;
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dest)
            .map_err(|e| e.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|e| e.to_string())?;
        fs::set_permissions(dest, meta.permissions()).map_err(|e| e.to_string())?;
    } else {
        return Err("Special files cannot be imported".into());
    }
    Ok(())
}

pub fn edit(request: FileEdit) -> Result<Vec<String>, String> {
    let _lock = EDIT_LOCK.lock().map_err(|e| e.to_string())?;
    let root = Path::new(&request.root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !root.is_dir() {
        return Err("Workspace is not a directory".into());
    }
    let result = match request.action.as_str() {
        "new_file" | "new_folder" | "import" => {
            let directory = Path::new(&request.path)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !directory.starts_with(&root) || !directory.is_dir() {
                return Err("Target is not a workspace directory".into());
            }
            if request.action == "import" {
                if request.sources.is_empty() {
                    return Err("Choose files or folders to import".into());
                }
                let mut targets = Vec::new();
                for source in &request.sources {
                    if fs::symlink_metadata(source)
                        .map_err(|e| e.to_string())?
                        .is_symlink()
                    {
                        return Err("Symbolic links cannot be imported".into());
                    }
                    let source = Path::new(source)
                        .canonicalize()
                        .map_err(|e| e.to_string())?;
                    let target =
                        directory.join(source.file_name().ok_or("Cannot import filesystem root")?);
                    absent(&target)?;
                    if directory.starts_with(&source) || targets.iter().any(|(_, p)| *p == target) {
                        return Err(
                            "Cannot copy a folder into itself or import duplicate names".into()
                        );
                    }
                    targets.push((source, target));
                }
                // Copy everything into an owned staging folder before publishing.
                let staging = directory.join(format!(".kode-import-{}", uuid::Uuid::new_v4()));
                fs::create_dir(&staging).map_err(|e| e.to_string())?;
                let copied = (|| {
                    for (source, target) in &targets {
                        copy_tree(source, &staging.join(target.file_name().unwrap()))?;
                    }
                    for (_, target) in &targets {
                        absent(target)?;
                    }
                    let mut published = Vec::new();
                    for (_, target) in &targets {
                        if let Err(error) =
                            fs::rename(staging.join(target.file_name().unwrap()), target)
                        {
                            // Reclaim only paths published by this request, never existing targets.
                            let mut recovery = Vec::new();
                            for path in &published {
                                let path: &PathBuf = path;
                                if fs::rename(path, staging.join(path.file_name().unwrap()))
                                    .is_err()
                                {
                                    recovery.push(path.display().to_string());
                                }
                            }
                            return Err(format!(
                                "Import failed: {error}. Unreverted paths: {}",
                                recovery.join(", ")
                            ));
                        }
                        published.push(target.clone());
                    }
                    Ok::<_, String>(targets.iter().map(|(_, p)| p.clone()).collect::<Vec<_>>())
                })();
                let _ = fs::remove_dir_all(staging);
                copied?
            } else {
                validate_name(&request.name)?;
                let target = directory.join(&request.name);
                absent(&target)?;
                if request.action == "new_folder" {
                    fs::create_dir(&target).map_err(|e| e.to_string())?;
                } else {
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&target)
                        .map_err(|e| e.to_string())?;
                }
                vec![target]
            }
        }
        "rename" => {
            validate_name(&request.name)?;
            let source = scoped(&root, Path::new(&request.path))?;
            let target = source.parent().unwrap().join(&request.name);
            if target == source {
                return Ok(vec![source.to_string_lossy().into_owned()]);
            }
            absent(&target)?;
            fs::rename(source, &target).map_err(|e| e.to_string())?;
            vec![target]
        }
        "delete" => {
            let target = scoped(&root, Path::new(&request.path))?;
            let meta = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
            if meta.is_dir() && !meta.is_symlink() {
                fs::remove_dir_all(target).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(target).map_err(|e| e.to_string())?;
            }
            vec![]
        }
        _ => return Err("Unknown file operation".into()),
    };
    Ok(result
        .into_iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("kode-files-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn request(&self, action: &str, path: &Path, name: &str) -> FileEdit {
            FileEdit {
                root: self.0.to_string_lossy().into(),
                path: path.to_string_lossy().into(),
                action: action.into(),
                name: name.into(),
                sources: vec![],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn create_rename_delete_and_reject_collisions() {
        let f = Fixture::new();
        edit(f.request("new_folder", &f.0, "project")).unwrap();
        let dir = f.0.join("project");
        edit(f.request("new_file", &dir, "draft.txt")).unwrap();
        fs::write(dir.join("draft.txt"), "keep content").unwrap();
        assert!(edit(f.request("new_file", &dir, "draft.txt")).is_err());
        edit(f.request("rename", &dir.join("draft.txt"), "notes.txt")).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("notes.txt")).unwrap(),
            "keep content"
        );
        assert!(edit(f.request("rename", &dir, "../escape")).is_err());
        assert!(edit(f.request("delete", &f.0, "")).is_err());
        edit(f.request("delete", &dir, "")).unwrap();
        assert!(!dir.exists());
    }
    #[test]
    fn recursive_import_preserves_source_and_existing_destination() {
        let f = Fixture::new();
        let source = Fixture::new();
        fs::create_dir(source.0.join("folder")).unwrap();
        fs::write(source.0.join("folder/file.txt"), "hello").unwrap();
        let mut req = f.request("import", &f.0, "");
        req.sources = vec![source.0.join("folder").to_string_lossy().into()];
        edit(req).unwrap();
        assert_eq!(
            fs::read_to_string(f.0.join("folder/file.txt")).unwrap(),
            "hello"
        );
        assert!(source.0.join("folder/file.txt").exists());
        let mut req = f.request("import", &f.0, "");
        req.sources = vec![source.0.join("folder").to_string_lossy().into()];
        assert!(edit(req).is_err());
        let mut req = f.request("import", &f.0, "");
        req.sources = vec![f.0.to_string_lossy().into()];
        assert!(edit(req).is_err());
    }
    #[test]
    fn edits_cannot_escape_workspace() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("keep.txt"), "safe").unwrap();
        assert!(edit(f.request("delete", &outside.0.join("keep.txt"), "")).is_err());
        assert!(edit(f.request("new_file", &outside.0, "bad.txt")).is_err());
        assert!(outside.0.join("keep.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_targets_are_never_followed_for_edits_or_imports() {
        let f = Fixture::new();
        let outside = Fixture::new();
        fs::write(outside.0.join("keep.txt"), "safe").unwrap();
        std::os::unix::fs::symlink(&outside.0, f.0.join("link")).unwrap();
        assert!(edit(f.request("new_file", &f.0.join("link"), "bad.txt")).is_err());
        assert!(edit(f.request("delete", &f.0.join("link/keep.txt"), "")).is_err());
        let mut req = f.request("import", &f.0, "");
        req.sources = vec![f.0.join("link").to_string_lossy().into()];
        assert!(edit(req).is_err());
        edit(f.request("delete", &f.0.join("link"), "")).unwrap();
        assert!(outside.0.join("keep.txt").exists());
        let source = Fixture::new();
        std::os::unix::fs::symlink(&outside.0, source.0.join("nested-link")).unwrap();
        let mut req = f.request("import", &f.0, "");
        req.sources = vec![source.0.to_string_lossy().into()];
        assert!(edit(req).is_err());
        assert_eq!(fs::read_dir(&f.0).unwrap().count(), 0);
    }
}
