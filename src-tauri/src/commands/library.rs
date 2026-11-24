use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::Serialize;

use crate::core::library::{self, ExportPayload, LibTopic, LibraryStatus};

#[derive(Debug, Serialize)]
pub struct OkResp {
    pub ok: bool,
}

#[derive(Debug, Serialize)]
pub struct WordTextResp {
    pub text: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordDownloadResp {
    pub file_name: String,
    pub base64: String,
}

#[tauri::command]
pub fn list_library() -> LibraryStatus {
    library::status()
}

#[tauri::command]
pub fn set_library_root(root_dir: String) -> Result<LibraryStatus, String> {
    library::set_root(&root_dir)
}

#[tauri::command]
pub fn initialize_library() -> Result<LibraryStatus, String> {
    library::initialize()
}

#[tauri::command]
pub fn export_library_file(payload: ExportPayload) -> Result<LibraryStatus, String> {
    library::export_file(payload)
}

#[tauri::command]
pub fn build_word_download(name: String, content: String) -> Result<WordDownloadResp, String> {
    let base = library::safe_filename(&name);
    let clean = base.strip_suffix(".docx").unwrap_or(&base);
    let bytes = library::build_docx_bytes(&content)?;
    Ok(WordDownloadResp {
        file_name: format!("{clean}.docx"),
        base64: B64.encode(bytes),
    })
}

#[tauri::command]
pub fn parse_word_base64(name: String, data: String) -> Result<WordTextResp, String> {
    if !name.to_lowercase().ends_with(".docx") {
        return Err("目前仅支持解析 .docx 文件".into());
    }
    let raw_b64 = data.split(',').next_back().unwrap_or("");
    let bytes = B64
        .decode(raw_b64)
        .map_err(|e| format!("Word 文件 Base64 解码失败：{e}"))?;
    let text = library::parse_docx_bytes(&bytes)?;
    Ok(WordTextResp { text })
}

#[tauri::command]
pub fn read_library_word(folder: String, name: String) -> Result<WordTextResp, String> {
    let text = library::read_library_word(&folder, &name)?;
    Ok(WordTextResp { text })
}

#[tauri::command]
pub fn open_library_file(folder: String, name: String, reveal: bool) -> Result<OkResp, String> {
    library::open_or_reveal_file(&folder, &name, reveal)?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
pub fn read_library_image_data_url(folder: String, name: String) -> Result<String, String> {
    let full = library::resolve_file_path(&folder, &name)?;
    let bytes = std::fs::read(&full).map_err(|e| format!("读取本地图片失败：{e}"))?;
    let lower = name.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "image/jpeg"
    };
    Ok(format!("data:{mime};base64,{}", B64.encode(bytes)))
}

#[tauri::command]
pub fn save_topics_xlsx(path: String, topics: Vec<LibTopic>) -> Result<OkResp, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("保存路径不能为空".into());
    }
    let bytes = library::build_topics_xlsx_bytes(&topics)?;
    std::fs::write(trimmed, bytes).map_err(|e| format!("保存 Excel 失败：{e}"))?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
pub fn save_word_docx(path: String, content: String) -> Result<OkResp, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("保存路径不能为空".into());
    }
    let bytes = library::build_docx_bytes(&content)?;
    std::fs::write(trimmed, bytes).map_err(|e| format!("保存 Word 失败：{e}"))?;
    Ok(OkResp { ok: true })
}

#[tauri::command]
pub fn save_image_base64(path: String, data: String) -> Result<OkResp, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("保存路径不能为空".into());
    }
    let raw_b64 = data.split(',').next_back().unwrap_or("");
    let bytes = B64
        .decode(raw_b64)
        .map_err(|e| format!("图片解码失败：{e}"))?;
    std::fs::write(trimmed, bytes).map_err(|e| format!("保存图片失败：{e}"))?;
    Ok(OkResp { ok: true })
}
