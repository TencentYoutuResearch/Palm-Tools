//! Desktop-side SSH attachment uploads. Return remote paths; never submit a prompt.
use std::{
    io::Cursor,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{
    deploy,
    persistence::{self, PersistedEndpoint},
};
use arboard::{Clipboard, Error as ClipboardError, ImageData};
use serde::Serialize;

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RemoteClipboardPayload {
    Text { text: String },
    Attachments { paths: Vec<String> },
    Empty,
}

#[tauri::command]
pub async fn upload_remote_attachments(
    endpoint_id: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let ep = find_endpoint(&endpoint_id)?;
        upload(&ep, &paths, |cmd, label| {
            deploy::run_and_capture(cmd, label)
        })
    })
    .await
    .map_err(|e| format!("Attachment task failed: {e}"))?
}

#[tauri::command]
pub async fn paste_remote_clipboard(
    endpoint_id: String,
    on_upload_started: tauri::ipc::Channel<()>,
) -> Result<RemoteClipboardPayload, String> {
    tokio::task::spawn_blocking(move || {
        let mut clipboard = Clipboard::new().map_err(|e| format!("Clipboard unavailable: {e}"))?;
        if let Some(files) = clipboard_content(clipboard.get().file_list())? {
            if !files.is_empty() {
                let _ = on_upload_started.send(());
                let paths = files
                    .into_iter()
                    .map(|p| {
                        p.into_os_string()
                            .into_string()
                            .map_err(|_| "Attachment path is not valid Unicode".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let ep = find_endpoint(&endpoint_id)?;
                let paths = upload(&ep, &paths, |cmd, label| {
                    deploy::run_and_capture(cmd, label)
                })?;
                return Ok(RemoteClipboardPayload::Attachments { paths });
            }
        }
        if let Some(image) = clipboard_content(clipboard.get_image())? {
            let _ = on_upload_started.send(());
            let ep = find_endpoint(&endpoint_id)?;
            let paths = upload_clipboard_image(&ep, image, |cmd, label| {
                deploy::run_and_capture(cmd, label)
            })?;
            return Ok(RemoteClipboardPayload::Attachments { paths });
        }
        match clipboard_content(clipboard.get_text())? {
            Some(text) if !text.is_empty() => Ok(RemoteClipboardPayload::Text { text }),
            _ => Ok(RemoteClipboardPayload::Empty),
        }
    })
    .await
    .map_err(|e| format!("Clipboard task failed: {e}"))?
}

fn upload_clipboard_image(
    ep: &PersistedEndpoint,
    image: ImageData<'_>,
    run: impl FnMut(Command, &str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    // The directory guard cleans our PNG on success and on every error path.
    let tmp = tempfile::Builder::new()
        .prefix("kode-clipboard-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    let png = tmp.path().join("clipboard.png");
    std::fs::write(&png, encode_png(image)?).map_err(|e| e.to_string())?;
    upload(ep, &[png.to_string_lossy().into_owned()], run)
}

fn clipboard_content<T>(result: Result<T, ClipboardError>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(ClipboardError::ContentNotAvailable) => Ok(None),
        Err(e) => Err(format!("Clipboard read failed: {e}")),
    }
}

fn find_endpoint(id: &str) -> Result<PersistedEndpoint, String> {
    persistence::load()
        .endpoints
        .unwrap_or_default()
        .into_iter()
        .find(|ep| ep.id == id)
        .ok_or_else(|| format!("Endpoint '{id}' not found"))
}

fn encode_png(image: ImageData<'_>) -> Result<Vec<u8>, String> {
    let width = u32::try_from(image.width).map_err(|_| "Clipboard image is too wide")?;
    let height = u32::try_from(image.height).map_err(|_| "Clipboard image is too tall")?;
    let rgba = image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
        .ok_or_else(|| "Invalid clipboard image data".to_string())?;
    let mut output = Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut output, image::ImageFormat::Png)
        .map_err(|e| format!("PNG encoding failed: {e}"))?;
    Ok(output.into_inner())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn validate_host(host: &str) -> Result<(), String> {
    if host.is_empty() {
        return Err("Attachment uploads require an SSH connection".into());
    }
    if host.starts_with('-')
        || !host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-@[]:".contains(c))
    {
        return Err("Invalid SSH host for attachment upload".into());
    }
    Ok(())
}

fn validate_source(path: &Path) -> Result<bool, String> {
    if !path.is_absolute()
        || path
            .to_str()
            .is_none_or(|s| s.chars().any(char::is_control))
    {
        return Err("Attachment paths must be absolute and contain no control characters".into());
    }
    let meta = std::fs::symlink_metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.file_type().is_symlink() || (!meta.is_file() && !meta.is_dir()) {
        return Err(format!(
            "Unsupported attachment (symbolic link or special file): {}",
            path.display()
        ));
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
            validate_source(&entry.map_err(|e| e.to_string())?.path())?;
        }
    }
    Ok(meta.is_dir())
}

fn ssh_command(ep: &PersistedEndpoint, script: &str) -> Command {
    let mut cmd = Command::new("ssh");
    if ep.ssh_port != 0 && ep.ssh_port != 22 {
        cmd.args(["-p", &ep.ssh_port.to_string()]);
    }
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "--",
        &ep.ssh_host,
        script,
    ]);
    cmd
}

fn scp_command(ep: &PersistedEndpoint, path: &Path, destination: &str, directory: bool) -> Command {
    let mut cmd = Command::new("scp");
    // Force legacy SCP so shell quoting has one well-defined interpretation.
    cmd.arg("-O");
    if directory {
        cmd.arg("-r");
    }
    if ep.ssh_port != 0 && ep.ssh_port != 22 {
        cmd.args(["-P", &ep.ssh_port.to_string()]);
    }
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=8"]);
    cmd.arg("--")
        .arg(path)
        .arg(format!("{}:{}", ep.ssh_host, shell_quote(destination)));
    cmd
}

fn upload(
    ep: &PersistedEndpoint,
    paths: &[String],
    mut run: impl FnMut(Command, &str) -> Result<String, String>,
) -> Result<Vec<String>, String> {
    validate_host(&ep.ssh_host)?;
    let root = persistence::validate_attachment_dir(&ep.ssh_attachment_dir)?;
    let sources = paths
        .iter()
        .map(|raw| {
            let path = PathBuf::from(raw);
            let directory = validate_source(&path)?;
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .filter(|s| !s.is_empty())
                .ok_or_else(|| "Cannot upload a filesystem root".to_string())?
                .to_string();
            Ok((path, directory, name))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if sources.is_empty() {
        return Ok(vec![]);
    }
    let batch = format!(
        "{}/{}",
        root.trim_end_matches('/'),
        uuid::Uuid::new_v4().simple()
    );
    let mut script = format!(
        "umask 077; mkdir -p -- {} && mkdir -- {}",
        shell_quote(&root),
        shell_quote(&batch)
    );
    for index in 0..sources.len() {
        script.push_str(&format!(
            " && mkdir -- {}",
            shell_quote(&format!("{batch}/{index}"))
        ));
    }
    run(ssh_command(ep, &script), "ssh")
        .map_err(|e| format!("Create attachment directory: {e}"))?;
    let mut uploaded = Vec::new();
    for (index, (path, directory, name)) in sources.into_iter().enumerate() {
        let destination = format!("{batch}/{index}");
        run(scp_command(ep, &path, &destination, directory), "scp")
            .map_err(|e| format!("Upload {}: {e}", path.display()))?;
        uploaded.push(format!("{destination}/{name}"));
    }
    Ok(uploaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;
    fn endpoint() -> PersistedEndpoint {
        serde_json::from_value(serde_json::json!({"id":"test", "base_url":"http://localhost", "token":"test", "ssh_host":"user@upload.example", "ssh_port":2222})).unwrap()
    }
    fn args(cmd: &Command) -> Vec<String> {
        cmd.get_args()
            .map(|s| s.to_string_lossy().into_owned())
            .collect()
    }
    #[test]
    fn upload_isolated_paths_and_recursive_commands() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("a ' $(touch bad).png");
        std::fs::write(&file, b"test").unwrap();
        let dir = tmp.path().join("folder");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join(".hidden"), b"test").unwrap();
        let inputs = vec![
            file.to_str().unwrap().into(),
            file.to_str().unwrap().into(),
            dir.to_str().unwrap().into(),
        ];
        let mut commands = Vec::new();
        let result = upload(&endpoint(), &inputs, |cmd, _| {
            commands.push(args(&cmd));
            Ok(String::new())
        })
        .unwrap();
        assert_eq!(commands.len(), 4);
        assert!(commands[0].contains(&"2222".into()));
        assert!(commands[1].contains(&"-O".into()));
        assert!(!commands[1].contains(&"-r".into()));
        assert!(commands[3].contains(&"-r".into()));
        assert!(result[0].contains("/0/a ' $(touch bad).png"));
        assert!(result[1].contains("/1/a ' $(touch bad).png"));
        assert!(result[2].ends_with("/2/folder"));
        let again = upload(&endpoint(), &inputs, |_, _| Ok(String::new())).unwrap();
        assert_ne!(result[0], again[0]);
    }
    #[cfg(unix)]
    #[test]
    fn real_scp_protocol_preserves_files_folders_and_quoted_paths() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let ssh = tmp.path().join("local-ssh");
        // Execute the remote SCP receiver locally, without a network connection.
        std::fs::write(
            &ssh,
            "#!/bin/sh\nfor arg do last=\"$arg\"; done\nexec /bin/sh -c \"$last\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&ssh, std::fs::Permissions::from_mode(0o700)).unwrap();
        let file = tmp.path().join("image 中文 ' ; $(bad).png");
        std::fs::write(&file, b"image bytes").unwrap();
        let folder = tmp.path().join("folder 中文 ' ;");
        std::fs::create_dir(&folder).unwrap();
        std::fs::create_dir(folder.join("empty")).unwrap();
        std::fs::write(folder.join(".hidden"), b"hidden bytes").unwrap();
        let mut ep = endpoint();
        ep.ssh_attachment_dir = tmp
            .path()
            .join("destination 中文 ' ; $(bad)")
            .to_str()
            .unwrap()
            .into();
        let paths = vec![
            file.to_str().unwrap().into(),
            folder.to_str().unwrap().into(),
        ];
        let uploaded = upload(&ep, &paths, |cmd, label| {
            if label == "ssh" {
                let script = args(&cmd).pop().unwrap();
                let mut local = Command::new("/bin/sh");
                local.args(["-c", &script]);
                deploy::run_and_capture(local, "local mkdir")
            } else {
                let mut local = Command::new("/usr/bin/scp");
                local.arg("-S").arg(&ssh).args(cmd.get_args());
                deploy::run_and_capture(local, "local SCP protocol")
            }
        })
        .unwrap();
        assert_eq!(std::fs::read(&uploaded[0]).unwrap(), b"image bytes");
        assert_eq!(
            std::fs::read(Path::new(&uploaded[1]).join(".hidden")).unwrap(),
            b"hidden bytes"
        );
        assert!(Path::new(&uploaded[1]).join("empty").is_dir());
    }

    #[test]
    fn custom_destination_is_shell_quoted_and_failures_propagate() {
        let mut ep = endpoint();
        ep.ssh_attachment_dir = "/tmp/a ' ; $(bad) 中文".into();
        let tmp = tempfile::NamedTempFile::new().unwrap();
        let input = vec![tmp.path().to_str().unwrap().into()];
        let mut count = 0;
        assert!(upload(&ep, &input, |cmd, label| {
            count += 1;
            if label == "ssh" {
                assert!(args(&cmd).last().unwrap().contains("'\"'\"'"));
                Ok(String::new())
            } else {
                assert!(args(&cmd).last().unwrap().contains("'\"'\"'"));
                Err("permission denied".into())
            }
        })
        .unwrap_err()
        .contains("permission denied"));
        assert_eq!(count, 2);
    }
    #[test]
    fn invalid_hosts_and_sources_fail_before_execution() {
        for host in [
            "",
            "-oProxyCommand=bad",
            "user@host;bad",
            "alias with space",
        ] {
            assert!(validate_host(host).is_err());
        }
        for host in ["alias-name", "user@upload.example", "user@[::1]"] {
            assert!(validate_host(host).is_ok());
        }
        assert!(validate_source(Path::new("relative.png")).is_err());
        #[cfg(unix)]
        {
            let tmp = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink("/missing", tmp.path().join("link")).unwrap();
            assert!(validate_source(tmp.path()).is_err());
        }
    }
    #[test]
    fn png_encoding_and_temporary_cleanup() {
        let bytes = encode_png(ImageData {
            width: 1,
            height: 1,
            bytes: Cow::Owned(vec![255, 0, 0, 255]),
        })
        .unwrap();
        assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
        let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
        assert_eq!(image.to_rgba8().get_pixel(0, 0).0, [255, 0, 0, 255]);
        assert!(encode_png(ImageData {
            width: 1,
            height: 1,
            bytes: Cow::Owned(vec![])
        })
        .is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clipboard.png");
        std::fs::write(&path, bytes).unwrap();
        drop(dir);
        assert!(!path.exists());
    }
    #[test]
    fn clipboard_upload_cleans_png_after_success_or_failure() {
        for fail in [false, true] {
            let mut source = None;
            let result = upload_clipboard_image(
                &endpoint(),
                ImageData {
                    width: 1,
                    height: 1,
                    bytes: Cow::Owned(vec![0, 255, 0, 255]),
                },
                |cmd, label| {
                    if label == "scp" {
                        let arguments = args(&cmd);
                        let path = PathBuf::from(&arguments[arguments.len() - 2]);
                        assert!(path.is_file());
                        assert!(std::fs::read(&path).unwrap().starts_with(b"\x89PNG"));
                        source = Some(path);
                        if fail {
                            return Err("upload denied".into());
                        }
                    }
                    Ok(String::new())
                },
            );
            assert_eq!(result.is_err(), fail);
            assert!(!source.unwrap().exists());
        }
    }

    #[test]
    fn missing_clipboard_formats_are_not_errors() {
        assert!(
            clipboard_content::<String>(Err(ClipboardError::ContentNotAvailable))
                .unwrap()
                .is_none()
        );
        assert!(clipboard_content::<String>(Err(ClipboardError::ClipboardOccupied)).is_err());
    }
}
