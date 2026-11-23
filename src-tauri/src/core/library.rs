use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::{DateTime, Local};
use once_cell::sync::Lazy;
use regex::Regex;
use rust_xlsxwriter::{Format, Workbook};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::core::settings;

pub const FOLDERS: [&str; 4] = ["选题", "创意", "洗稿", "图片"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibTopic {
    pub title: String,
    #[serde(default = "default_source")]
    pub source: String,
    pub platform: String,
    pub heat: Option<String>,
    pub likes: Option<String>,
    pub comments: Option<String>,
    pub link: Option<String>,
}

fn default_source() -> String {
    "热榜".to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibFile {
    pub folder: String,
    pub name: String,
    pub date: String,
    pub kind: String,
    pub local_path: String,
    pub size: u64,
    pub modified_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryStatus {
    pub root_dir: Option<String>,
    pub missing_folders: Vec<String>,
    pub ready: bool,
    pub files: Vec<LibFile>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub folder: String,
    pub name: String,
    pub kind: String,
    pub content: Option<String>,
    pub data: Option<String>,
    pub topics: Option<Vec<LibTopic>>,
}

pub fn safe_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed
    }
}

fn kind_for(folder: &str, name: &str) -> Option<&'static str> {
    let lower = name.to_lowercase();
    match folder {
        "选题" => lower.ends_with(".xlsx").then_some("x"),
        "洗稿" | "创意" => lower.ends_with(".docx").then_some("w"),
        "图片" => (lower.ends_with(".png")
            || lower.ends_with(".jpg")
            || lower.ends_with(".jpeg")
            || lower.ends_with(".webp"))
        .then_some("i"),
        _ => None,
    }
}

fn missing_folders(root: Option<&str>) -> Vec<String> {
    let Some(root) = root else {
        return FOLDERS.iter().map(|s| s.to_string()).collect();
    };
    FOLDERS
        .iter()
        .filter(|f| !Path::new(root).join(f).is_dir())
        .map(|s| s.to_string())
        .collect()
}

fn scan_files(root: Option<&str>) -> Vec<LibFile> {
    let Some(root) = root else {
        return vec![];
    };
    let mut files = Vec::new();
    for folder in FOLDERS {
        let dir = Path::new(root).join(folder);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !meta.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(kind) = kind_for(folder, &name) else {
                continue;
            };
            let modified = meta.modified().ok();
            let modified_ms = modified
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let date = modified
                .map(|t| {
                    let dt: DateTime<Local> = t.into();
                    dt.format("%Y%m%d").to_string()
                })
                .unwrap_or_else(|| Local::now().format("%Y%m%d").to_string());

            files.push(LibFile {
                folder: folder.to_string(),
                name: name.clone(),
                date,
                kind: kind.to_string(),
                local_path: format!("{folder}/{name}"),
                size: meta.len(),
                modified_at: modified_ms,
            });
        }
    }
    files.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
    files
}

pub fn status() -> LibraryStatus {
    let root_dir = settings::current_root_dir();
    let missing = missing_folders(root_dir.as_deref());
    let ready = root_dir.is_some() && missing.is_empty();
    let files = scan_files(root_dir.as_deref());
    LibraryStatus {
        root_dir,
        missing_folders: missing,
        ready,
        files,
    }
}

pub fn set_root(input: &str) -> Result<LibraryStatus, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("请选择有效的本地目录".into());
    }
    let expanded = if trimmed == "~" {
        dirs::home_dir().unwrap_or_else(|| PathBuf::from(trimmed))
    } else if let Some(rest) = trimmed.strip_prefix("~/").or_else(|| trimmed.strip_prefix("~\\")) {
        dirs::home_dir()
            .unwrap_or_default()
            .join(rest)
    } else {
        PathBuf::from(trimmed)
    };
    if expanded.exists() && !expanded.is_dir() {
        return Err("此路径是文件，请选择文件夹路径".into());
    }
    let normalized = expanded.to_string_lossy().to_string();
    settings::set_root_dir(Some(normalized))?;
    Ok(status())
}

pub fn initialize() -> Result<LibraryStatus, String> {
    let root = settings::current_root_dir().ok_or_else(|| "请先选择本地素材库目录".to_string())?;
    let root_path = Path::new(&root);
    fs::create_dir_all(root_path).map_err(|e| format!("创建素材库根目录失败：{e}"))?;
    for folder in FOLDERS {
        fs::create_dir_all(root_path.join(folder))
            .map_err(|e| format!("创建「{folder}」目录失败：{e}"))?;
    }
    Ok(status())
}

