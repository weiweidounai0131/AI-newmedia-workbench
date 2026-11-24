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
use crate::downloader::douyin_sign::sign_detail;

const DOUYIN_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

static RE_HTTP_URL: Lazy<Regex> = Lazy::new(|| Regex::new(r#"https?://[^\s<>"'）】》]+"#).unwrap());
static RE_VIDEO_ID: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?:/video/|/note/|modal_id=|aweme_id=)(\d{15,22})"#).unwrap());

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DouyinDownloadResult {
    pub path: String,
    pub title: Option<String>,
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DouyinDownloadTask {
    pub id: String,
    pub status: String, // starting | running | completed | failed
    pub link: String,
    pub percent: f64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub result: Option<DouyinDownloadResult>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgressEvent {
    pub task_id: String,
    pub platform: String,
    pub status: String,
    pub percent: f64,
    pub message: String,
}

static TASKS: Lazy<Mutex<HashMap<String, DouyinDownloadTask>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

pub fn extract_http_url(input: &str) -> Option<String> {
    RE_HTTP_URL.find(input).map(|m| m.as_str().to_string())
}

fn update_task(
    app: &AppHandle,
    task_id: &str,
    status: &str,
    percent: f64,
    message: String,
    error: Option<String>,
    result: Option<DouyinDownloadResult>,
) {
    {
        let mut guard = TASKS.lock().unwrap();
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
            platform: "抖音".to_string(),
            status: status.to_string(),
            percent,
            message,
        },
    );
}

async fn resolve_aweme_id(client: &Client, link: &str) -> Result<String, String> {
    if let Some(cap) = RE_VIDEO_ID.captures(link) {
        return Ok(cap[1].to_string());
    }
    // 跟随短链（如 v.douyin.com）重定向获取真实视频 ID
    let resp = client
        .get(link)
        .header("User-Agent", DOUYIN_UA)
        .send()
        .await
        .map_err(|e| format!("解析抖音短链失败：{e}"))?;
    let final_url = resp.url().as_str().to_string();
    if let Some(cap) = RE_VIDEO_ID.captures(&final_url) {
        return Ok(cap[1].to_string());
    }
    Err("未能从该抖音链接中识别视频 ID，请粘贴完整视频分享链接".into())
}

async fn try_douyin_json_api(
    client: &Client,
    url: &str,
    referer: &str,
    cookie_header: Option<&str>,
    label: &str,
) -> Option<Value> {
    let mut req = client
        .get(url)
        .header("User-Agent", DOUYIN_UA)
        .header("Accept", "application/json, text/plain, */*")
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .header("Referer", referer);
    if let Some(ck) = cookie_header {
        req = req.header("Cookie", ck);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            crate::core::logger::warn("download:douyin", format!("{label} request error: {e}"));
            return None;
        }
    };
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    crate::core::logger::info("download:douyin", format!("{label} status={status} body_len={}", text.len()));
    if status != 200 || text.trim().is_empty() {
        return None;
    }
    serde_json::from_str::<Value>(&text).ok()
}

async fn fetch_video_meta_with_fallback(
    client: &Client,
    aweme_id: &str,
    cookie_header: Option<&str>,
) -> Result<(String, String), String> {
    let referer = format!("https://www.douyin.com/video/{aweme_id}");
    let base_params = format!(
        "aweme_id={aweme_id}&aid=6383&version_name=23.5.0&device_platform=webapp&os=windows"
    );

    // 1. 无签名直查 detail（对齐 wechat-mp-tools unsigned-first 策略）
    let unsigned_url = format!("https://www.douyin.com/aweme/v1/web/aweme/detail/?{base_params}");
    if let Some(body) = try_douyin_json_api(client, &unsigned_url, &referer, cookie_header, "detail_unsigned").await {
        if let Some(detail) = body.get("aweme_detail") {
            if let Some(pair) = cdp_manager::extract_douyin_title_and_video_url(detail) {
                return Ok(pair);
            }
        }
    }

    // 2. 带 Rust 原生 a_bogus 签名查 detail
    let a_bogus = sign_detail(&base_params, DOUYIN_UA);
    let encoded_ab: String = url::form_urlencoded::byte_serialize(a_bogus.as_bytes()).collect();
    let signed_url = format!(
        "https://www.douyin.com/aweme/v1/web/aweme/detail/?{base_params}&a_bogus={encoded_ab}"
    );
    if let Some(body) = try_douyin_json_api(client, &signed_url, &referer, cookie_header, "detail_signed").await {
        if let Some(detail) = body.get("aweme_detail") {
            if let Some(pair) = cdp_manager::extract_douyin_title_and_video_url(detail) {
                return Ok(pair);
            }
        }
    }

    // 3. multi/aweme/detail 兜底
    let multi_url = format!(
        "https://www.douyin.com/aweme/v1/web/multi/aweme/detail/?aweme_ids=%5B{aweme_id}%5D&request_source=200"
    );
    if let Some(body) = try_douyin_json_api(client, &multi_url, &referer, cookie_header, "multi_detail").await {
        if let Some(arr) = body.get("aweme_details").and_then(|v| v.as_array()) {
            let hit = arr
                .iter()
                .find(|d| d.get("aweme_id").and_then(|v| v.as_str()) == Some(aweme_id))
                .or_else(|| arr.first());
            if let Some(detail) = hit {
                if let Some(pair) = cdp_manager::extract_douyin_title_and_video_url(detail) {
                    return Ok(pair);
                }
            }
        }
    }

    // 4. 终极兜底：通过已登录的真实浏览器 CDP 会话拦截官方前端 detail API / <video> 直链
    cdp_manager::fetch_douyin_video_detail_via_cdp(aweme_id).await
}

async fn run_douyin_task(app: AppHandle, task_id: String, raw_link: String) {
    let result: Result<DouyinDownloadResult, String> = async {
        let link = extract_http_url(&raw_link)
            .ok_or_else(|| "未识别到有效的抖音 http(s) 链接".to_string())?;

        update_task(&app, &task_id, "running", 12.0, "正在解析抖音链接与视频 ID…".into(), None, None);

        // 抖音接口与视频 CDN 固定国内直连，绝不走系统外网代理
        let client = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(90))
            .redirect(reqwest::redirect::Policy::limited(8))
            .build()
            .map_err(|e| e.to_string())?;

        let aweme_id = resolve_aweme_id(&client, &link).await?;
        update_task(&app, &task_id, "running", 28.0, "正在解析无水印视频直链…".into(), None, None);

        let cookie = cdp_manager::get_cookie_header(PlatformKey::Douyin).await.ok();
        let (title, video_url) = fetch_video_meta_with_fallback(&client, &aweme_id, cookie.as_deref()).await?;

        update_task(&app, &task_id, "running", 45.0, format!("已解析《{}》，正在流式下载无水印视频…", title.chars().take(24).collect::<String>()), None, None);

        let download_dir = if let Some(custom) = crate::core::settings::load_stored()
            .ok()
            .and_then(|s| s.xhs_download_dir)
            .filter(|s| !s.trim().is_empty())
        {
            PathBuf::from(custom).join("douyin")
        } else {
            resolve_app_data_dir()
                .map_err(|e| e.to_string())?
                .join("downloads")
                .join("douyin")
        };
        fs::create_dir_all(&download_dir).map_err(|e| format!("创建下载目录失败：{e}"))?;

        let short_title: String = title.chars().take(36).collect();
        let filename = format!("{}_{}.mp4", safe_filename(&short_title), aweme_id);
        let target_path: PathBuf = download_dir.join(filename);

        let mut req = client
            .get(&video_url)
            .header("User-Agent", DOUYIN_UA)
            .header("Referer", "https://www.douyin.com/");
        if let Some(ck) = cookie.as_deref() {
            req = req.header("Cookie", ck);
        }
        let mut resp = req
            .send()
            .await
            .map_err(|e| format!("下载抖音视频流失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("视频流返回 HTTP {}", resp.status().as_u16()));
        }

        let total = resp.content_length().unwrap_or(0);
        let mut downloaded: u64 = 0;
        let mut out_bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取视频流中断：{e}"))? {
            out_bytes.extend_from_slice(&chunk);
            downloaded += chunk.len() as u64;
            if total > 0 {
                let pct = 45.0 + (downloaded as f64 / total as f64) * 50.0;
                update_task(
                    &app,
                    &task_id,
                    "running",
                    pct.min(95.0),
                    format!(
                        "正在下载视频 {:.1} MB / {:.1} MB…",
                        downloaded as f64 / 1024.0 / 1024.0,
                        total as f64 / 1024.0 / 1024.0
                    ),
                    None,
                    None,
                );
            }
        }
        if out_bytes.is_empty() {
            return Err("下载到的抖音视频文件为空".into());
        }
        fs::write(&target_path, &out_bytes).map_err(|e| format!("保存视频文件失败：{e}"))?;

        Ok(DouyinDownloadResult {
            path: target_path.to_string_lossy().to_string(),
            title: Some(title),
            size_bytes: Some(out_bytes.len() as u64),
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
                "抖音无水印视频下载完成".into(),
                None,
                Some(res),
            );
        }
        Err(err) => {
            crate::core::logger::error("download:douyin", format!("task {task_id} failed: {err}"));
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
    let task = DouyinDownloadTask {
        id: id.clone(),
        status: "starting".into(),
        link: link.clone(),
        percent: 5.0,
        message: Some("正在启动抖音原生下载任务…".into()),
        error: None,
        result: None,
    };
    TASKS.lock().unwrap().insert(id.clone(), task);

    let tid = id.clone();
    tauri::async_runtime::spawn(async move {
        run_douyin_task(app, tid, link).await;
    });
    id
}

pub fn get_task(task_id: &str) -> Option<DouyinDownloadTask> {
    TASKS.lock().unwrap().get(task_id).cloned()
}
