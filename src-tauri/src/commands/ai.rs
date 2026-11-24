use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::core::ai_proxy::{self, ChutuProvidersStatus, ImageResult, VisionPart};
use crate::core::caps::CapId;
use crate::core::prompt_parse::parse_prompt_output;

static DIRECTION_MARK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?im)^#\s*方向\s*([一二三四1234])\s*$").unwrap());

fn parse_creative_directions(text: &str) -> Vec<String> {
    let matches: Vec<_> = DIRECTION_MARK_RE.find_iter(text).collect();
    let mut out = Vec::new();
    for (idx, m) in matches.iter().enumerate() {
        let start = m.end();
        let end = matches
            .get(idx + 1)
            .map(|n| n.start())
            .unwrap_or(text.len());
        let body = text[start..end].trim();
        if !body.is_empty() {
            out.push(body.to_string());
        }
    }
    out.truncate(4);
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreativeDirectionsReq {
    pub link: String,
    pub title: Option<String>,
    pub integration: String,
}

#[derive(Debug, Serialize)]
pub struct CreativeDirectionsResp {
    pub directions: Vec<String>,
    pub model: String,
}

#[tauri::command]
pub async fn creative_directions(
    req: CreativeDirectionsReq,
) -> Result<CreativeDirectionsResp, String> {
    if req.link.trim().is_empty() || req.integration.trim().is_empty() {
        return Err("热榜链接和结合信息不能为空".into());
    }
    let system = [
        "你是资深新媒体创意策划，擅长借势热榜为企业产品设计传播创意。",
        "基于热榜标题、热榜链接及用户提供的结合信息，提出 4 个差异明显、可执行、合规的借势宣传方向。",
        "每个方向写清核心切入点、适合表达形式和可融入的产品信息，避免空泛口号、避免直接照搬热榜原文。",
        "必须严格只按以下格式输出，不要添加前言、结语或其他标题：",
        "#方向一\n内容\n#方向二\n内容\n#方向三\n内容\n#方向四\n内容",
    ]
    .join("\n");
    let user = format!(
        "热榜标题：{}\n热榜链接：{}\n\n需结合的信息：{}",
        req.title.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("未提供"),
        req.link.trim(),
        req.integration.trim()
    );
    let r = ai_proxy::generate_text(Some(&system), &user, None).await?;
    let directions = parse_creative_directions(&r.text);
    if directions.len() != 4 {
        return Err("AI 未按要求生成完整的 4 个创意方向，请重试".into());
    }
    Ok(CreativeDirectionsResp {
        directions,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreativeGenerateReq {
    pub link: String,
    pub title: Option<String>,
    pub integration: String,
    pub direction: String,
    pub requirement: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TextOutResp {
    pub out: String,
    pub model: String,
}

#[tauri::command]
pub async fn creative_generate(app: AppHandle, req: CreativeGenerateReq) -> Result<TextOutResp, String> {
    if req.link.trim().is_empty()
        || req.integration.trim().is_empty()
        || req.direction.trim().is_empty()
    {
        return Err("热榜链接、结合信息和创作方向不能为空".into());
    }
    let system = "你是新媒体内容创作助手。根据选定的借势创意方向，产出可直接用于运营制作的完整内容。严格执行用户对内容形式、长度和语气的要求；避免虚假承诺、夸大宣传与生硬蹭热点。直接输出最终内容，不要解释创作过程。";
    let user = format!(
        "热榜标题：{}\n热榜链接：{}\n\n需结合的信息：{}\n\n选定创意方向：{}\n\n本次创作要求：{}",
        req.title.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("未提供"),
        req.link.trim(),
        req.integration.trim(),
        req.direction.trim(),
        req.requirement
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("生成一版完整、可直接使用的新媒体传播文案。")
    );
    let r = ai_proxy::generate_text_stream(&app, "creative-out", Some(system), &user, None).await?;
    Ok(TextOutResp {
        out: r.text,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreativeOptimizeReq {
    pub content: String,
    pub hint: String,
}

#[tauri::command]
pub async fn creative_optimize(app: AppHandle, req: CreativeOptimizeReq) -> Result<TextOutResp, String> {
    if req.content.trim().is_empty() || req.hint.trim().is_empty() {
        return Err("创意内容和优化意见不能为空".into());
    }
    let system = "你是新媒体创意文案编辑。仅根据用户的优化意见润色现有创意内容，保留有效信息与内容结构，直接输出优化后的完整最终内容，不要解释修改过程。";
    let user = format!(
        "现有创意内容：\n{}\n\n优化意见：{}",
        req.content.trim(),
        req.hint.trim()
    );
    let r = ai_proxy::generate_text_stream(&app, "creative-out", Some(system), &user, None).await?;
    Ok(TextOutResp {
        out: r.text,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TishiciReq {
    pub source: Option<String>,
    pub desc: Option<String>,
    #[serde(rename = "type")]
    pub mode_type: Option<String>,
    pub image_count: Option<usize>,
    pub optimize_hint: Option<String>,
    pub previous_text: Option<String>,
    pub previous_img: Option<String>,
    pub previous_imgs: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TishiciResp {
    pub ok: bool,
    pub out_text: String,
    pub out_img: String,
    pub out_imgs: Vec<String>,
    pub parse_mode: String,
    pub note: String,
    pub model: String,
}

fn build_tishici_system(mode_type: &str, image_count: usize) -> String {
    if mode_type == "img" {
        let mut lines = vec![
            "你是新媒体视觉提示词写手。请根据用户给出的稿件内容、图需求与约束，直接输出一段用于 AI 生图的中文图片提示词。".to_string(),
            "提示词应包含主体、核心信息、视觉风格、构图、色调与画面文字处理要求。".to_string(),
            format!("本次需要 {image_count} 张配图。必须严格只按以下格式输出，不要额外解释、不要使用其他标题："),
            "#图片提示词1".to_string(),
            "这里写第 1 张图片的中文提示词".to_string(),
        ];
        if image_count > 1 {
            lines.push("#图片提示词2\n这里写第 2 张图片的中文提示词".to_string());
        }
        if image_count > 2 {
            lines.push(format!("依此类推，直到 #图片提示词{image_count}"));
        }
        lines.push(format!(
            "#图片提示词1 至 #图片提示词{image_count} 都必须各自单独占一行；不得漏掉任何一张图片提示词。"
        ));
        return lines.join("\n");
    }

    let mut lines = vec![
        "你是新媒体内容助手。请根据用户给出的稿件内容、图需求与约束，一次性生成可直接发布的小红书或微信朋友圈图文内容。".to_string(),
        "第一部分「文字」要自然口语、有发布感；第二部分「图片提示词」要用于 AI 生图，包含主体、风格、构图、色调与文字处理要求。".to_string(),
        format!("本次需要 {image_count} 张配图。必须严格只按以下格式输出，不要额外解释、不要使用其他标题："),
        "#文字".to_string(),
        "这里写可发布的图文文案".to_string(),
        "------".to_string(),
        "#图片提示词1".to_string(),
        "这里写第 1 张图片的中文提示词".to_string(),
    ];
    if image_count > 1 {
        lines.push("#图片提示词2\n这里写第 2 张图片的中文提示词".to_string());
    }
    if image_count > 2 {
        lines.push(format!("依此类推，直到 #图片提示词{image_count}"));
    }
    lines.push(format!(
        "其中 #文字、------、#图片提示词1 至 #图片提示词{image_count} 都必须各自单独占一行；不得漏掉任何一张图片提示词。"
    ));
    lines.join("\n")
}

#[tauri::command]
pub async fn gen_tishici(req: TishiciReq) -> Result<TishiciResp, String> {
    let mode_type = req.mode_type.as_deref().unwrap_or("tp");
    if mode_type != "tp" && mode_type != "img" {
        return Err("type 必须为 tp 或 img".into());
    }
    let count = req.image_count.unwrap_or(1).clamp(1, 9);
    let mut sections = Vec::new();
    if let Some(d) = req.desc.as_deref().filter(|s| !s.trim().is_empty()) {
        sections.push(format!("要求：{}", d.trim()));
    }
    if let Some(s) = req.source.as_deref().filter(|s| !s.trim().is_empty()) {
        sections.push(format!("参考素材：\n{}", s.trim()));
    }
    if let Some(pt) = req.previous_text.as_deref().filter(|s| !s.trim().is_empty()) {
        sections.push(format!("当前文字文案：\n{}", pt.trim()));
    }
    if let Some(imgs) = req.previous_imgs.as_ref() {
        let non_empty: Vec<_> = imgs.iter().filter(|s| !s.trim().is_empty()).collect();
        if !non_empty.is_empty() {
            let formatted = non_empty
                .iter()
                .enumerate()
                .map(|(i, s)| format!("#图片提示词{}\n{}", i + 1, s.trim()))
                .collect::<Vec<_>>()
                .join("\n\n");
            sections.push(format!("当前图片提示词：\n{formatted}"));
        }
    } else if let Some(pi) = req.previous_img.as_deref().filter(|s| !s.trim().is_empty()) {
        sections.push(format!("当前图片提示词：\n{}", pi.trim()));
    }
    if let Some(oh) = req.optimize_hint.as_deref().filter(|s| !s.trim().is_empty()) {
        sections.push(format!("优化方向：{}", oh.trim()));
    }

    let system = build_tishici_system(mode_type, count);
    let user = sections.join("\n\n");
    let r = ai_proxy::generate_text(Some(&system), &user, None).await?;
    let parsed = parse_prompt_output(&r.text, mode_type, count);

    Ok(TishiciResp {
        ok: true,
        out_text: parsed.out_text,
        out_img: parsed.out_img,
        out_imgs: parsed.out_imgs,
        parse_mode: parsed.parse_mode,
        note: parsed.note,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XigaoRecognizeReq {
    pub media_type: String,
    pub parts: Vec<VisionPart>,
    pub system: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct XigaoRecognizeResp {
    pub recog: String,
    pub model: String,
}

#[tauri::command]
pub async fn xigao_recognize(req: XigaoRecognizeReq) -> Result<XigaoRecognizeResp, String> {
    if req.parts.is_empty() {
        return Err("识别素材不能为空".into());
    }
    let cap = if req.media_type == "video" {
        CapId::VisionVideo
    } else {
        CapId::VisionImg
    };
    let r = ai_proxy::recognize_media(cap, &req.parts, req.system.as_deref()).await?;
    Ok(XigaoRecognizeResp {
        recog: r.text,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XigaoRewriteReq {
    pub source: String,
    pub req: Option<String>,
    pub optimize_hint: Option<String>,
}

#[tauri::command]
pub async fn xigao_rewrite(app: AppHandle, req: XigaoRewriteReq) -> Result<TextOutResp, String> {
    if req.source.trim().is_empty() {
        return Err("待改写稿件不能为空".into());
    }
    let mut parts = Vec::new();
    if let Some(r) = req.req.as_deref().filter(|s| !s.trim().is_empty()) {
        parts.push(format!("洗稿要求：{}", r.trim()));
    }
    parts.push(format!("待改写稿件：\n{}", req.source.trim()));
    if let Some(h) = req.optimize_hint.as_deref().filter(|s| !s.trim().is_empty()) {
        parts.push(format!("优化方向：{}", h.trim()));
    }
    let system = "你是资深新媒体编辑，负责把素材改写成符合平台调性的原创文案，保留核心信息、去水印话术、自然口语化。";
    let r = ai_proxy::generate_text_stream(&app, "xigao-rewrite", Some(system), &parts.join("\n\n"), None).await?;
    Ok(TextOutResp {
        out: r.text,
        model: r.model,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChutuReq {
    pub prompt: String,
    pub provider: Option<String>,
    pub size: Option<String>,
    pub quality: Option<String>,
    pub optimize_hint: Option<String>,
    #[serde(default)]
    pub ref_imgs: Vec<VisionPart>,
}

#[tauri::command]
pub async fn chutu_generate(req: ChutuReq) -> Result<ImageResult, String> {
    if req.prompt.trim().is_empty() {
        return Err("图片提示词不能为空".into());
    }
    let full_prompt = match req.optimize_hint.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(hint) => format!("{}\n\n用户修改意见：{hint}", req.prompt.trim()),
        None => req.prompt.trim().to_string(),
    };
    // 统一以「设置 → 图片生成配置」当前勾选项为唯一事实源
    let use_codex = crate::core::settings::is_active_image_codex_cli()
        || req.provider.as_deref() == Some("codex");
    if use_codex {
        ai_proxy::generate_codex_image(&full_prompt, req.size.as_deref(), &req.ref_imgs).await
    } else {
        ai_proxy::generate_image(
            &full_prompt,
            req.size.as_deref(),
            req.quality.as_deref(),
            &req.ref_imgs,
        )
        .await
    }
}

#[tauri::command]
pub async fn chutu_providers() -> ChutuProvidersStatus {
    ai_proxy::chutu_providers_status().await
}