/// 纯 Rust 生成标准 OOXML `.docx` 文档（零外部依赖、全平台兼容 Word/WPS/Pages）
pub fn build_docx_bytes(content: &str) -> Result<Vec<u8>, String> {
    let mut paragraphs = String::new();
    for line in content.split('\n') {
        let escaped = xml_escape(if line.is_empty() { " " } else { line });
        paragraphs.push_str("<w:p><w:r><w:t xml:space=\"preserve\">");
        paragraphs.push_str(&escaped);
        paragraphs.push_str("</w:t></w:r></w:p>");
    }

    let document_xml = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{paragraphs}<w:sectPr/></w:body>
</w:document>"#
    );

    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"#;

    let rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>"#;

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut zip = ZipWriter::new(&mut cursor);
        let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

        zip.start_file("[Content_Types].xml", opts).map_err(|e| e.to_string())?;
        zip.write_all(content_types.as_bytes()).map_err(|e| e.to_string())?;

        zip.start_file("_rels/.rels", opts).map_err(|e| e.to_string())?;
        zip.write_all(rels.as_bytes()).map_err(|e| e.to_string())?;

        zip.start_file("word/document.xml", opts).map_err(|e| e.to_string())?;
        zip.write_all(document_xml.as_bytes()).map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(cursor.into_inner())
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

static RE_TAB: Lazy<Regex> = Lazy::new(|| Regex::new(r"<w:tab[^>]*/>").unwrap());
static RE_BR: Lazy<Regex> = Lazy::new(|| Regex::new(r"<w:br[^>]*/>").unwrap());
static RE_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_MULTI_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

/// 纯 Rust 解析 `.docx`（内存 zip 解压，跨 macOS/Windows，无需外部 unzip 命令）
pub fn parse_docx_bytes(bytes: &[u8]) -> Result<String, String> {
    if bytes.is_empty() || bytes.len() > 20 * 1024 * 1024 {
        return Err("Word 文件为空或超过 20 MB 限制".into());
    }
    let reader = Cursor::new(bytes);
    let mut archive = ZipArchive::new(reader)
        .map_err(|_| "Word 解析失败，请确认文件为未加密的标准 .docx".to_string())?;
    let mut doc = archive
        .by_name("word/document.xml")
        .map_err(|_| "Word 文件缺少正文结构（word/document.xml）".to_string())?;
    let mut xml = String::new();
    doc.read_to_string(&mut xml)
        .map_err(|e| format!("读取 Word 正文失败：{e}"))?;

    let s = RE_TAB.replace_all(&xml, "\t");
    let s = RE_BR.replace_all(&s, "\n");
    let s = s.replace("</w:p>", "\n");
    let s = RE_TAG.replace_all(&s, "");
    let s = s
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");
    let s = RE_MULTI_NL.replace_all(&s, "\n\n").trim().to_string();
    if s.is_empty() {
        return Err("未从 Word 中读取到正文内容".into());
    }
    Ok(s)
}

pub fn build_topics_xlsx_bytes(topics: &[LibTopic]) -> Result<Vec<u8>, String> {
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    ws.set_name("选题").map_err(|e| e.to_string())?;

    let header_fmt = Format::new().set_bold();
    let headers = [
        ("序列", 6.0),
        ("标题", 52.0),
        ("来源", 10.0),
        ("平台", 12.0),
        ("热度", 14.0),
        ("点赞", 14.0),
        ("评论", 14.0),
        ("链接", 44.0),
    ];
    for (col, (title, width)) in headers.iter().enumerate() {
        ws.set_column_width(col as u16, *width).map_err(|e| e.to_string())?;
        ws.write_string_with_format(0, col as u16, *title, &header_fmt)
            .map_err(|e| e.to_string())?;
    }

    for (idx, t) in topics.iter().enumerate() {
        let row = (idx + 1) as u32;
        let is_hot = t.source == "热榜";
        ws.write_number(row, 0, (idx + 1) as f64).map_err(|e| e.to_string())?;
        ws.write_string(row, 1, &t.title).map_err(|e| e.to_string())?;
        ws.write_string(row, 2, &t.source).map_err(|e| e.to_string())?;
        ws.write_string(row, 3, &t.platform).map_err(|e| e.to_string())?;
        ws.write_string(row, 4, if is_hot { t.heat.as_deref().unwrap_or("—") } else { "—" })
            .map_err(|e| e.to_string())?;
        ws.write_string(row, 5, if !is_hot { t.likes.as_deref().unwrap_or("—") } else { "—" })
            .map_err(|e| e.to_string())?;
        ws.write_string(row, 6, if !is_hot { t.comments.as_deref().unwrap_or("—") } else { "—" })
            .map_err(|e| e.to_string())?;
        ws.write_string(row, 7, t.link.as_deref().unwrap_or(""))
            .map_err(|e| e.to_string())?;
    }

    wb.save_to_buffer().map_err(|e| format!("生成 Excel 失败：{e}"))
}

