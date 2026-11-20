//! File paths of the most recent drag, read from the macOS drag pasteboard.
//!
//! macOS turns off Tauri's native drop handler (`tauri.macos.conf.json`), so
//! Finder drops arrive as HTML5 events. WKWebView gives page scripts neither
//! `File.path` nor the file URLs, but the system drag pasteboard still holds
//! this drag's items after the drop. The frontend checks the names against
//! `dataTransfer.files` before trusting them.

/// Absolute paths of the current drag pasteboard items; empty elsewhere.
#[tauri::command]
pub fn drag_pasteboard_paths() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag, NSPasteboardTypeFileURL};
        use objc2_foundation::NSURL;
        let board = NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag });
        let Some(items) = board.pasteboardItems() else { return Vec::new() };
        // Finder publishes file reference URLs (`file:///.file/id=…`);
        // `filePathURL` resolves them to the real path.
        items
            .iter()
            .filter_map(|item| item.stringForType(unsafe { NSPasteboardTypeFileURL }))
            .filter_map(|url| NSURL::URLWithString(&url)?.filePathURL()?.path())
            .map(|path| path.to_string())
            .collect()
    }
    #[cfg(not(target_os = "macos"))]
    Vec::new()
}
