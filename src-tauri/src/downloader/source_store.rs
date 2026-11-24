use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Client;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use crate::core::ai_proxy::{self, VisionPart};
use crate::core::caps::CapId;
use crate::downloader::douyin::extract_http_url;

static RE_SCRIPT_STYLE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?is)<(script|style|noscript)[^>]*>.*?</(script|style|noscript)>").unwrap());
static RE_HTML_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());
static RE_TITLE_TAG: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());
static RE_WS: Lazy<Regex> = Lazy::new(|| Regex::new(r"[ \t\r]+").unwrap());
static RE_NL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\n{3,}").unwrap());

#[derive(Debug, Clone, Serialize)]
pub struct SourceFeedback {
    pub tone: String, // success | warning | danger
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSnapshot {
    pub source_id: String,
    pub media_type: String,
    pub platform: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub text: Option<String>,
    pub file_count: usize,
    pub has_local_media: bool,
    pub feedback: SourceFeedback,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognizeSourceResp {
    pub media_type: String,
    pub recog: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub message: Option<String>,
    pub feedback: SourceFeedback,
}

#[derive(Clone)]
struct CachedSource {
    media_type: String,
    title: Option<String>,
    text: Option<String>,
    files: Vec<String>,
    feedback: SourceFeedback,
}

static SOURCE_CACHE: Lazy<Mutex<HashMap<String, CachedSource>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn put_source(src: CachedSource) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut guard = SOURCE_CACHE.lock().unwrap();
    if guard.len() > 24 {
        guard.clear();
    }
    guard.insert(id.clone(), src);
    id
}

fn fmt_size(bytes: u64) -> String {
    if bytes < 1024 {
        format!("{bytes} B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
    }
}

pub fn import_douyin_video(file_path: &str, title: Option<String>) -> Result<SourceSnapshot, String> {
    let p = Path::new(file_path);
    let meta = fs::metadata(p).map_err(|_| "未找到已下载的抖音视频文件，请重新解析".to_string())?;
    if !meta.is_file() || meta.len() == 0 {
        return Err("视频文件无效或为空".into());
    }
    let feedback = SourceFeedback {
        tone: "success".into(),
        title: "抖音无水印视频已就绪".into(),
        items: vec![
            format!("视频体积：{}", fmt_size(meta.len())),
            "已准备好交给视频识别模型提取完整文案与画面要点".into(),
        ],
    };
    let source_id = put_source(CachedSource {
        media_type: "video".into(),
        title: title.clone(),
        text: None,
        files: vec![file_path.to_string()],
        feedback: feedback.clone(),
    });
    Ok(SourceSnapshot {
        source_id,
        media_type: "video".into(),
        platform: Some("抖音".into()),
        title,
        description: None,
        text: None,
        file_count: 1,
        has_local_media: true,
        feedback,
    })
}

pub fn import_xhs_note(note_dir: &str, title: Option<String>) -> Result<SourceSnapshot, String> {
    let dir = Path::new(note_dir);
    if !dir.is_dir() {
        return Err("未找到小红书图文下载目录，请重新解析".into());
    }
    let mut images = Vec::new();
    let mut total_bytes = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let lower = path.to_string_lossy().to_lowercase();
            if lower.ends_with(".jpg")
                || lower.ends_with(".jpeg")
                || lower.ends_with(".png")
                || lower.ends_with(".webp")
            {
                total_bytes += meta.len();
                images.push(path.to_string_lossy().to_string());
            }
        }
    }
    images.sort();

    let text = fs::read_to_string(dir.join("文案.txt")).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let file_count = images.len();

    let feedback = SourceFeedback {
        tone: if file_count > 0 || text.is_some() { "success" } else { "warning" }.into(),
        title: format!("小红书图文已就绪（{file_count} 张图片）"),
        items: vec![
            format!("图片素材：{file_count} 张（共 {}）", fmt_size(total_bytes)),
            if text.is_some() {
                "已读取原笔记文案.txt".into()
            } else {
                "未包含文字文案，将依赖图片视觉识别".into()
            },
        ],
    };

    let source_id = put_source(CachedSource {
        media_type: "image".into(),
        title: title.clone(),
        text: text.clone(),
        files: images,
        feedback: feedback.clone(),
    });

    Ok(SourceSnapshot {
        source_id,
        media_type: "image".into(),
        platform: Some("小红书".into()),
        title,
        description: None,
        text,
        file_count,
        has_local_media: file_count > 0,
        feedback,
    })
}

