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

fn build_http_client(timeout_secs: u64) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(Duration::from_secs(timeout_secs));
    // 自动遵循本机 HTTPS_PROXY / ALL_PROXY 环境变量
    if let Ok(proxy_url) = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("all_proxy"))
    {
        if let Ok(proxy) = reqwest::Proxy::all(proxy_url.trim()) {
            builder = builder.proxy(proxy);
        }
    }
    builder
        .build()
        .map_err(|e| format!("初始化 HTTP 客户端失败：{e}"))
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

    let client = build_http_client(20)?;
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
        return Err(map_http_error(resp.status().as_u16(), None));
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
    let client = build_http_client(timeout_secs)?;
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
        return Err(map_http_error(resp.status().as_u16(), Some(snapshot.cap)));
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
    let client = build_http_client(150)?;
    let prompt_text = "请忠实识别并提取上述素材中的全部关键信息、画面要点与可读文字，输出清晰完整的中文稿件供后续改写。";

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
    .map_err(|e| format!("多模态识别请求失败：{e}"))?;

    if !resp.status().is_success() {
        return Err(map_http_error(resp.status().as_u16(), Some(cap)));
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
    ref_image_data_url: Option<&str>,
) -> Result<ImageResult, String> {
    let snapshot = settings::resolve_request(CapId::Image, None)?;
    if snapshot.provider.protocol != ProviderProtocol::OpenaiChatCompletions {
        return Err("当前出图槽位仅支持 OpenAI Images 兼容协议".into());
    }
    let client = build_http_client(180)?;
    let size_val = size.unwrap_or("1024x1024");
    let quality_val = quality.unwrap_or("medium");

    let (resp, used_edit) = if let Some(ref_img) = ref_image_data_url.filter(|s| !s.trim().is_empty()) {
        let raw_b64 = ref_img.split(',').next_back().unwrap_or("");
        let bytes = B64
            .decode(raw_b64)
            .map_err(|e| format!("参考图解码失败：{e}"))?;
        let part = Part::bytes(bytes)
            .file_name("reference.png")
            .mime_str("image/png")
            .map_err(|e| e.to_string())?;
        let form = Form::new()
            .text("model", snapshot.model.clone())
            .text("prompt", prompt.to_string())
            .text("size", size_val.to_string())
            .text("quality", quality_val.to_string())
            .part("image", part);
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
        return Err(map_http_error(resp.status().as_u16(), Some(CapId::Image)));
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

pub async fn verify_capability(cap: CapId) -> Result<String, String> {
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
    let api_ok = settings::resolve_request(CapId::Image, None).is_ok();
    let codex_out = tokio::process::Command::new("codex")
        .arg("--version")
        .output()
        .await;
    let codex = match codex_out {
        Ok(out) if out.status.success() => {
            let ver = String::from_utf8_lossy(&out.stdout).trim().to_string();
            ProviderAvail {
                available: true,
                message: format!("已检测到本机 Codex CLI（{ver}）"),
                version: Some(ver),
            }
        }
        _ => ProviderAvail {
            available: false,
            message: "未检测到本机 Codex CLI，将默认使用图像 API 出图".into(),
            version: None,
        },
    };
    ChutuProvidersStatus {
        codex,
        api: ProviderAvail {
            available: api_ok,
            message: if api_ok {
                "图像 API 已配置".into()
            } else {
                "请先在设置页配置出图模型 API Key".into()
            },
            version: None,
        },
    }
}
