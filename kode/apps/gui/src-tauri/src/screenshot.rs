use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowScreenshotPayload {
    pub png_base64: String,
    pub width: u32,
    pub height: u32,
}

#[tauri::command]
pub fn capture_window_screenshot(
    app: tauri::AppHandle,
    window_label: String,
) -> Result<WindowScreenshotPayload, String> {
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("window '{window_label}' not found"))?;
    let png = capture_window_png(&window)?;
    let (width, height) = screenshot_dimensions(&png)?;
    Ok(WindowScreenshotPayload {
        png_base64: BASE64.encode(png),
        width,
        height,
    })
}

#[tauri::command]
pub fn capture_interactive_screenshot() -> Result<WindowScreenshotPayload, String> {
    let png = capture_interactive_png()?;
    let (width, height) = screenshot_dimensions(&png)?;
    Ok(WindowScreenshotPayload {
        png_base64: BASE64.encode(png),
        width,
        height,
    })
}

#[tauri::command]
pub fn save_png_bytes(output_path: String, png_base64: String) -> Result<(), String> {
    let bytes = BASE64
        .decode(png_base64.as_bytes())
        .map_err(|error| format!("decode png failed: {error}"))?;
    std::fs::write(&output_path, bytes)
        .map_err(|error| format!("write screenshot {} failed: {error}", output_path))?;
    Ok(())
}

fn screenshot_dimensions(png: &[u8]) -> Result<(u32, u32), String> {
    if png.len() < 24 {
        return Err("generated screenshot is not a valid PNG".into());
    }
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
    Ok((width, height))
}

#[cfg(target_os = "macos")]
fn capture_window_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        create_image, kCGWindowImageBestResolution, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowListOptionIncludingWindow,
    };
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};
    use objc2_app_kit::NSWindow;

    let raw = window
        .ns_window()
        .map_err(|error| format!("resolve native window failed: {error}"))?;
    let ns_window: &NSWindow = unsafe { &*raw.cast() };
    let frame = ns_window.frame();
    let width = frame.size.width.max(0.0).round() as usize;
    let height = frame.size.height.max(0.0).round() as usize;
    if width == 0 || height == 0 {
        return Err("window has zero-sized bounds".into());
    }
    let bounds = CGRect::new(
        &CGPoint::new(frame.origin.x, frame.origin.y),
        &CGSize::new(frame.size.width, frame.size.height),
    );
    let window_id = ns_window.windowNumber() as u32;
    let image = create_image(
        bounds,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution,
    )
    .ok_or_else(|| "macOS window capture returned no image".to_string())?;
    let image_ref = image.as_ref();
    let data = image_ref.data();
    let bytes = data.bytes();
    let bytes_per_row = image_ref.bytes_per_row();
    let bits_per_pixel = image_ref.bits_per_pixel();
    if bits_per_pixel < 32 {
        return Err(format!(
            "unsupported screenshot pixel format: {bits_per_pixel} bits per pixel"
        ));
    }

    let mut rgba = vec![0u8; width * height * 4];
    for row in 0..height {
        let src_row = &bytes[row * bytes_per_row..row * bytes_per_row + width * 4];
        let dst_row = &mut rgba[row * width * 4..(row + 1) * width * 4];
        for col in 0..width {
            let src = col * 4;
            let dst = col * 4;
            dst_row[dst] = src_row[src + 2];
            dst_row[dst + 1] = src_row[src + 1];
            dst_row[dst + 2] = src_row[src];
            dst_row[dst + 3] = src_row[src + 3];
        }
    }

    let mut png = Vec::new();
    let encoder = PngEncoder::new(&mut png);
    encoder
        .write_image(&rgba, width as u32, height as u32, ColorType::Rgba8.into())
        .map_err(|error| format!("encode screenshot PNG failed: {error}"))?;
    Ok(png)
}

#[cfg(not(target_os = "macos"))]
fn capture_window_png(_window: &WebviewWindow) -> Result<Vec<u8>, String> {
    Err("window screenshot is currently only supported on macOS".into())
}

#[cfg(target_os = "macos")]
fn capture_interactive_png() -> Result<Vec<u8>, String> {
    let output_path =
        std::env::temp_dir().join(format!("kode-screenshot-{}.png", uuid::Uuid::new_v4()));
    let status = std::process::Command::new("/usr/sbin/screencapture")
        .arg("-i")
        .arg("-x")
        .arg(&output_path)
        .status()
        .map_err(|error| format!("launch screencapture failed: {error}"))?;
    if !status.success() {
        return Err("cancelled".into());
    }
    std::fs::read(&output_path).map_err(|error| format!("read screenshot failed: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn capture_interactive_png() -> Result<Vec<u8>, String> {
    Err("interactive screenshot is currently only supported on macOS".into())
}
