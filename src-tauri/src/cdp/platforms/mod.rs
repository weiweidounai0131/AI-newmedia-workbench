use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PlatformKey {
    Douyin,
    Xhs,
}

impl PlatformKey {
    pub fn from_name(input: &str) -> Option<Self> {
        match input.trim().to_lowercase().as_str() {
            "douyin" | "dy" | "抖音" => Some(Self::Douyin),
            "xhs" | "xiaohongshu" | "小红书" => Some(Self::Xhs),
            _ => None,
        }
    }

    pub fn key(&self) -> &'static str {
        match self {
            Self::Douyin => "douyin",
            Self::Xhs => "xhs",
        }
    }

    pub fn name(&self) -> &'static str {
        match self {
            Self::Douyin => "抖音",
            Self::Xhs => "小红书",
        }
    }

    pub fn host_keyword(&self) -> &'static str {
        match self {
            Self::Douyin => "douyin.com",
            Self::Xhs => "xiaohongshu.com",
        }
    }

    pub fn login_url(&self) -> &'static str {
        match self {
            Self::Douyin => "https://www.douyin.com/",
            Self::Xhs => "https://www.xiaohongshu.com/explore",
        }
    }

    pub fn search_url(&self, keyword: &str) -> String {
        let kw: String = url::form_urlencoded::byte_serialize(keyword.as_bytes()).collect();
        match self {
            Self::Douyin => format!("https://www.douyin.com/search/{kw}?type=general"),
            Self::Xhs => {
                format!("https://www.xiaohongshu.com/search_result?keyword={kw}&source=web_explore_feed&type=51")
            }
        }
    }

    pub fn auth_cookies(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &["sessionid_ss", "sessionid", "sid_guard", "sid_tt"],
            Self::Xhs => &["web_session"],
        }
    }

    pub fn login_triggers(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &[
                "#login-panel-new",
                "[data-e2e='login-button']",
                ".login-button",
            ],
            Self::Xhs => &[
                "#login-btn",
                ".login-btn",
                ".side-bar .user .link-wrapper",
            ],
        }
    }

    pub fn qr_selectors(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &[
                "#login-panel-new img",
                ".web-login-scan-code__content__qrcode-wrapper img",
                ".web-login-scan-code img",
                "[class*='qrcode'] img",
                "#login-panel-new",
            ],
            Self::Xhs => &[
                ".login-container .qrcode-img",
                ".qrcode-img",
                ".login-container img[src^='data:image']",
                "img.qrcode-img",
                ".login-box-container .qrcode",
                ".login-container",
            ],
        }
    }

    pub fn guest_indicators(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &["[data-e2e='login-button']", "#login-panel-new"],
            Self::Xhs => &[".login-btn", "#login-btn", ".login-btn-component"],
        }
    }

    pub fn login_progress_indicators(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &[".web-login-scan-code", "#login-panel-new"],
            Self::Xhs => &[".login-container", ".login-box-container", ".login-popup"],
        }
    }

    pub fn logged_in_indicators(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &["[data-e2e='user-avatar']", ".avatar"],
            Self::Xhs => &[".reds-avatar", ".user-avatar", ".user-info", "[class*='avatar']"],
        }
    }

    pub fn search_api_hints(&self) -> &'static [&'static str] {
        match self {
            Self::Douyin => &[
                "/aweme/v1/web/general/search/single/",
                "/aweme/v1/web/search/item/",
            ],
            Self::Xhs => &["/api/sns/web/v1/search/notes"],
        }
    }

    pub fn dom_extract_js(&self) -> &'static str {
        match self {
            Self::Xhs => r#"(() => {
              const out = [];
              const nodes = document.querySelectorAll('section.note-item, div.note-item');
              for (const n of nodes) {
                const a = n.querySelector('a.cover') || n.querySelector('a[href*="/explore/"]') || n.querySelector('a');
                const href = a ? a.getAttribute('href') : '';
                const titleEl = n.querySelector('.title span, .title, .content');
                const img = n.querySelector('img');
                const title = ((titleEl && titleEl.textContent) || (img && img.alt) || '').trim();
                const authorEl = n.querySelector('.author .name, .name');
                const likeEl = n.querySelector('.like-wrapper .count, .count');
                if (!title) continue;
                out.push({
                  t: title,
                  l: likeEl ? likeEl.textContent.trim() : '—',
                  c: '—',
                  tags: [],
                  url: href ? (href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href) : '',
                  nickname: authorEl ? authorEl.textContent.trim() : ''
                });
              }
              return out.slice(0, 30);
            })()"#,
            Self::Douyin => r#"(() => {
              const out = [];
              const nodes = document.querySelectorAll('[data-e2e="scroll-list"] li, .search-result-card, li[class*="SwitchTab"]');
              for (const n of nodes) {
                const a = n.querySelector('a[href*="/video/"]') || n.querySelector('a');
                const href = a ? a.getAttribute('href') : '';
                const titleEl = n.querySelector('[class*="title"], .video-title, .desc');
                const title = titleEl ? titleEl.textContent.trim() : '';
                const authorEl = n.querySelector('[class*="author"], [class*="nickname"]');
                const likeEl = n.querySelector('[class*="like"], [class*="count"]');
                if (!title) continue;
                out.push({
                  t: title,
                  l: likeEl ? likeEl.textContent.trim() : '—',
                  c: '—',
                  tags: [],
                  url: href ? (href.startsWith('http') ? href : 'https://www.douyin.com' + href) : '',
                  nickname: authorEl ? authorEl.textContent.trim() : ''
                });
              }
              return out.slice(0, 30);
            })()"#,
        }
    }
}

