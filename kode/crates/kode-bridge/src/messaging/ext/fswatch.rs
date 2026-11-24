//! File and Git events for watched workspaces, from the OS's file
//! notifications (FSEvents on macOS) - never by scanning. Bursts are folded:
//! one `fs.changed` per workspace per quiet period, and Git's own files turn
//! into `git.commit` / `git.branch` when HEAD actually moves.
use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde_json::json;
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const QUIET: Duration = Duration::from_secs(2);
const MAX_PATHS: usize = 200;
const IGNORED: &[&str] = &["node_modules", "target", ".DS_Store", "dist", ".next", "__pycache__", ".venv"];

type Emit = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

pub struct FsWatch {
    state: Mutex<State>,
    emit: Emit,
}

#[derive(Default)]
struct State {
    watcher: Option<notify::RecommendedWatcher>,
    roots: HashSet<PathBuf>,
    sender: Option<tokio::sync::mpsc::UnboundedSender<PathBuf>>,
}

impl FsWatch {
    pub fn new(emit: Emit) -> Self {
        Self { state: Mutex::default(), emit }
    }

    /// Watch exactly `roots` (existing directories); cheap when unchanged.
    pub fn sync(self: &Arc<Self>, roots: HashSet<PathBuf>) {
        let roots: HashSet<PathBuf> = roots.into_iter().filter(|r| r.is_dir()).collect();
        let mut state = self.state.lock();
        if state.roots == roots {
            return;
        }
        if roots.is_empty() {
            *state = State::default();
            return;
        }
        if state.watcher.is_none() {
            let (send, receive) = tokio::sync::mpsc::unbounded_channel::<PathBuf>();
            let forward = send.clone();
            let watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
                if let Ok(event) = result {
                    for path in event.paths {
                        let _ = forward.send(path);
                    }
                }
            });
            match watcher {
                Ok(watcher) => {
                    state.watcher = Some(watcher);
                    state.sender = Some(send);
                    tokio::spawn(fold(self.clone(), receive));
                }
                Err(error) => {
                    tracing::warn!(%error, "file watching unavailable");
                    return;
                }
            }
        }
        let state = &mut *state;
        let watcher = state.watcher.as_mut().unwrap();
        for gone in state.roots.difference(&roots) {
            let _ = watcher.unwatch(gone);
        }
        for added in roots.difference(&state.roots) {
            if let Err(error) = watcher.watch(added, RecursiveMode::Recursive) {
                tracing::warn!(%error, path = %added.display(), "workspace not watched");
            }
        }
        state.roots = roots;
    }

    fn root_of(&self, path: &Path) -> Option<PathBuf> {
        self.state.lock().roots.iter().filter(|root| path.starts_with(root)).max_by_key(|root| root.as_os_str().len()).cloned()
    }
}

async fn fold(watch: Arc<FsWatch>, mut receive: tokio::sync::mpsc::UnboundedReceiver<PathBuf>) {
    let mut changed: HashMap<PathBuf, BTreeSet<String>> = HashMap::new();
    let mut git: HashSet<PathBuf> = HashSet::new();
    let mut heads: HashMap<PathBuf, (String, String)> = HashMap::new();
    loop {
        let next = if changed.is_empty() && git.is_empty() {
            match receive.recv().await {
                Some(path) => Some(path),
                None => return,
            }
        } else {
            match tokio::time::timeout(QUIET, receive.recv()).await {
                Ok(Some(path)) => Some(path),
                Ok(None) => return,
                Err(_) => None,
            }
        };
        if let Some(path) = next {
            let Some(root) = watch.root_of(&path) else { continue };
            let relative = path.strip_prefix(&root).unwrap_or(&path).to_string_lossy().into_owned();
            if relative == ".git" || relative.starts_with(".git/") {
                if relative.starts_with(".git/HEAD") || relative.starts_with(".git/refs/") || relative == ".git/packed-refs" {
                    git.insert(root);
                }
            } else if !relative.is_empty() && !relative.split('/').any(|part| IGNORED.contains(&part)) {
                let paths = changed.entry(root).or_default();
                if paths.len() < MAX_PATHS {
                    paths.insert(relative);
                }
            }
            continue;
        }
        // Quiet: report what accumulated.
        for (root, paths) in changed.drain() {
            (watch.emit)("fs.changed", json!({"workspace":root,"paths":paths.into_iter().collect::<Vec<_>>()}));
        }
        for root in git.drain() {
            let Some((branch, head)) = read_head(&root) else { continue };
            match heads.insert(root.clone(), (branch.clone(), head.clone())) {
                Some((prior_branch, _)) if prior_branch != branch => (watch.emit)("git.branch", json!({"workspace":root,"branch":branch,"head":head})),
                Some((_, prior_head)) if prior_head != head => (watch.emit)("git.commit", json!({"workspace":root,"branch":branch,"head":head})),
                // First sight only learns the current head.
                _ => {}
            }
        }
    }
}

