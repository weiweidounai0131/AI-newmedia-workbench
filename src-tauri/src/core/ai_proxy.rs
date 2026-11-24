use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use chrono::Utc;
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

use crate::core::caps::{validate_base_url, CapId, ProviderProtocol};
use crate::core::settings::{self, ProviderRequestSnapshot};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VisionPart {
    #[serde(rename = "type")]
    pub part_type: String, // "image" | "video"
    pub data: String,      // base64
    pub mime: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TextResult {
    pub text: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ImageOutput {
    pub b64: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageResult {
    pub images: Vec<ImageOutput>,
    pub model: String,
    pub used_edit: bool,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListResult {
    pub models: Vec<String>,
    pub fetched_at: String,
}

/// 自动探测外网代理（优先环境变量；macOS 从 Finder 启动未继承终端变量时自动读取 scutil --proxy；Windows 读取注册表）
/// 仅用于外网 AI API 与 Codex CLI，不影响本机 127.0.0.1 CDP 直连。
fn detect_system_proxy() -> Option<String> {
    for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"] {
        if let Ok(val) = std::env::var(key) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("scutil").arg("--proxy").output() {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let get_val = |k: &str| -> Option<String> {
                    for line in text.lines() {
                        let t = line.trim();
                        if let Some(rest) = t.strip_prefix(k) {
                            if let Some((_, v)) = rest.split_once(':') {
                                let v = v.trim();
                                if !v.is_empty() {
                                    return Some(v.to_string());
                                }
                            }
                        }
                    }
                    None
                };
                if get_val("HTTPSEnable").as_deref() == Some("1") {
                    if let (Some(h), Some(p)) = (get_val("HTTPSProxy"), get_val("HTTPSPort")) {
                        return Some(format!("http://{h}:{p}"));
                    }
                }
                if get_val("HTTPEnable").as_deref() == Some("1") {
                    if let (Some(h), Some(p)) = (get_val("HTTPProxy"), get_val("HTTPPort")) {
                        return Some(format!("http://{h}:{p}"));
                    }
                }
                if get_val("SOCKSEnable").as_deref() == Some("1") {
                    if let (Some(h), Some(p)) = (get_val("SOCKSProxy"), get_val("SOCKSPort")) {
                        return Some(format!("socks5://{h}:{p}"));
                    }
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = std::process::Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings",
            ])
            .output()
        {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                let enabled = text.lines().any(|l| l.contains("ProxyEnable") && l.contains("0x1"));
                if enabled {
                    for line in text.lines() {
                        if line.contains("ProxyServer") {
                            if let Some(val) = line.split_whitespace().last() {
                                let v = val.trim();
                                if !v.is_empty() {
                                    return Some(if v.contains("://") {
                                        v.to_string()
                                    } else {
                                        format!("http://{v}")
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

fn is_loopback_base_url(base_url: &str) -> bool {
    if let Ok(parsed) = url::Url::parse(base_url) {
        if let Some(host) = parsed.host_str() {
            let h = host.to_lowercase();
            return h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]";
        }
    }
    false
}

fn build_http_client_for(base_url: &str, timeout_secs: u64) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(Duration::from_secs(timeout_secs));
    // 本机中转网关（如 http://127.0.0.1:3050/v1）必须直连，严禁绕道系统外网代理
    if is_loopback_base_url(base_url) {
        builder = builder.no_proxy();
    } else if let Some(proxy_url) = detect_system_proxy() {
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
}

async fn log_and_map_http_error(
    resp: reqwest::Response,
    cap: Option<CapId>,
    model: &str,
    protocol: ProviderProtocol,
) -> String {
    let status = resp.status().as_u16();
    let raw_body = resp.text().await.unwrap_or_default();
    let snippet: String = raw_body.trim().chars().take(300).collect();
    crate::core::logger::error(
        "ai_proxy",
        format!(
            "http error status={status} cap={:?} proto={:?} model={model} body={snippet}",
            cap, protocol
        ),
    );
    let base_msg = map_http_error(status, cap);
    if !snippet.is_empty() && status >= 400 && status != 401 && status != 403 {
        // 尝试提取 JSON 中的 error.message 以便用户快速定位（如模型不支持视觉/超限等）
        if let Ok(v) = serde_json::from_str::<Value>(&raw_body) {
            if let Some(msg) = v
                .pointer("/error/message")
                .or_else(|| v.get("message"))
                .and_then(|m| m.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let short: String = msg.chars().take(180).collect();
                return format!("{base_msg}：{short}");
            }
        }
    }
    base_msg
}

fn map_http_error(status: u16, cap: Option<CapId>) -> String {
    match status {
        401 | 403 => {
            let label = cap.map(|c| c.label()).unwrap_or("上游服务");
            format!("{label}鉴权失败（HTTP {status}），请检查 API Key")
        }
        404 => "接口未找到（HTTP 404），请检查 API 根地址与所选协议".into(),
        429 => "上游请求限频（HTTP 429），请稍后重试".into(),
        _ => format!("AI 上游请求失败（HTTP {status}）"),
    }
}

fn endpoint(base_url: &str, suffix: &str) -> String {
    format!("{}{}", base_url.trim_end_matches('/'), suffix)
}

fn extract_chat_text(body: &Value) -> String {
    let content = &body["choices"][0]["message"]["content"];
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    if let Some(arr) = content.as_array() {
        return arr
            .iter()
            .filter_map(|p| {
                if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                    p.get("text").and_then(|v| v.as_str())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }
    String::new()
}

fn extract_responses_text(body: &Value) -> String {
    if let Some(s) = body.get("output_text").and_then(|v| v.as_str()) {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let mut parts = Vec::new();
    if let Some(outputs) = body.get("output").and_then(|v| v.as_array()) {
        for item in outputs {
            if item.get("type").and_then(|v| v.as_str()) == Some("message") {
                if let Some(content) = item.get("content").and_then(|v| v.as_array()) {
                    for c in content {
                        if c.get("type").and_then(|v| v.as_str()) == Some("output_text") {
                            if let Some(t) = c.get("text").and_then(|v| v.as_str()) {
                                parts.push(t);
                            }
                        }
                    }
                }
            }
        }
    }
    parts.join("\n")
}

fn extract_anthropic_text(body: &Value) -> String {
    let Some(arr) = body.get("content").and_then(|v| v.as_array()) else {
        return String::new();
    };
    arr.iter()
        .filter_map(|p| {
            if p.get("type").and_then(|v| v.as_str()) == Some("text") {
                p.get("text").and_then(|v| v.as_str())
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub async fn fetch_provider_models(
    provider_id: Option<&str>,
    raw_base_url: Option<&str>,
    protocol: Option<ProviderProtocol>,
    raw_api_key: Option<&str>,
) -> Result<ModelListResult, String> {
    let stored = settings::load_stored()?;
    let saved = provider_id.and_then(|id| settings::provider_by_id(&stored, id));

    let base_url_input = raw_base_url
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| saved.as_ref().map(|p| p.base_url.clone()))
        .ok_or_else(|| "请先填写 API 根地址".to_string())?;
    let base_url = validate_base_url(&base_url_input)?;

    let proto = protocol
        .or_else(|| saved.as_ref().map(|p| p.protocol))
        .ok_or_else(|| "请先选择 API 协议".to_string())?;

    let api_key = raw_api_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| saved.as_ref().and_then(|p| settings::get_key_plaintext(&stored, &p.key_id)))
        .ok_or_else(|| "请先填写 API Key；也可手工添加模型 ID".to_string())?;

    let client = build_http_client_for(&base_url, 20)?;
    let url = endpoint(&base_url, "/models");
    let mut req = client.get(&url);
    if proto == ProviderProtocol::AnthropicMessages {
        req = req
            .header("x-api-key", &api_key)
            .header("anthropic-version", "2023-06-01");
    } else {
        req = req.bearer_auth(&api_key);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("获取模型列表超时或网络失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(log_and_map_http_error(resp, None, "models", proto).await);
    }

    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("模型列表解析失败：{e}"))?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                let t = id.trim();
                if !t.is_empty() && seen.insert(t.to_string()) {
                    models.push(t.to_string());
                }
            }
        }
    }
    if models.is_empty() {
        return Err("接口连接成功，但模型列表为空；可以手工添加模型 ID".into());
    }

    Ok(ModelListResult {
        models,
        fetched_at: Utc::now().to_rfc3339(),
    })
}

async fn call_text_with_snapshot(
    snapshot: &ProviderRequestSnapshot,
    system: Option<&str>,
    user: &str,
    temperature: f32,
    timeout_secs: u64,
) -> Result<TextResult, String> {
    let client = build_http_client_for(&snapshot.provider.base_url, timeout_secs)?;
    let resp = match snapshot.provider.protocol {
        ProviderProtocol::OpenaiChatCompletions => {
            let mut messages = Vec::new();
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                messages.push(json!({ "role": "system", "content": sys }));
            }
            messages.push(json!({ "role": "user", "content": user }));
            client
                .post(endpoint(&snapshot.provider.base_url, "/chat/completions"))
                .bearer_auth(&snapshot.api_key)
                .json(&json!({
                    "model": snapshot.model,
                    "temperature": temperature,
                    "messages": messages,
                }))
                .send()
                .await
        }
        ProviderProtocol::OpenaiResponses => {
            let mut payload = json!({
                "model": snapshot.model,
                "input": user,
                "temperature": temperature,
            });
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                payload["instructions"] = json!(sys);
            }
            client
                .post(endpoint(&snapshot.provider.base_url, "/responses"))
                .bearer_auth(&snapshot.api_key)
                .json(&payload)
                .send()
                .await
        }
        ProviderProtocol::AnthropicMessages => {
            let mut payload = json!({
                "model": snapshot.model,
                "max_tokens": 4096,
                "temperature": temperature,
                "messages": [{ "role": "user", "content": user }],
            });
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                payload["system"] = json!(sys);
            }
            client
                .post(endpoint(&snapshot.provider.base_url, "/messages"))
                .header("x-api-key", &snapshot.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&payload)
                .send()
                .await
        }
    }
    .map_err(|e| format!("AI 请求失败，请检查网络或代理设置：{e}"))?;

    if !resp.status().is_success() {
        return Err(
            log_and_map_http_error(resp, Some(snapshot.cap), &snapshot.model, snapshot.provider.protocol)
                .await,
        );
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("AI 响应 JSON 解析失败：{e}"))?;

    let text = match snapshot.provider.protocol {
        ProviderProtocol::OpenaiChatCompletions => extract_chat_text(&body),
        ProviderProtocol::OpenaiResponses => extract_responses_text(&body),
        ProviderProtocol::AnthropicMessages => extract_anthropic_text(&body),
    };
    if text.trim().is_empty() {
        return Err("上游返回空内容".into());
    }

    Ok(TextResult {
        text,
        model: snapshot.model.clone(),
    })
}

pub async fn generate_text(
    system: Option<&str>,
    user: &str,
    temperature: Option<f32>,
) -> Result<TextResult, String> {
    let snapshot = settings::resolve_request(CapId::Text, None)?;
    call_text_with_snapshot(&snapshot, system, user, temperature.unwrap_or(0.7), 120).await
}

pub async fn recognize_media(
    cap: CapId,
    parts: &[VisionPart],
    system: Option<&str>,
) -> Result<TextResult, String> {
    let snapshot = settings::resolve_request(cap, None)?;
    let client = build_http_client_for(&snapshot.provider.base_url, 150)?;
    crate::core::logger::info(
        "ai_proxy",
        format!(
            "recognize_media cap={:?} proto={:?} model={} parts={} base_loopback={}",
            cap,
            snapshot.provider.protocol,
            snapshot.model,
            parts.len(),
            is_loopback_base_url(&snapshot.provider.base_url)
        ),
    );
    let prompt_text = if cap == CapId::VisionVideo {
        "以下是一段短视频按时间均匀抽取的关键画面帧。请结合画面内容、字幕文字与场景变化，完整还原该视频的核心口播观点、步骤要点与结构，输出清晰完整的中文稿件供后续洗稿改写。"
    } else {
        "请忠实识别并提取上述素材中的全部关键信息、画面要点与可读文字，输出清晰完整的中文稿件供后续改写。"
    };

    let resp = match snapshot.provider.protocol {
        ProviderProtocol::OpenaiChatCompletions => {
            let mut content_parts = Vec::new();
            for p in parts {
                let mime = p.mime.as_deref().unwrap_or(if p.part_type == "video" {
                    "video/mp4"
                } else {
                    "image/jpeg"
                });
                let data_url = format!("data:{mime};base64,{}", p.data);
                if p.part_type == "video" {
                    content_parts.push(json!({
                        "type": "video_url",
                        "video_url": { "url": data_url }
                    }));
                } else {
                    content_parts.push(json!({
                        "type": "image_url",
                        "image_url": { "url": data_url }
                    }));
                }
            }
            content_parts.push(json!({ "type": "text", "text": prompt_text }));

            let mut messages = Vec::new();
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                messages.push(json!({ "role": "system", "content": sys }));
            }
            messages.push(json!({ "role": "user", "content": content_parts }));

            client
                .post(endpoint(&snapshot.provider.base_url, "/chat/completions"))
                .bearer_auth(&snapshot.api_key)
                .json(&json!({
                    "model": snapshot.model,
                    "messages": messages,
                }))
                .send()
                .await
        }
        ProviderProtocol::OpenaiResponses => {
            let mut content_parts = Vec::new();
            for p in parts {
                if p.part_type == "video" {
                    return Err("OpenAI Responses 协议暂不支持视频识别扩展".into());
                }
                let mime = p.mime.as_deref().unwrap_or("image/jpeg");
                content_parts.push(json!({
                    "type": "input_image",
                    "image_url": format!("data:{mime};base64,{}", p.data)
                }));
            }
            content_parts.push(json!({ "type": "input_text", "text": prompt_text }));
            let mut payload = json!({
                "model": snapshot.model,
                "input": [{ "role": "user", "content": content_parts }],
            });
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                payload["instructions"] = json!(sys);
            }
            client
                .post(endpoint(&snapshot.provider.base_url, "/responses"))
                .bearer_auth(&snapshot.api_key)
                .json(&payload)
                .send()
                .await
        }
        ProviderProtocol::AnthropicMessages => {
            let mut content_parts = Vec::new();
            for p in parts {
                if p.part_type == "video" {
                    return Err("Anthropic Messages 协议暂不支持视频识别扩展".into());
                }
                let mime = p.mime.as_deref().unwrap_or("image/jpeg");
                content_parts.push(json!({
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime,
                        "data": p.data
                    }
                }));
            }
            content_parts.push(json!({ "type": "text", "text": prompt_text }));
            let mut payload = json!({
                "model": snapshot.model,
                "max_tokens": 4096,
                "messages": [{ "role": "user", "content": content_parts }],
            });
            if let Some(sys) = system.filter(|s| !s.trim().is_empty()) {
                payload["system"] = json!(sys);
            }
            client
                .post(endpoint(&snapshot.provider.base_url, "/messages"))
                .header("x-api-key", &snapshot.api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&payload)
                .send()
                .await
        }
    }
    .map_err(|e| {
        crate::core::logger::error("ai_proxy", format!("recognize_media transport error: {e}"));
        format!("多模态识别请求失败：{e}")
    })?;

    if !resp.status().is_success() {
        return Err(
            log_and_map_http_error(resp, Some(cap), &snapshot.model, snapshot.provider.protocol)
                .await,
        );
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = match snapshot.provider.protocol {
        ProviderProtocol::OpenaiChatCompletions => extract_chat_text(&body),
        ProviderProtocol::OpenaiResponses => extract_responses_text(&body),
        ProviderProtocol::AnthropicMessages => extract_anthropic_text(&body),
    };
    if text.trim().is_empty() {
        return Err("多模态识别返回空内容".into());
    }

    Ok(TextResult {
        text,
        model: snapshot.model,
    })
}

pub async fn generate_image(
    prompt: &str,
    size: Option<&str>,
    quality: Option<&str>,
    ref_imgs: &[VisionPart],
) -> Result<ImageResult, String> {
    let snapshot = settings::resolve_request(CapId::Image, None)?;
    if snapshot.provider.protocol != ProviderProtocol::OpenaiChatCompletions {
        return Err("当前出图槽位仅支持 OpenAI Images 兼容协议".into());
    }
    let client = build_http_client_for(&snapshot.provider.base_url, 300)?;
    let size_val = size.unwrap_or("1024x1536");
    let quality_val = quality.unwrap_or("auto");

    let (resp, used_edit) = if !ref_imgs.is_empty() {
        let mut form = Form::new()
            .text("model", snapshot.model.clone())
            .text("prompt", prompt.to_string())
            .text("size", size_val.to_string())
            .text("quality", quality_val.to_string());
        for (idx, ref_img) in ref_imgs.iter().take(14).enumerate() {
            let raw_b64 = ref_img.data.split(',').next_back().unwrap_or("");
            let bytes = B64
                .decode(raw_b64)
                .map_err(|e| format!("第 {} 张参考图解码失败：{e}", idx + 1))?;
            let mime = ref_img.mime.as_deref().unwrap_or("image/png");
            let ext = if mime.contains("jpeg") || mime.contains("jpg") {
                "jpg"
            } else if mime.contains("webp") {
                "webp"
            } else {
                "png"
            };
            let part = Part::bytes(bytes)
                .file_name(format!("reference-{}.{ext}", idx + 1))
                .mime_str(mime)
                .map_err(|e| e.to_string())?;
            form = form.part("image", part);
        }
        let r = client
            .post(endpoint(&snapshot.provider.base_url, "/images/edits"))
            .bearer_auth(&snapshot.api_key)
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("参考图编辑出图失败：{e}"))?;
        (r, true)
    } else {
        let r = client
            .post(endpoint(&snapshot.provider.base_url, "/images/generations"))
            .bearer_auth(&snapshot.api_key)
            .json(&json!({
                "model": snapshot.model,
                "prompt": prompt,
                "size": size_val,
                "quality": quality_val,
                "n": 1
            }))
            .send()
            .await
            .map_err(|e| format!("API 出图请求失败：{e}"))?;
        (r, false)
    };

    if !resp.status().is_success() {
        return Err(
            log_and_map_http_error(resp, Some(CapId::Image), &snapshot.model, snapshot.provider.protocol)
                .await,
        );
    }
    let body: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut images = Vec::new();
    if let Some(arr) = body.get("data").and_then(|v| v.as_array()) {
        for item in arr {
            if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
                images.push(ImageOutput { b64: b64.to_string() });
            } else if let Some(url) = item.get("url").and_then(|v| v.as_str()) {
                if let Ok(img_resp) = client.get(url).send().await {
                    if let Ok(bytes) = img_resp.bytes().await {
                        images.push(ImageOutput {
                            b64: B64.encode(&bytes),
                        });
                    }
                }
            }
        }
    }
    if images.is_empty() {
        return Err("上游未返回可用图片数据".into());
    }

    Ok(ImageResult {
        images,
        model: snapshot.model,
        used_edit,
        provider: "api".to_string(),
    })
}

fn enriched_child_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let mut extras: Vec<String> = Vec::new();
    #[cfg(target_os = "macos")]
    {
        extras.push("/opt/homebrew/bin".into());
        extras.push("/usr/local/bin".into());
    }
    if let Some(home) = dirs::home_dir() {
        extras.push(home.join(".local").join("bin").to_string_lossy().to_string());
        extras.push(home.join(".codex").join("bin").to_string_lossy().to_string());
        extras.push(home.join(".npm-global").join("bin").to_string_lossy().to_string());
    }
    if !base.is_empty() {
        extras.push(base);
    }
    let sep = if cfg!(target_os = "windows") { ";" } else { ":" };
    extras.join(sep)
}

/// 快速同步探测本机 Codex CLI 是否存在并已登录（用于设置页配置列表展示，耗时 < 1ms）
pub fn is_codex_cli_available_sync() -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let auth_path = home.join(".codex").join("auth.json");
    let auth_ok = std::fs::read_to_string(&auth_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .map(|v| {
            v.get("auth_mode").and_then(|m| m.as_str()) == Some("chatgpt")
                || v.pointer("/tokens/access_token")
                    .and_then(|t| t.as_str())
                    .is_some()
        })
        .unwrap_or(false);
    if !auth_ok {
        return false;
    }
    codex_cli_path_sync().is_some()
}

pub fn codex_cli_path_sync() -> Option<String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(custom) = std::env::var("NEWMEDIA_CODEX_CLI") {
        let t = custom.trim();
        if !t.is_empty() {
            candidates.push(std::path::PathBuf::from(t));
        }
    }
    #[cfg(target_os = "macos")]
    {
        candidates.push(std::path::PathBuf::from(
            "/Applications/ChatGPT.app/Contents/Resources/codex",
        ));
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin/codex"));
        candidates.push(std::path::PathBuf::from("/usr/local/bin/codex"));
    }
    if let Some(home) = dirs::home_dir() {
        let bin = if cfg!(target_os = "windows") {
            "codex.exe"
        } else {
            "codex"
        };
        candidates.push(home.join(".local").join("bin").join(bin));
        candidates.push(home.join(".codex").join("bin").join(bin));
        candidates.push(home.join(".npm-global").join("bin").join(bin));
    }
    for path in candidates {
        if path.is_file() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// 识别本机 Codex CLI 路径（兼容 Finder 启动时丢失终端 PATH 的 macOS 场景与 Windows 场景）
async fn codex_cli_path() -> Option<String> {
    if let Some(found) = codex_cli_path_sync() {
        return Some(found);
    }
    let probe = tokio::process::Command::new("codex")
        .env("PATH", enriched_child_path())
        .arg("--version")
        .output()
        .await;
    if probe.map(|o| o.status.success()).unwrap_or(false) {
        return Some("codex".to_string());
    }
    None
}

fn codex_aspect(size: Option<&str>) -> &'static str {
    match size {
        Some("1024x1024") => "1:1",
        Some("1536x1024") => "3:2 横版",
        _ => "2:3 竖版",
    }
}

fn extract_codex_thread_id(stdout: &str) -> Option<String> {
    for line in stdout.lines() {
        if let Ok(val) = serde_json::from_str::<Value>(line) {
            if val.get("type").and_then(|v| v.as_str()) == Some("thread.started") {
                if let Some(tid) = val.get("thread_id").and_then(|v| v.as_str()) {
                    return Some(tid.to_string());
                }
            }
        }
    }
    None
}

/// 从用户 ~/.codex/config.toml 中读取顶层 model = "..."（不触碰任何密钥字段）
fn read_user_codex_model(home: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(home.join(".codex").join("config.toml")).ok()?;
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            break; // 只读顶层字段，不读子表
        }
        if let Some(rest) = trimmed.strip_prefix("model") {
            let rest = rest.trim_start();
            if let Some(val) = rest.strip_prefix('=') {
                let cleaned = val.trim().trim_matches('"').trim_matches('\'').trim();
                if !cleaned.is_empty() {
                    return Some(cleaned.to_string());
                }
            }
        }
    }
    None
}

/// 100% 还原旧版本机 Codex CLI 订阅出图逻辑（无需 API Key）
/// 使用临时精简 CODEX_HOME（仅复用 auth.json + model_reasoning_effort="low"），
/// 彻底跳过无效 MCP 重试、海量 Skills 扫描与阻塞的 SessionEnd Hook，大幅缩短生图耗时。
pub async fn generate_codex_image(
    prompt: &str,
    size: Option<&str>,
    ref_imgs: &[VisionPart],
) -> Result<ImageResult, String> {
    let started_at = std::time::Instant::now();
    let status = chutu_providers_status().await;
    if !status.codex.available {
        return Err(status.codex.message);
    }
    let cli = codex_cli_path()
        .await
        .ok_or_else(|| "未检测到可用的 Codex CLI 或订阅登录".to_string())?;
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    let user_generated_root = home.join(".codex").join("generated_images");
    let _ = std::fs::create_dir_all(&user_generated_root);

    let temp_dir = std::env::temp_dir().join(format!("newmedia-codex-img-{}", uuid::Uuid::new_v4()));
    let fast_codex_home = temp_dir.join("codex-home");
    let fast_generated_root = fast_codex_home.join("generated_images");
    std::fs::create_dir_all(&fast_generated_root).map_err(|e| e.to_string())?;

    let result: Result<ImageResult, String> = async {
        // 1. 构造精简隔离 CODEX_HOME：仅复制 auth.json + 极简 config.toml（reasoning=low，零无效 MCP/Hooks/Skills）
        let src_auth = home.join(".codex").join("auth.json");
        std::fs::copy(&src_auth, fast_codex_home.join("auth.json"))
            .map_err(|e| format!("读取本机 Codex 登录凭证失败：{e}"))?;

        let effective_model = std::env::var("NEWMEDIA_CODEX_IMAGEGEN_MODEL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| read_user_codex_model(&home));

        let mut fast_cfg = String::new();
        if let Some(ref m) = effective_model {
            fast_cfg.push_str(&format!("model = \"{m}\"\n"));
        }
        fast_cfg.push_str("model_reasoning_effort = \"low\"\n");
        std::fs::write(fast_codex_home.join("config.toml"), &fast_cfg)
            .map_err(|e| format!("写入临时 Codex 配置失败：{e}"))?;

        let mut ref_paths = Vec::new();
        for (idx, ref_img) in ref_imgs.iter().take(14).enumerate() {
            let raw_b64 = ref_img.data.split(',').next_back().unwrap_or("");
            let bytes = B64
                .decode(raw_b64)
                .map_err(|e| format!("第 {} 张参考图解码失败：{e}", idx + 1))?;
            let mime = ref_img.mime.as_deref().unwrap_or("image/png");
            let ext = if mime.contains("jpeg") || mime.contains("jpg") {
                "jpg"
            } else if mime.contains("webp") {
                "webp"
            } else {
                "png"
            };
            let file = temp_dir.join(format!("reference-{}.{ext}", idx + 1));
            std::fs::write(&file, bytes).map_err(|e| format!("写入临时参考图失败：{e}"))?;
            ref_paths.push(file);
        }

        let mut cmd = tokio::process::Command::new(&cli);
        cmd.env("PATH", enriched_child_path())
            .env("CODEX_HOME", &fast_codex_home);
        // 自动注入系统代理供 Codex CLI 访问外网，同时显式豁免本地回环地址
        if let Some(proxy_url) = detect_system_proxy() {
            crate::core::logger::info(
                "codex",
                format!(
                    "start fast codex imagegen: model={} reasoning=low proxy={proxy_url}",
                    effective_model.as_deref().unwrap_or("default")
                ),
            );
            cmd.env("HTTP_PROXY", &proxy_url)
                .env("HTTPS_PROXY", &proxy_url)
                .env("ALL_PROXY", &proxy_url)
                .env("http_proxy", &proxy_url)
                .env("https_proxy", &proxy_url)
                .env("all_proxy", &proxy_url)
                .env("NO_PROXY", "127.0.0.1,localhost,::1")
                .env("no_proxy", "127.0.0.1,localhost,::1");
        } else {
            crate::core::logger::info(
                "codex",
                format!(
                    "start fast codex imagegen: model={} reasoning=low proxy=none",
                    effective_model.as_deref().unwrap_or("default")
                ),
            );
        }
        cmd.args([
            "exec",
            "--json",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "danger-full-access",
            "-C",
            &temp_dir.to_string_lossy(),
            "--add-dir",
            &fast_generated_root.to_string_lossy(),
            "--add-dir",
            &user_generated_root.to_string_lossy(),
        ]);
        for rp in &ref_paths {
            cmd.arg("-i").arg(rp);
        }
        cmd.stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动 Codex CLI 失败：{e}"))?;

        let prefix = if ref_paths.is_empty() {
            "$imagegen Call imagegen immediately once without extra analysis:"
        } else {
            "$imagegen Edit the attached reference image(s) immediately once without extra analysis:"
        };
        let full_prompt = format!("{prefix} {prompt}\nAspect ratio: {}.", codex_aspect(size));

        if let Some(mut stdin) = child.stdin.take() {
            use tokio::io::AsyncWriteExt;
            let _ = stdin.write_all(full_prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }

        let output = tokio::time::timeout(Duration::from_secs(300), child.wait_with_output())
            .await
            .map_err(|_| "Codex 订阅出图超时（5 分钟）".to_string())?
            .map_err(|e| format!("执行 Codex CLI 失败：{e}"))?;

        let elapsed_ms = started_at.elapsed().as_millis();
        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if !output.status.success() {
            crate::core::logger::error(
                "codex",
                format!(
                    "codex exec failed after {elapsed_ms}ms ({}): stdout={} | stderr={}",
                    output.status, stdout, stderr
                ),
            );
            let json_err = stdout.lines().rev().find_map(|line| {
                let val = serde_json::from_str::<Value>(line).ok()?;
                let kind = val.get("type")?.as_str()?;
                if kind == "turn.failed" {
                    val.pointer("/error/message").and_then(|v| v.as_str()).map(str::to_string)
                } else if kind == "error" {
                    val.get("message").and_then(|v| v.as_str()).map(str::to_string)
                } else {
                    None
                }
            });
            let msg = json_err.unwrap_or_else(|| {
                let detail = if !stderr.is_empty() { &stderr } else { &stdout };
                detail
                    .chars()
                    .rev()
                    .take(300)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect()
            });
            return Err(format!("Codex 订阅出图失败：{msg}"));
        }

        let usage_summary = stdout
            .lines()
            .rev()
            .find_map(|line| {
                let val = serde_json::from_str::<Value>(line).ok()?;
                if val.get("type")?.as_str()? == "turn.completed" {
                    val.get("usage").map(|u| u.to_string())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| "unknown".into());
        crate::core::logger::info(
            "codex",
            format!("codex imagegen completed in {elapsed_ms}ms; usage={usage_summary}"),
        );

        let thread_id = extract_codex_thread_id(&stdout)
            .ok_or_else(|| "Codex 未返回图片任务标识，无法读取生成文件".to_string())?;

        // 同时检查隔离 CODEX_HOME 与默认 ~/.codex 两个 generated_images 位置
        let candidate_dirs = [
            fast_generated_root.join(&thread_id),
            user_generated_root.join(&thread_id),
        ];
        let mut found_file: Option<std::path::PathBuf> = None;
        for dir in &candidate_dirs {
            let mut imgs: Vec<String> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(dir) {
                for e in entries.flatten() {
                    let name = e.file_name().to_string_lossy().to_string();
                    let lower = name.to_lowercase();
                    if lower.ends_with(".png")
                        || lower.ends_with(".jpg")
                        || lower.ends_with(".jpeg")
                        || lower.ends_with(".webp")
                    {
                        imgs.push(name);
                    }
                }
            }
            imgs.sort();
            if let Some(chosen) = imgs
                .iter()
                .find(|n| n.starts_with("ig_") || n.starts_with("call_"))
                .or_else(|| imgs.first())
            {
                found_file = Some(dir.join(chosen));
                break;
            }
        }

        let img_path = found_file
            .ok_or_else(|| "Codex 已完成，但未在本地写出图片文件".to_string())?;
        let bytes = std::fs::read(&img_path)
            .map_err(|e| format!("读取 Codex 生成图片失败：{e}"))?;
        let _ = std::fs::remove_dir_all(user_generated_root.join(&thread_id));
        if bytes.len() < 1024 {
            return Err("Codex 返回的图片文件异常".into());
        }

        Ok(ImageResult {
            images: vec![ImageOutput {
                b64: B64.encode(&bytes),
            }],
            model: "gpt-image-2（Codex 订阅）".to_string(),
            used_edit: !ref_paths.is_empty(),
            provider: "codex".to_string(),
        })
    }
    .await;

    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

pub async fn verify_capability(cap: CapId) -> Result<String, String> {
    if cap == CapId::Image && settings::is_active_image_codex_cli() {
        let status = chutu_providers_status().await;
        if status.codex.available {
            return Ok("Codex CLI（本机订阅）".to_string());
        }
        return Err(status.codex.message);
    }
    let snapshot = settings::resolve_request(cap, None)?;
    match cap {
        CapId::Image => {
            // 出图槽位避免消耗生图费用：以 GET /models 核验鉴权与通道可达性
            let list = fetch_provider_models(
                Some(&snapshot.provider.id),
                Some(&snapshot.provider.base_url),
                Some(snapshot.provider.protocol),
                Some(&snapshot.api_key),
            )
            .await;
            // 若 /models 失败但仅返回空列表，也说明鉴权已通过
            if let Err(e) = list {
                if !e.contains("模型列表为空") {
                    return Err(e);
                }
            }
        }
        _ => {
            call_text_with_snapshot(&snapshot, None, "请仅回复 OK", 0.0, 25).await?;
        }
    }
    settings::mark_verified(&snapshot)?;
    Ok(snapshot.model)
}

#[derive(Debug, Clone, Serialize)]
pub struct ChutuProvidersStatus {
    pub codex: ProviderAvail,
    pub api: ProviderAvail,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProviderAvail {
    pub available: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

pub async fn chutu_providers_status() -> ChutuProvidersStatus {
    let codex = async {
        let Some(home) = dirs::home_dir() else {
            return ProviderAvail {
                available: false,
                message: "未检测到可用的 Codex CLI 或订阅登录".into(),
                version: None,
            };
        };
        let auth_path = home.join(".codex").join("auth.json");
        let auth_ok = std::fs::read_to_string(&auth_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .map(|v| {
                v.get("auth_mode").and_then(|m| m.as_str()) == Some("chatgpt")
                    || v.pointer("/tokens/access_token").and_then(|t| t.as_str()).is_some()
            })
            .unwrap_or(false);
        if !auth_ok {
            return ProviderAvail {
                available: false,
                message: "未检测到 Codex 订阅登录，请先在终端完成 Codex 登录".into(),
                version: None,
            };
        }
        let Some(cli) = codex_cli_path().await else {
            return ProviderAvail {
                available: false,
                message: "未检测到可用的 Codex CLI 或订阅登录".into(),
                version: None,
            };
        };
        let ver = tokio::process::Command::new(&cli)
            .env("PATH", enriched_child_path())
            .arg("--version")
            .output()
            .await
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty());

        ProviderAvail {
            available: true,
            message: "已检测到本机 Codex 订阅，可直接出图".into(),
            version: ver,
        }
    }
    .await;

    ChutuProvidersStatus {
        codex,
        api: ProviderAvail {
            available: true,
            message: "使用设置页已配置的出图 API Key".into(),
            version: None,
        },
    }
}