pub const RISK_KEYWORDS: &[&str] = &[
    "300012",
    "IP 存在风险",
    "IP存在风险",
    "网络连接异常",
    "当前登录存在风险",
    "环境异常",
    "操作太频繁",
    "访问频次异常",
    "您的访问行为异常",
    "网络环境存在异常",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchItem {
    pub t: String,
    pub l: String,
    pub c: String,
    pub tags: Vec<String>,
    pub url: String,
    pub nickname: String,
}

fn fmt_count(val: Option<&Value>) -> String {
    let Some(v) = val else {
        return "—".to_string();
    };
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() || trimmed == "赞" || trimmed == "点赞" {
            return "—".to_string();
        }
        return trimmed.to_string();
    }
    if let Some(n) = v.as_i64() {
        return format_with_commas(n);
    }
    if let Some(n) = v.as_u64() {
        return format_with_commas(n as i64);
    }
    "—".to_string()
}

fn format_with_commas(n: i64) -> String {
    let s = n.to_string();
    let bytes = s.as_bytes();
    let mut out = String::new();
    let len = bytes.len();
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 && (len - i) % 3 == 0 && *b != b'-' {
            out.push(',');
        }
        out.push(*b as char);
    }
    out
}

pub fn parse_search_payload(
    platform: PlatformKey,
    payload: &Value,
) -> (Vec<SearchItem>, Option<String>) {
    match platform {
        PlatformKey::Xhs => parse_xhs_search(payload),
        PlatformKey::Douyin => parse_douyin_search(payload),
    }
}

fn parse_xhs_search(payload: &Value) -> (Vec<SearchItem>, Option<String>) {
    let code = payload.get("code").and_then(|v| v.as_i64());
    let success = payload.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
    if !matches!(code, None | Some(0)) && !success {
        let msg = payload.get("msg").and_then(|v| v.as_str()).unwrap_or("");
        if code == Some(300012) || msg.contains("网络连接异常") {
            return (
                vec![],
                Some("小红书风控拦截（error_code=300012）：请确认已登录且网络环境正常".into()),
            );
        }
        return (
            vec![],
            Some(format!("小红书接口返回异常：{:?} {msg}", code)),
        );
    }

    let mut items = Vec::new();
    if let Some(arr) = payload
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(|v| v.as_array())
    {
        for it in arr {
            let Some(card) = it.get("note_card") else {
                continue;
            };
            let title = card
                .get("display_title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if title.is_empty() {
                continue;
            }
            let inter = card.get("interact_info");
            let user = card.get("user");
            let mut nid = it
                .get("id")
                .or_else(|| card.get("note_id"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(stripped) = nid.strip_prefix("search_result/") {
                nid = stripped.to_string();
            }
            let token = it
                .get("xsec_token")
                .or_else(|| card.get("xsec_token"))
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let mut url = if !nid.is_empty() {
                format!("https://www.xiaohongshu.com/explore/{nid}")
            } else {
                String::new()
            };
            if !url.is_empty() && !token.is_empty() {
                url.push_str(&format!("?xsec_token={token}"));
            }
            let nickname = user
                .and_then(|u| u.get("nickname").or_else(|| u.get("nick_name")))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();

            items.push(SearchItem {
                t: title.to_string(),
                l: fmt_count(inter.and_then(|i| i.get("liked_count"))),
                c: fmt_count(inter.and_then(|i| i.get("comment_count"))),
                tags: vec![],
                url,
                nickname,
            });
        }
    }
    (items, None)
}

fn parse_douyin_search(payload: &Value) -> (Vec<SearchItem>, Option<String>) {
    let status = payload.get("status_code").and_then(|v| v.as_i64());
    if !matches!(status, None | Some(0)) {
        return (
            vec![],
            Some(format!("抖音接口返回异常：status_code={}", status.unwrap_or(-1))),
        );
    }

    let mut items = Vec::new();
    if let Some(arr) = payload.get("data").and_then(|v| v.as_array()) {
        for it in arr {
            let Some(info) = it.get("aweme_info") else {
                continue;
            };
            let title = info
                .get("desc")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if title.is_empty() {
                continue;
            }
            let stat = info.get("statistics");
            let author = info.get("author");
            let aid = info
                .get("aweme_id")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            items.push(SearchItem {
                t: title.to_string(),
                l: fmt_count(stat.and_then(|s| s.get("digg_count"))),
                c: fmt_count(stat.and_then(|s| s.get("comment_count"))),
                tags: vec![],
                url: if !aid.is_empty() {
                    format!("https://www.douyin.com/video/{aid}")
                } else {
                    String::new()
                },
                nickname: author
                    .and_then(|a| a.get("nickname"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .unwrap_or("")
                    .to_string(),
            });
        }
    }
    (items, None)
}
