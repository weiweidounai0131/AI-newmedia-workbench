use chrono::Local;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// 优先聚焦刚需：抖音 + 小红书（保留扩展接口位）
pub const HOT_RANK_PLATFORMS: [&str; 2] = ["抖音", "小红书"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotRankItem {
    pub t: String,
    pub heat: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub link: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AllHotRanksResult {
    pub items: HashMap<String, Vec<HotRankItem>>,
    pub failed: Vec<String>,
    pub hour_key: String,
}

#[derive(Clone)]
struct CachedRank {
    hour_key: String,
    items: Vec<HotRankItem>,
}

static CACHE: Lazy<Mutex<HashMap<String, CachedRank>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn current_hour_key() -> String {
    Local::now().format("%Y-%m-%d-%H").to_string()
}

fn base_url() -> String {
    std::env::var("HOT_RANK_API_BASE")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://60s.viki.moe".to_string())
        .trim_end_matches('/')
        .to_string()
}

fn source_path(platform: &str) -> Option<&'static str> {
    match platform {
        "抖音" => Some("douyin"),
        "小红书" => Some("rednote"),
        "微博" => Some("weibo"),
        "知乎" => Some("zhihu"),
        _ => None,
    }
}

fn fallback_link(platform: &str, title: &str) -> String {
    let encoded: String = url::form_urlencoded::byte_serialize(title.as_bytes()).collect();
    match platform {
        "抖音" => format!("https://www.douyin.com/search/{encoded}"),
        "小红书" => format!("https://www.xiaohongshu.com/search_result?keyword={encoded}&type=51"),
        "微博" => format!("https://s.weibo.com/weibo?q={encoded}"),
        "知乎" => format!("https://www.zhihu.com/search?type=content&q={encoded}"),
        _ => String::new(),
    }
}

fn compact_heat(val: Option<&serde_json::Value>) -> String {
    let Some(v) = val else {
        return String::new();
    };
    if let Some(n) = v.as_f64() {
        if n >= 1e8 {
            let s = format!("{:.1}", n / 1e8);
            return format!("{}亿", s.trim_end_matches(".0"));
        }
        if n >= 1e4 {
            let s = format!("{:.1}", n / 1e4);
            return format!("{}w", s.trim_end_matches(".0"));
        }
        return format!("{}", n as i64);
    }
    if let Some(s) = v.as_str() {
        return s.trim().to_string();
    }
    String::new()
}

pub async fn fetch_hot_rank(platform: &str) -> Result<Vec<HotRankItem>, String> {
    let Some(path) = source_path(platform) else {
        return Err(format!("暂不支持热榜平台：{platform}"));
    };

    let hour_key = current_hour_key();
    let cached_fallback = {
        let guard = CACHE.lock().unwrap();
        if let Some(entry) = guard.get(platform) {
            if entry.hour_key == hour_key {
                return Ok(entry.items.clone());
            }
            Some(entry.items.clone())
        } else {
            None
        }
    };

    let url = format!("{}/v2/{path}", base_url());
    let client = Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;

    let result: Result<Vec<HotRankItem>, String> = async {
        let resp = client
            .get(&url)
            .header("accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("热榜请求失败：{e}"))?;
        if !resp.status().is_success() {
            return Err(format!("上游热榜返回 HTTP {}", resp.status().as_u16()));
        }
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("热榜响应解析失败：{e}"))?;
        if let Some(code) = body.get("code").and_then(|v| v.as_i64()) {
            if code != 200 {
                return Err(format!("上游热榜返回异常码：{code}"));
            }
        }
        let arr = body
            .get("data")
            .and_then(|v| v.as_array())
            .ok_or_else(|| "上游未返回热榜列表".to_string())?;

        let mut items = Vec::with_capacity(20);
        for raw in arr {
            let title = raw
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .unwrap_or("");
            if title.is_empty() {
                continue;
            }
            let tag = raw
                .get("word_type")
                .or_else(|| raw.get("tag"))
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty() && *s != "无")
                .map(|s| s.to_string());
            let heat = compact_heat(
                raw.get("score")
                    .or_else(|| raw.get("hot_value_desc"))
                    .or_else(|| raw.get("hot_value"))
                    .or_else(|| raw.get("heat")),
            );
            let link = raw
                .get("link")
                .and_then(|v| v.as_str())
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| fallback_link(platform, title));

            items.push(HotRankItem {
                t: title.to_string(),
                heat,
                tag,
                link,
            });
            if items.len() >= 20 {
                break;
            }
        }
        Ok(items)
    }
    .await;

    match result {
        Ok(items) => {
            let mut guard = CACHE.lock().unwrap();
            guard.insert(
                platform.to_string(),
                CachedRank {
                    hour_key,
                    items: items.clone(),
                },
            );
            Ok(items)
        }
        Err(err) => {
            if let Some(old) = cached_fallback {
                Ok(old)
            } else {
                Err(err)
            }
        }
    }
}

pub async fn fetch_all_hot_ranks() -> AllHotRanksResult {
    let hour_key = current_hour_key();
    let mut items = HashMap::new();
    let mut failed = Vec::new();

    let (dy, xhs) = tokio::join!(fetch_hot_rank("抖音"), fetch_hot_rank("小红书"));
    match dy {
        Ok(list) => {
            items.insert("抖音".to_string(), list);
        }
        Err(_) => failed.push("抖音".to_string()),
    }
    match xhs {
        Ok(list) => {
            items.insert("小红书".to_string(), list);
        }
        Err(_) => failed.push("小红书".to_string()),
    }

    AllHotRanksResult {
        items,
        failed,
        hour_key,
    }
}
