use base64::Engine;
use serde::Serialize;
use tauri::{Manager, WebviewWindow};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotDraft {
    png_base64: String,
    width: u32,
    height: u32,
}

#[tauri::command]
pub fn capture_window_screenshot(
    app: tauri::AppHandle,
    window_label: String,
) -> Result<ScreenshotDraft, String> {
    let window = app
        .get_webview_window(&window_label)
        .ok_or_else(|| format!("window '{window_label}' not found"))?;
    screenshot_draft(capture_window_png(&window)?)
}

#[tauri::command]
pub fn capture_interactive_screenshot() -> Result<ScreenshotDraft, String> {
    screenshot_draft(capture_main_screen_png()?)
}

#[tauri::command]
pub fn copy_screenshot_crop(
    png_base64: String,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let png = base64::engine::general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|error| format!("decode screenshot draft failed: {error}"))?;
    let cropped = crop_png(&png, x, y, width, height)?;
    copy_png_to_clipboard(&cropped)
}

fn screenshot_draft(png: Vec<u8>) -> Result<ScreenshotDraft, String> {
    let image = image::load_from_memory(&png)
        .map_err(|error| format!("decode screenshot draft failed: {error}"))?;
    Ok(ScreenshotDraft {
        png_base64: base64::engine::general_purpose::STANDARD.encode(png),
        width: image.width(),
        height: image.height(),
    })
}

fn crop_png(png: &[u8], x: u32, y: u32, width: u32, height: u32) -> Result<Vec<u8>, String> {
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    let image = image::load_from_memory(png)
        .map_err(|error| format!("decode screenshot for crop failed: {error}"))?
        .into_rgba8();
    if width == 0
        || height == 0
        || x >= image.width()
        || y >= image.height()
        || x.saturating_add(width) > image.width()
        || y.saturating_add(height) > image.height()
    {
        return Err("screenshot crop is outside the captured image".into());
    }
    let cropped = image::imageops::crop_imm(&image, x, y, width, height).to_image();
    let mut output = Vec::new();
    PngEncoder::new(&mut output)
        .write_image(cropped.as_raw(), width, height, ColorType::Rgba8.into())
        .map_err(|error| format!("encode cropped screenshot failed: {error}"))?;
    Ok(output)
}

#[cfg(target_os = "macos")]
fn copy_png_to_clipboard(png: &[u8]) -> Result<(), String> {
    let image = clipboard_image_from_png(png)?;
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("open system clipboard failed: {error}"))?;
    clipboard
        .set_image(image)
        .map_err(|error| format!("copy screenshot to clipboard failed: {error}"))
}

#[cfg(target_os = "macos")]
fn clipboard_image_from_png(png: &[u8]) -> Result<arboard::ImageData<'static>, String> {
    use std::borrow::Cow;

    let rgba = image::load_from_memory(png)
        .map_err(|error| format!("decode screenshot for clipboard failed: {error}"))?
        .into_rgba8();
    let (width, height) = rgba.dimensions();
    Ok(arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: Cow::Owned(rgba.into_raw()),
    })
}

#[cfg(not(target_os = "macos"))]
fn copy_png_to_clipboard(_png: &[u8]) -> Result<(), String> {
    Err("image clipboard is currently only supported on macOS".into())
}

#[cfg(target_os = "macos")]
fn capture_window_png(window: &WebviewWindow) -> Result<Vec<u8>, String> {
    use core_graphics::geometry::{CGPoint, CGRect, CGSize};
    use core_graphics::window::{
        create_image, kCGWindowImageBestResolution, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowListOptionIncludingWindow,
    };
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
    encode_cg_image_png(image.as_ref())
}

#[cfg(target_os = "macos")]
fn encode_cg_image_png(image_ref: &core_graphics::image::CGImageRef) -> Result<Vec<u8>, String> {
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    let width = image_ref.width();
    let height = image_ref.height();
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
fn capture_main_screen_png() -> Result<Vec<u8>, String> {
    use core_graphics::display::CGDisplay;
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
        .map_err(|_| "create cursor event source failed".to_string())?;
    let cursor = CGEvent::new(source)
        .map_err(|_| "read cursor position failed".to_string())?
        .location();
    let (display_ids, count) = CGDisplay::displays_with_point(cursor, 1)
        .map_err(|error| format!("resolve display under cursor failed: {error}"))?;
    if count == 0 {
        return Err("no display found under cursor".into());
    }
    let display = CGDisplay::new(display_ids[0]);
    let image = display
        .image()
        .ok_or_else(|| "capture display under cursor returned no image".to_string())?;
    encode_cg_image_png(image.as_ref())
}

#[cfg(not(target_os = "macos"))]
fn capture_main_screen_png() -> Result<Vec<u8>, String> {
    Err("screen screenshot is currently only supported on macOS".into())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::{clipboard_image_from_png, crop_png};
    use image::codecs::png::PngEncoder;
    use image::{ColorType, ImageEncoder};

    #[test]
    fn decodes_png_into_rgba_clipboard_image() {
        let rgba = [12, 34, 56, 255, 78, 90, 123, 200];
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, 2, 1, ColorType::Rgba8.into())
            .expect("encode fixture png");

        let image = clipboard_image_from_png(&png).expect("decode clipboard image");
        assert_eq!((image.width, image.height), (2, 1));
        assert_eq!(image.bytes.as_ref(), rgba);
    }

    #[test]
    fn crops_png_to_requested_pixel_bounds() {
        let rgba = [
            255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
        ];
        let mut png = Vec::new();
        PngEncoder::new(&mut png)
            .write_image(&rgba, 2, 2, ColorType::Rgba8.into())
            .expect("encode fixture png");

        let cropped = crop_png(&png, 1, 0, 1, 2).expect("crop png");
        let image = image::load_from_memory(&cropped)
            .expect("decode crop")
            .into_rgba8();
        assert_eq!(image.dimensions(), (1, 2));
        assert_eq!(image.as_raw(), &[0, 255, 0, 255, 255, 255, 255, 255]);
    }
}
