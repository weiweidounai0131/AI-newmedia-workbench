use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptParseResult {
    pub out_text: String,
    pub out_img: String,
    pub out_imgs: Vec<String>,
    pub raw: String,
    pub parse_mode: String,
    pub note: String,
}

static TEXT_HEADER_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*#\s*文字\s*$").unwrap());
static IMG_HEADER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^\s*#\s*图片\s*提示词\s*(\d+)?\s*$").unwrap());
static DASH_DELIM_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*-{3,}\s*$").unwrap());
static DELIM_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)^[ \t]*={2,}[ \t]*\[?[ \t]*IMG[ \t_\-]*PROMPT[ \t]*\]?[ \t]*={2,}[ \t]*$")
        .unwrap()
});
static FALLBACK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?i)【?\s*图片?\s*提示词\s*】?|image\s*prompt\s*:").unwrap());

const DELIM_NOTE: &str = "已按图文格式拆分为文案与图片提示词";
const PARTIAL_NOTE: &str = "已拆分图文内容，但有图片提示词缺失，请补齐后再出图";
const FALLBACK_NOTE: &str = "未命中严格分隔符，已按标题兜底拆分，请核对";
const FAILED_NOTE: &str = "未识别到图片提示词段落，已整段作为文案，图片框留空";
const SINGLE_NOTE: &str = "仅图片模式：整段作为图片提示词";

pub fn parse_prompt_output(raw: &str, mode_type: &str, image_count: usize) -> PromptParseResult {
    let text = raw.trim().to_string();
    let lines: Vec<&str> = text.lines().collect();
    let count = image_count.clamp(1, 9);

    let all_img_headers: Vec<(usize, Option<usize>)> = lines
        .iter()
        .enumerate()
        .filter_map(|(idx, line)| {
            IMG_HEADER_RE.captures(line).map(|cap| {
                let num = cap.get(1).and_then(|m| m.as_str().parse::<usize>().ok());
                (idx, num)
            })
        })
        .collect();

    if mode_type == "img" {
        if all_img_headers.is_empty() {
            let mut out_imgs = vec![String::new(); count];
            out_imgs[0] = text.clone();
            return PromptParseResult {
                out_text: String::new(),
                out_img: text.clone(),
                out_imgs,
                raw: text,
                parse_mode: if count == 1 { "single" } else { "partial" }.into(),
                note: if count == 1 { SINGLE_NOTE } else { PARTIAL_NOTE }.into(),
            };
        }
        let mut out_imgs = vec![String::new(); count];
        for (seq, (line_idx, num_opt)) in all_img_headers.iter().enumerate() {
            let end_idx = all_img_headers
                .get(seq + 1)
                .map(|(n, _)| *n)
                .unwrap_or(lines.len());
            let body = lines[*line_idx + 1..end_idx].join("\n").trim().to_string();
            let slot = num_opt.unwrap_or(seq + 1);
            if slot >= 1 && slot <= out_imgs.len() {
                out_imgs[slot - 1] = body;
            }
        }
        let complete = out_imgs.iter().all(|s| !s.is_empty());
        return PromptParseResult {
            out_text: String::new(),
            out_img: out_imgs.first().cloned().unwrap_or_default(),
            out_imgs,
            raw: text,
            parse_mode: if complete { "single" } else { "partial" }.into(),
            note: if complete { SINGLE_NOTE } else { PARTIAL_NOTE }.into(),
        };
    }

    let text_idx = lines.iter().position(|l| TEXT_HEADER_RE.is_match(l));
    let dash_idx = text_idx.and_then(|ti| {
        lines
            .iter()
            .enumerate()
            .skip(ti + 1)
            .find(|(_, l)| DASH_DELIM_RE.is_match(l))
            .map(|(i, _)| i)
    });

    if let (Some(ti), Some(di)) = (text_idx, dash_idx) {
        let img_headers: Vec<(usize, Option<usize>)> = all_img_headers
            .into_iter()
            .filter(|(idx, _)| *idx > di)
            .collect();
        if !img_headers.is_empty() {
            let out_text = lines[ti + 1..di].join("\n").trim().to_string();
            let mut out_imgs = vec![String::new(); count];
            for (seq, (line_idx, num_opt)) in img_headers.iter().enumerate() {
                let end_idx = img_headers
                    .get(seq + 1)
                    .map(|(n, _)| *n)
                    .unwrap_or(lines.len());
                let body = lines[*line_idx + 1..end_idx].join("\n").trim().to_string();
                let slot = num_opt.unwrap_or(seq + 1);
                if slot >= 1 && slot <= out_imgs.len() {
                    out_imgs[slot - 1] = body;
                }
            }
            let out_img = out_imgs.first().cloned().unwrap_or_default();
            if !out_text.is_empty() || out_imgs.iter().any(|s| !s.is_empty()) {
                let complete = out_imgs.iter().all(|s| !s.is_empty());
                return PromptParseResult {
                    out_text,
                    out_img,
                    out_imgs,
                    raw: text,
                    parse_mode: if complete { "delim" } else { "partial" }.into(),
                    note: if complete { DELIM_NOTE } else { PARTIAL_NOTE }.into(),
                };
            }
        }
    }

    if let Some(delim_idx) = lines.iter().position(|l| DELIM_RE.is_match(l)) {
        let out_text = lines[..delim_idx].join("\n").trim().to_string();
        let out_img = lines[delim_idx + 1..].join("\n").trim().to_string();
        let out_imgs = if out_img.is_empty() {
            vec![]
        } else {
            vec![out_img.clone()]
        };
        return PromptParseResult {
            out_text,
            out_img,
            out_imgs,
            raw: text,
            parse_mode: "delim".into(),
            note: DELIM_NOTE.into(),
        };
    }

    if let Some(fb_idx) = lines.iter().position(|l| FALLBACK_RE.is_match(l)) {
        let out_text = lines[..fb_idx].join("\n").trim().to_string();
        let out_img = lines[fb_idx + 1..].join("\n").trim().to_string();
        let out_imgs = if out_img.is_empty() {
            vec![]
        } else {
            vec![out_img.clone()]
        };
        return PromptParseResult {
            out_text,
            out_img,
            out_imgs,
            raw: text,
            parse_mode: "fallback".into(),
            note: FALLBACK_NOTE.into(),
        };
    }

    PromptParseResult {
        out_text: text.clone(),
        out_img: String::new(),
        out_imgs: vec![],
        raw: text,
        parse_mode: "failed".into(),
        note: FAILED_NOTE.into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tp_multi_image() {
        let raw = "#文字\n这里是正文内容\n------\n#图片提示词1\n第一张图提示词\n#图片提示词2\n第二张图提示词";
        let res = parse_prompt_output(raw, "tp", 2);
        assert_eq!(res.parse_mode, "delim");
        assert_eq!(res.out_text, "这里是正文内容");
        assert_eq!(res.out_imgs.len(), 2);
        assert_eq!(res.out_imgs[0], "第一张图提示词");
        assert_eq!(res.out_imgs[1], "第二张图提示词");
    }
}