pub fn export_file(payload: ExportPayload) -> Result<LibraryStatus, String> {
    if !FOLDERS.contains(&payload.folder.as_str()) {
        return Err("无效的素材库分类目录".into());
    }
    let state = status();
    let root = state.root_dir.ok_or_else(|| "请先选择本地素材库目录".to_string())?;
    if !state.ready {
        return Err(format!(
            "素材库缺少文件夹：{}，请先在素材库中初始化目录",
            state.missing_folders.join("、")
        ));
    }

    let name = safe_filename(&payload.name);
    let full = Path::new(&root).join(&payload.folder).join(&name);

    match payload.kind.as_str() {
        "i" => {
            let raw_b64 = payload
                .data
                .as_deref()
                .map(|d| d.split(',').next_back().unwrap_or(""))
                .unwrap_or("");
            if raw_b64.is_empty() {
                return Err("图片内容为空，无法导出".into());
            }
            let bytes = B64
                .decode(raw_b64)
                .map_err(|e| format!("图片 Base64 解码失败：{e}"))?;
            fs::write(&full, bytes).map_err(|e| format!("保存图片失败：{e}"))?;
        }
        "x" => {
            let bytes = build_topics_xlsx_bytes(payload.topics.as_deref().unwrap_or(&[]))?;
            fs::write(&full, bytes).map_err(|e| format!("保存 Excel 失败：{e}"))?;
        }
        "w" => {
            let bytes = build_docx_bytes(payload.content.as_deref().unwrap_or(""))?;
            fs::write(&full, bytes).map_err(|e| format!("保存 Word 失败：{e}"))?;
        }
        _ => return Err("未知导出文件类型".into()),
    }

    Ok(status())
}

pub fn resolve_file_path(folder: &str, name: &str) -> Result<PathBuf, String> {
    if !FOLDERS.contains(&folder) {
        return Err("目录非法".into());
    }
    if name.is_empty() || safe_filename(name) != name {
        return Err("文件名非法".into());
    }
    let root = settings::current_root_dir().ok_or_else(|| "素材库未配置".to_string())?;
    let full = Path::new(&root).join(folder).join(name);
    if !full.is_file() {
        return Err("文件不存在或已被外部移除".into());
    }
    Ok(full)
}

pub fn read_library_word(folder: &str, name: &str) -> Result<String, String> {
    let full = resolve_file_path(folder, name)?;
    let bytes = fs::read(&full).map_err(|e| format!("读取文件失败：{e}"))?;
    parse_docx_bytes(&bytes)
}

pub fn open_or_reveal_file(folder: &str, name: &str, reveal: bool) -> Result<(), String> {
    let full = resolve_file_path(folder, name)?;
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal {
            cmd.arg("-R");
        }
        cmd.arg(&full);
        cmd.spawn().map_err(|e| format!("打开文件失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        if reveal {
            std::process::Command::new("explorer.exe")
                .arg(format!("/select,{}", full.display()))
                .spawn()
                .map_err(|e| format!("定位文件失败：{e}"))?;
        } else {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", &full.to_string_lossy()])
                .spawn()
                .map_err(|e| format!("打开文件失败：{e}"))?;
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let target = if reveal {
            full.parent().unwrap_or(&full)
        } else {
            full.as_path()
        };
        std::process::Command::new("xdg-open")
            .arg(target)
            .spawn()
            .map_err(|e| format!("打开文件失败：{e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn docx_roundtrip_chinese_multiline() {
        let sample = "标题：广州电信千兆宽带科普\n第二行：包含特殊符号 & < > \" ' 测试\n\n结尾段落";
        let bytes = build_docx_bytes(sample).expect("build docx");
        let parsed = parse_docx_bytes(&bytes).expect("parse docx");
        assert!(parsed.contains("广州电信千兆宽带科普"));
        assert!(parsed.contains("& < > \" '"));
        assert!(parsed.contains("结尾段落"));
    }

    #[test]
    fn xlsx_topics_export_non_empty() {
        let topics = vec![LibTopic {
            title: "热门选题测试".into(),
            source: "热榜".into(),
            platform: "抖音".into(),
            heat: Some("120w".into()),
            likes: None,
            comments: None,
            link: Some("https://www.douyin.com/search/test".into()),
        }];
        let bytes = build_topics_xlsx_bytes(&topics).expect("build xlsx");
        assert!(bytes.len() > 500);
        assert_eq!(&bytes[..2], b"PK");
    }
}