/// `(branch, commit)` of a repository (a worktree's `.git` file is followed).
pub fn read_head(root: &Path) -> Option<(String, String)> {
    let mut git = root.join(".git");
    if git.is_file() {
        let pointer = std::fs::read_to_string(&git).ok()?;
        git = root.join(pointer.trim().strip_prefix("gitdir:")?.trim());
    }
    let head = std::fs::read_to_string(git.join("HEAD")).ok()?;
    let head = head.trim();
    let Some(reference) = head.strip_prefix("ref: ") else { return Some(("(detached)".into(), head.to_owned())) };
    let branch = reference.strip_prefix("refs/heads/").unwrap_or(reference).to_owned();
    // Linked worktrees keep refs in the common directory.
    let common = std::fs::read_to_string(git.join("commondir")).ok().map(|c| git.join(c.trim())).unwrap_or_else(|| git.clone());
    let sha = std::fs::read_to_string(common.join(reference)).ok().map(|s| s.trim().to_owned()).or_else(|| {
        std::fs::read_to_string(common.join("packed-refs")).ok()?.lines().find_map(|line| line.strip_suffix(reference).map(|sha| sha.trim().to_owned()))
    })?;
    Some((branch, sha))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn heads_read_loose_and_packed_refs() {
        let dir = tempfile::tempdir().unwrap();
        let git = dir.path().join(".git");
        std::fs::create_dir_all(git.join("refs/heads")).unwrap();
        std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
        std::fs::write(git.join("refs/heads/main"), "abc123\n").unwrap();
        assert_eq!(read_head(dir.path()), Some(("main".into(), "abc123".into())));
        std::fs::write(git.join("HEAD"), "ref: refs/heads/feature\n").unwrap();
        std::fs::write(git.join("packed-refs"), "# pack\ndef456 refs/heads/feature\n").unwrap();
        assert_eq!(read_head(dir.path()), Some(("feature".into(), "def456".into())));
    }

    #[tokio::test]
    async fn bursts_fold_into_one_event_and_ignored_paths_stay_out() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let seen = Arc::new(Mutex::new(vec![]));
        let sink = seen.clone();
        let watch = Arc::new(FsWatch::new(Arc::new(move |topic: &str, payload| sink.lock().push((topic.to_owned(), payload)))));
        watch.sync([root.clone()].into());
        tokio::time::sleep(Duration::from_millis(300)).await;
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/a.rs"), "1").unwrap();
        std::fs::write(root.join("src/b.rs"), "2").unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(root.join("node_modules/x/i.js"), "3").unwrap();
        for _ in 0..60 {
            if !seen.lock().is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let events = seen.lock().clone();
        assert_eq!(events.len(), 1, "{events:?}");
        let paths: Vec<&str> = events[0].1["paths"].as_array().unwrap().iter().filter_map(|p| p.as_str()).collect();
        assert!(paths.contains(&"src/a.rs") && paths.contains(&"src/b.rs"));
        assert!(!paths.iter().any(|p| p.starts_with("node_modules")));
    }
}