fn find_ffmpeg_path() -> Option<String> {
    let mut candidates = Vec::new();
    #[cfg(target_os = "macos")]
    {
        candidates.push("/opt/homebrew/bin/ffmpeg");
        candidates.push("/usr/local/bin/ffmpeg");
    }
    #[cfg(target_os = "windows")]
    {
        candidates.push(r"C:\ffmpeg\bin\ffmpeg.exe");
    }
    for c in candidates {
        if Path::new(c).is_file() {
            return Some(c.to_string());
        }
    }
    let bin = if cfg!(target_os = "windows") {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    if std::process::Command::new(bin)
        .arg("-version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some(bin.to_string());
    }
    None
}

/// 从本地视频按时间均匀抽取最多 6 帧轻量化关键帧 JPEG（宽度缩至 ≤960px，兼容全部 3 种多模态协议且永不爆请求体）
async fn extract_video_keyframes(video_path: &str) -> Result<Vec<VisionPart>, String> {
    let ffmpeg = find_ffmpeg_path()
        .ok_or_else(|| "未检测到 FFmpeg，无法抽取视频关键帧".to_string())?;
    let temp_dir = std::env::temp_dir().join(format!("newmedia-frames-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&temp_dir).map_err(|e| format!("创建临时抽帧目录失败：{e}"))?;

    let pattern = temp_dir.join("frame-%02d.jpg");
    // 先尝试按 1/5 秒采样（常规短视频），若视频很短不足 2 帧再按 1fps 兜底
    let run_ffmpeg = |vf: &str| {
        let ffmpeg = ffmpeg.clone();
        let video_path = video_path.to_string();
        let pattern_str = pattern.to_string_lossy().to_string();
        let vf = vf.to_string();
        async move {
            let mut cmd = tokio::process::Command::new(&ffmpeg);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x0800_0000);
            cmd.args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                    &video_path,
                    "-vf",
                    &vf,
                    "-q:v",
                    "5",
                    "-frames:v",
                    "6",
                    &pattern_str,
                ])
                .output()
                .await
        }
    };

    let _ = run_ffmpeg("fps=1/5,scale='min(960,iw)':-2").await;
    let mut frame_paths: Vec<std::path::PathBuf> = fs::read_dir(&temp_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jpg"))
        .collect();
    if frame_paths.is_empty() {
        let _ = run_ffmpeg("fps=1,scale='min(960,iw)':-2").await;
        frame_paths = fs::read_dir(&temp_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jpg"))
            .collect();
    }
    frame_paths.sort();

    let mut parts = Vec::new();
    let mut total_bytes = 0usize;
    for fp in frame_paths.into_iter().take(6) {
        if let Ok(bytes) = fs::read(&fp) {
            if !bytes.is_empty() {
                total_bytes += bytes.len();
                parts.push(VisionPart {
                    part_type: "image".into(),
                    data: B64.encode(bytes),
                    mime: Some("image/jpeg".into()),
                });
            }
        }
    }
    let _ = fs::remove_dir_all(&temp_dir);

    if parts.is_empty() {
        return Err("FFmpeg 未能从视频中抽取出有效画面帧".into());
    }
    crate::core::logger::info(
        "source:video",
        format!("extracted {} keyframes ({} KB) via ffmpeg", parts.len(), total_bytes / 1024),
    );
    Ok(parts)
}

pub async fn recognize_source(source_id: &str) -> Result<RecognizeSourceResp, String> {
    let src = {
        let guard = SOURCE_CACHE.lock().unwrap();
        guard
            .get(source_id)
            .cloned()
            .ok_or_else(|| "来源会话已过期，请重新解析链接".to_string())?
    };

    if src.files.is_empty() {
        let text = src.text.unwrap_or_default();
        if text.is_empty() {
            return Err("当前来源没有可识别的文字或媒体文件".into());
        }
        return Ok(RecognizeSourceResp {
            media_type: src.media_type,
            recog: text,
            title: src.title,
            model: Some("local-text".into()),
            message: None,
            feedback: src.feedback,
        });
    }

    let mut parts = Vec::new();
    if src.media_type == "video" {
        let video_file = &src.files[0];
        // 优先使用 FFmpeg 抽取轻量化关键帧图片序列（兼容性最强，支持 OpenAI/Responses/Anthropic 全部协议，且避免几十 MB MP4 撑爆网关）
        match extract_video_keyframes(video_file).await {
            Ok(frames) => parts = frames,
            Err(frame_err) => {
                crate::core::logger::warn("source:video", format!("keyframe extract fallback: {frame_err}"));
                let bytes = fs::read(video_file).map_err(|e| format!("读取本地视频失败：{e}"))?;
                if bytes.len() > 15 * 1024 * 1024 {
                    return Err(format!(
                        "{frame_err}；且该视频体积达 {:.1} MB（超过直传限制），请安装 FFmpeg 后重试",
                        bytes.len() as f64 / 1024.0 / 1024.0
                    ));
                }
                parts.push(VisionPart {
                    part_type: "video".into(),
                    data: B64.encode(bytes),
                    mime: Some("video/mp4".into()),
                });
            }
        }
    } else {
        for file in src.files.iter().take(6) {
            let bytes = fs::read(file).map_err(|e| format!("读取本地素材失败：{e}"))?;
            let lower = file.to_lowercase();
            let mime = if lower.ends_with(".png") {
                "image/png"
            } else if lower.ends_with(".webp") {
                "image/webp"
            } else {
                "image/jpeg"
            };
            parts.push(VisionPart {
                part_type: "image".into(),
                data: B64.encode(bytes),
                mime: Some(mime.into()),
            });
        }
    }

    let cap = if src.media_type == "video" {
        CapId::VisionVideo
    } else {
        CapId::VisionImg
    };
    let sys_hint = src
        .title
        .as_deref()
        .filter(|t| !t.trim().is_empty())
        .map(|t| format!("该素材的原标题为：「{t}」。请结合标题与画面信息忠实提炼完整中文稿件。"));
    let ai = ai_proxy::recognize_media(cap, &parts, sys_hint.as_deref()).await?;
    let merged = if let Some(raw_text) = src.text.filter(|t| !t.is_empty()) {
        format!("{raw_text}\n\n---\n【AI 视觉补充识别】\n{}", ai.text)
    } else {
        ai.text
    };

    Ok(RecognizeSourceResp {
        media_type: src.media_type,
        recog: merged,
        title: src.title,
        model: Some(ai.model),
        message: None,
        feedback: src.feedback,
    })
}

/// 通用公开链接识别（外部文章直接抽正文；公开图片直交视觉模型）
pub async fn recognize_public_link(input: &str) -> Result<RecognizeSourceResp, String> {
    let url = extract_http_url(input)
        .ok_or_else(|| "未找到可识别的 http(s) 链接".to_string())?;
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("User-Agent", "Mozilla/5.0 (compatible; NewMediaWorkbenchRS/1.0)")
        .send()
        .await
        .map_err(|e| format!("抓取链接失败：{e}"))?;
    let ct = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    if ct.starts_with("image/") {
        let part = VisionPart {
            part_type: "image".into(),
            data: B64.encode(&bytes),
            mime: Some(ct.split(';').next().unwrap_or("image/jpeg").to_string()),
        };
        let ai = ai_proxy::recognize_media(CapId::VisionImg, &[part], None).await?;
        let fb = SourceFeedback {
            tone: "success".into(),
            title: "图片链接识别完成".into(),
            items: vec![format!("已通过 {} 识别图片内容", ai.model)],
        };
        return Ok(RecognizeSourceResp {
            media_type: "image".into(),
            recog: ai.text,
            title: None,
            model: Some(ai.model),
            message: None,
            feedback: fb,
        });
    }

    let html = String::from_utf8_lossy(&bytes);
    let title = RE_TITLE_TAG
        .captures(&html)
        .map(|c| c[1].trim().to_string())
        .filter(|s| !s.is_empty());
    let cleaned = RE_SCRIPT_STYLE.replace_all(&html, "\n");
    let stripped = RE_HTML_TAG.replace_all(&cleaned, "\n");
    let compact = RE_WS.replace_all(&stripped, " ");
    let text = RE_NL.replace_all(&compact, "\n\n").trim().to_string();
    if text.is_empty() {
        return Err("未能从该网页提取到可读正文".into());
    }
    let clipped: String = text.chars().take(12000).collect();
    let fb = SourceFeedback {
        tone: "success".into(),
        title: "网页正文提取完成".into(),
        items: vec![format!("已提取 {} 字公开网页正文", clipped.chars().count())],
    };
    Ok(RecognizeSourceResp {
        media_type: "article".into(),
        recog: clipped,
        title,
        model: Some("html-extractor".into()),
        message: None,
        feedback: fb,
    })
}
