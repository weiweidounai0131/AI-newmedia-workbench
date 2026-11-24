use chrono::Local;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// 支持 4 大内容热榜平台（60s + uapis 双源容错）
pub const HOT_RANK_PLATFORMS: [&str; 4] = ["抖音", "小红书", "微博", "知乎"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotRankItem {
    pub t: String,
    pub heat: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub link: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
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

fn primary_source_path(platform: &str) -> Option<&'static str> {
    match platform {
        "抖音" => Some("douyin"),
        "小红书" => Some("rednote"),
        "微博" => Some("weibo"),
        "知乎" => Some("zhihu"),
        _ => None,
    }
}

fn uapis_source_type(platform: &str) -> Option<&'static str> {
    match platform {
        "抖音" => Some("douyin"),
        "小红书" => Some("xiaohongshu"),
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

fn compact_heat(val: Option<&Value>) -> String {
    let Some(v) = val else {
        return String::new();
    };
    if let Some(n) = v.as_f64() {
        return format_heat_number(n);
    }
    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if let Ok(n) = trimmed.parse::<f64>() {
            return format_heat_number(n);
        }
        return trimmed.to_string();
    }
    String::new()
}

fn format_heat_number(n: f64) -> String {
    if !n.is_finite() {
        return String::new();
    }
    if n >= 1e8 {
        let s = format!("{:.1}", n / 1e8);
        return format!("{}亿", s.trim_end_matches(".0"));
    }
    if n >= 1e4 {
        let s = format!("{:.1}", n / 1e4);
        return format!("{}w", s.trim_end_matches(".0"));
    }
    format!("{}", n as i64)
}

fn normalize_items(platform: &str, arr: &[Value]) -> Vec<HotRankItem> {
    let mut items = Vec::with_capacity(20);
    for raw in arr {
        let title = raw
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        if title.is_empty() {
            continue;
        }
        let tag = raw
            .get("word_type")
            .or_else(|| raw.get("tag"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty() && *s != "无")
            .map(str::to_string);
        let heat = compact_heat(
            raw.get("score")
                .or_else(|| raw.get("hot_value_desc"))
                .or_else(|| raw.get("hot_value"))
                .or_else(|| raw.get("heat")),
        );
        let link = raw
            .get("link")
            .or_else(|| raw.get("url"))
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
            .map(str::to_string)
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
    items
}

async fn fetch_from_60s(client: &Client, platform: &str) -> Result<Vec<HotRankItem>, String> {
    let path = primary_source_path(platform)
        .ok_or_else(|| format!("暂不支持热榜平台：{platform}"))?;
    let url = format!("{}/v2/{path}", base_url());
    let resp = client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("60s 热榜请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("60s 热榜返回 HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("60s 响应解析失败：{e}"))?;
    if let Some(code) = body.get("code").and_then(|v| v.as_i64()) {
        if code != 200 {
            return Err(format!("60s 返回异常码：{code}"));
        }
    }
    let arr = body
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "60s 未返回热榜列表".to_string())?;
    let items = normalize_items(platform, arr);
    if items.is_empty() {
        return Err("60s 返回空列表".into());
    }
    Ok(items)
}

async fn fetch_from_uapis(client: &Client, platform: &str) -> Result<Vec<HotRankItem>, String> {
    let source = uapis_source_type(platform)
        .ok_or_else(|| format!("备用热榜暂不支持：{platform}"))?;
    let url = format!("https://uapis.cn/api/v1/misc/hotboard?type={source}");
    let resp = client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("备用热榜请求失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("备用热榜返回 HTTP {}", resp.status().as_u16()));
    }
    let body: Value = resp
        .json()
        .await
        .map_err(|e| format!("备用热榜解析失败：{e}"))?;
    let arr = body
        .get("list")
        .or_else(|| body.get("data"))
        .and_then(|v| v.as_array())
        .ok_or_else(|| "备用热榜未返回列表".to_string())?;
    let items = normalize_items(platform, arr);
    if items.is_empty() {
        return Err("备用热榜返回空列表".into());
    }
    Ok(items)
}

pub async fn fetch_hot_rank(platform: &str) -> Result<Vec<HotRankItem>, String> {
    if primary_source_path(platform).is_none() {
        return Err(format!("暂不支持热榜平台：{platform}"));
    }

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

    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| e.to_string())?;

    // 多源自动容错：优先 60s.viki.moe，失败（如 500/429）无缝切换 uapis.cn 公开热榜源
    let result = match fetch_from_60s(&client, platform).await {
        Ok(items) => Ok(items),
        Err(primary_err) => match fetch_from_uapis(&client, platform).await {
            Ok(items) => Ok(items),
            Err(fallback_err) => Err(format!("{primary_err}；备用源：{fallback_err}")),
        },
    };

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

    // 错开 200ms 依次请求 4 平台，避免触发同一上游源突发 429 限流
    for (idx, platform) in HOT_RANK_PLATFORMS.iter().enumerate() {
        if idx > 0 {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        match fetch_hot_rank(platform).await {
            Ok(list) => {
                items.insert((*platform).to_string(), list);
            }
            Err(_) => failed.push((*platform).to_string()),
        }
    }

    AllHotRanksResult {
        items,
        failed,
        hour_key,
    }
}
