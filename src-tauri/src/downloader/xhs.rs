use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::cdp::manager as cdp_manager;
use crate::cdp::platforms::PlatformKey;
use crate::core::library::safe_filename;
use crate::core::paths::resolve_app_data_dir;
use crate::core::settings;
use crate::downloader::douyin::{extract_http_url, DownloadProgressEvent};

const XHS_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
static RE_NOTE_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:explore|discovery/item|search_result|item)/([0-9a-zA-Z]+)"#).unwrap());

/// 规范化小红书笔记链接：将搜索页抽取出的 `/search_result/<note_id>` 自动转为标准 `/explore/<note_id>`（保留 xsec_token 等查询参数）
fn normalize_xhs_link(raw: &str) -> String {
    if raw.contains("xiaohongshu.com/search_result/") {
        return raw.replace("/search_result/", "/explore/");
    }
    raw.to_string()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XhsDownloadResult {
    pub path: String,
    pub title: Option<String>,
    pub image_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct XhsDownloadTask {
    pub id: String,
    pub status: String,
    pub link: String,
    pub percent: f64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub result: Option<XhsDownloadResult>,
}

static XHS_TASKS: Lazy<Mutex<HashMap<String, XhsDownloadTask>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn update_task(
    app: &AppHandle,
    task_id: &str,
    status: &str,
    percent: f64,
    message: String,
    error: Option<String>,
    result: Option<XhsDownloadResult>,
) {
    {
        let mut guard = XHS_TASKS.lock().unwrap();
        if let Some(t) = guard.get_mut(task_id) {
            t.status = status.to_string();
            t.percent = percent;
            t.message = Some(message.clone());
            t.error = error;
            if result.is_some() {
                t.result = result;
            }
        }
    }
    let _ = app.emit(
        "download-progress",
        DownloadProgressEvent {
            task_id: task_id.to_string(),
            platform: "小红书".to_string(),
            status: status.to_string(),
            percent,
            message,
        },
    );
}

fn resolve_xhs_download_base() -> Result<PathBuf, String> {
    if let Ok(stored) = settings::load_stored() {
        if let Some(custom) = stored.xhs_download_dir.filter(|s| !s.trim().is_empty()) {
            let p = PathBuf::from(custom).join("xhs");
            fs::create_dir_all(&p).map_err(|e| format!("创建小红书缓存目录失败：{e}"))?;
            return Ok(p);
        }
    }
    let dir = resolve_app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads")
        .join("xhs");
    fs::create_dir_all(&dir).map_err(|e| format!("创建小红书下载目录失败：{e}"))?;
    Ok(dir)
}

fn extract_note_from_state(state: &Value) -> Option<&Value> {
    if let Some(n) = state.pointer("/noteData/data/noteData") {
        if n.is_object() {
            return Some(n);
        }
    }
    if let Some(map) = state.pointer("/note/noteDetailMap").and_then(|v| v.as_object()) {
        for val in map.values().rev() {
            if let Some(n) = val.get("note") {
                if n.is_object() {
                    return Some(n);
                }
            }
        }
    }
    None
}

async fn run_xhs_task(app: AppHandle, task_id: String, raw_link: String) {
    let result: Result<XhsDownloadResult, String> = async {
        let extracted = extract_http_url(&raw_link)
            .ok_or_else(|| "未识别到有效的小红书 http(s) 链接".to_string())?;
        let link = normalize_xhs_link(&extracted);
        crate::core::logger::info("download:xhs", format!("task {task_id} normalized link={link}"));

        update_task(&app, &task_id, "running", 18.0, "正在通过共享浏览器会话读取小红书笔记内容…".into(), None, None);

        // 直接复用 Phase 3 CDP 真实登录会话提取 __INITIAL_STATE__（天然真实指纹，免 curl_cffi / xhshow）
        let state = cdp_manager::fetch_initial_state_via_cdp(PlatformKey::Xhs, &link).await?;
        let note = extract_note_from_state(&state)
            .ok_or_else(|| "未能解析到笔记详情，请确认小红书已在设置页登录且链接未失效".to_string())?;

        let note_id = note
            .get("noteId")
            .or_else(|| note.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| RE_NOTE_ID.captures(&link).map(|c| c[1].to_string()))
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()[..8].to_string());

        let title = note
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("小红书图文")
            .to_string();
        let desc = note
            .get("desc")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();

        let mut image_urls = Vec::new();
        if let Some(list) = note.get("imageList").and_then(|v| v.as_array()) {
            for img in list {
                let u = img
                    .get("urlDefault")
                    .or_else(|| img.get("url"))
                    .or_else(|| img.get("urlPre"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.replace("http://", "https://"));
                if let Some(url) = u.filter(|s| s.starts_with("http")) {
                    image_urls.push(url);
                }
            }
        }

        let base = resolve_xhs_download_base()?;
        let short_title: String = title.chars().take(32).collect();
        let note_dir = base.join(format!("{}_{}", safe_filename(&short_title), note_id));
        fs::create_dir_all(&note_dir).map_err(|e| format!("创建笔记目录失败：{e}"))?;

        let text_content = format!("标题：{title}\n\n正文：\n{desc}\n\n来源：{link}\n");
        fs::write(note_dir.join("文案.txt"), text_content)
            .map_err(|e| format!("写入文案.txt 失败：{e}"))?;

        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(40))
            .build()
            .map_err(|e| e.to_string())?;

        let total = image_urls.len();
        let mut saved_count = 0usize;
        for (idx, img_url) in image_urls.iter().enumerate() {
            let pct = 35.0 + ((idx + 1) as f64 / (total.max(1) as f64)) * 60.0;
            update_task(
                &app,
                &task_id,
                "running",
                pct.min(95.0),
                format!("正在下载第 {} / {} 张无水印图片…", idx + 1, total),
                None,
                None,
            );
            if let Ok(resp) = client
                .get(img_url)
                .header("User-Agent", XHS_UA)
                .header("Referer", "https://www.xiaohongshu.com/")
                .send()
                .await
            {
                if resp.status().is_success() {
                    if let Ok(bytes) = resp.bytes().await {
                        if !bytes.is_empty() {
                            let ext = if bytes.starts_with(b"\x89PNG") {
                                "png"
                            } else if bytes.starts_with(b"RIFF") {
                                "webp"
                            } else {
                                "jpg"
                            };
                            let file = note_dir.join(format!("{:02}.{}", idx + 1, ext));
                            if fs::write(file, &bytes).is_ok() {
                                saved_count += 1;
                            }
                        }
                    }
                }
            }
        }

        Ok(XhsDownloadResult {
            path: note_dir.to_string_lossy().to_string(),
            title: Some(title),
            image_count: saved_count,
        })
    }
    .await;

    match result {
        Ok(res) => {
            update_task(
                &app,
                &task_id,
                "completed",
                100.0,
                format!("小红书图文下载完成（{} 张图片 + 文案.txt）", res.image_count),
                None,
                Some(res),
            );
        }
        Err(err) => {
            crate::core::logger::error("download:xhs", format!("task {task_id} failed: {err}"));
            update_task(
                &app,
                &task_id,
                "failed",
                0.0,
                err.clone(),
                Some(err),
                None,
            );
        }
    }
}

pub fn start_task(app: AppHandle, link: String) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let task = XhsDownloadTask {
        id: id.clone(),
        status: "starting".into(),
        link: link.clone(),
        percent: 5.0,
        message: Some("正在启动小红书原生图文下载…".into()),
        error: None,
        result: None,
    };
    XHS_TASKS.lock().unwrap().insert(id.clone(), task);

    let tid = id.clone();
    tauri::async_runtime::spawn(async move {
        run_xhs_task(app, tid, link).await;
    });
    id
}

pub fn get_task(task_id: &str) -> Option<XhsDownloadTask> {
    XHS_TASKS.lock().unwrap().get(task_id).cloned()
}
