use once_cell::sync::Lazy;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::cdp::browser::detect_system_browser;
use crate::cdp::client::CdpSession;
use crate::cdp::cooldown;
use crate::cdp::platforms::{parse_search_payload, PlatformKey, SearchItem, RISK_KEYWORDS};
use crate::core::paths::resolve_app_data_dir;

const STEALTH_JS: &str = r#"
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
"#;

struct BrowserInstance {
    _port: u16,
    child: Child,
    session: CdpSession,
}

static INSTANCES: Lazy<Mutex<HashMap<PlatformKey, BrowserInstance>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize)]
pub struct QrLoginResp {
    pub connected: bool,
    pub qr: Option<String>,
    pub headful: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoginSessionResp {
    pub connected: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchResp {
    pub items: Vec<SearchItem>,
    pub live: bool,
    pub reason: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScrapeStatusResp {
    pub electron: bool,
    pub platforms: HashMap<String, bool>,
}

fn profile_dir(platform: PlatformKey) -> Result<PathBuf, String> {
    let dir = resolve_app_data_dir()
        .map_err(|e| e.to_string())?
        .join("profiles")
        .join(platform.key());
    fs::create_dir_all(&dir).map_err(|e| format!("创建浏览器隔离目录失败：{e}"))?;
    Ok(dir)
}

fn marker_path(platform: PlatformKey) -> Result<PathBuf, String> {
    Ok(profile_dir(platform)?.join(".verified-login"))
}

fn has_verified_marker(platform: PlatformKey) -> bool {
    marker_path(platform).map(|p| p.is_file()).unwrap_or(false)
}

fn set_verified_marker(platform: PlatformKey) {
    if let Ok(p) = marker_path(platform) {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        let _ = fs::write(p, ts);
    }
}

fn clear_verified_marker(platform: PlatformKey) {
    if let Ok(p) = marker_path(platform) {
        let _ = fs::remove_file(p);
    }
}

fn pick_free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("分配本地调试端口失败：{e}"))?;
    listener
        .local_addr()
        .map(|a| a.port())
        .map_err(|e| e.to_string())
}

async fn fetch_page_ws_url(port: u16) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let deadline = Instant::now() + Duration::from_secs(15);

    while Instant::now() < deadline {
        if let Ok(resp) = client.get(&list_url).send().await {
            if let Ok(arr) = resp.json::<Vec<Value>>().await {
                if let Some(ws) = arr
                    .iter()
                    .find(|t| t.get("type").and_then(|v| v.as_str()) == Some("page"))
                    .and_then(|t| t.get("webSocketDebuggerUrl"))
                    .and_then(|v| v.as_str())
                {
                    return Ok(ws.to_string());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    Err("等待本机浏览器启动 CDP 调试端口超时，请检查安全软件或重试".into())
}

async fn ensure_session(platform: PlatformKey) -> Result<CdpSession, String> {
    let mut guard = INSTANCES.lock().await;
    if let Some(inst) = guard.get_mut(&platform) {
        // 检查进程是否存活且会话仍连通
        let alive = inst.child.try_wait().ok().flatten().is_none();
        if alive && inst.session.eval_json("1 + 1").await.is_ok() {
            return Ok(inst.session.clone());
        }
        let _ = inst.child.kill();
        guard.remove(&platform);
    }

    let browser = detect_system_browser();
    let exe = browser.path.ok_or_else(|| {
        "未检测到本机 Chrome 或 Edge 浏览器。请先安装 Google Chrome 或 Microsoft Edge 后重试。".to_string()
    })?;
    let port = pick_free_port()?;
    let user_data = profile_dir(platform)?;

    let mut cmd = Command::new(&exe);
    cmd.args([
        &format!("--remote-debugging-port={port}"),
        &format!("--user-data-dir={}", user_data.to_string_lossy()),
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--window-size=1220,820",
        "about:blank",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("拉起本机浏览器失败（{exe}）：{e}"))?;

    let ws_url = fetch_page_ws_url(port).await?;
    let session = CdpSession::connect(&ws_url).await?;
    let _ = session.add_stealth_script(STEALTH_JS).await;

    guard.insert(
        platform,
        BrowserInstance {
            _port: port,
            child,
            session: session.clone(),
        },
    );
    Ok(session)
}

async fn has_auth_cookie(session: &CdpSession, platform: PlatformKey) -> bool {
    let Ok(cookies) = session.get_cookies().await else {
        return false;
    };
    let host_kw = platform.host_keyword();
    let auth_names = platform.auth_cookies();
    cookies.iter().any(|c| {
        let domain = c.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let name = c.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let val = c.get("value").and_then(|v| v.as_str()).unwrap_or("");
        domain.contains(host_kw) && auth_names.contains(&name) && !val.is_empty()
    })
}

async fn probe_dom_logged_in(session: &CdpSession, platform: PlatformKey) -> Option<bool> {
    let guest_json = serde_json::to_string(platform.guest_indicators()).unwrap_or_default();
    let progress_json =
        serde_json::to_string(platform.login_progress_indicators()).unwrap_or_default();
    let ok_json = serde_json::to_string(platform.logged_in_indicators()).unwrap_or_default();
    let host_kw = platform.host_keyword();

    let js = format!(
        r#"(() => {{
          if (!location.hostname.includes({host_kw:?})) return null;
          const visible = (sel) => {{
            const el = document.querySelector(sel);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
          }};
          const progress = {progress_json};
          if (progress.some(visible)) return false;
          const guest = {guest_json};
          if (guest.some(visible)) return false;
          const ok = {ok_json};
          if (ok.some(visible)) return true;
          return null;
        }})()"#
    );

    match session.eval_json(&js).await {
        Ok(Value::Bool(b)) => Some(b),
        _ => None,
    }
}

async fn check_risk_message(session: &CdpSession) -> Option<String> {
    let Ok(Value::String(body)) = session
        .eval_json("document.body ? document.body.innerText.slice(0, 4000) : ''")
        .await
    else {
        return None;
    };
    for kw in RISK_KEYWORDS {
        if body.contains(kw) {
            if kw.contains("300012") || kw.contains("IP") || kw.contains("网络连接异常") {
                return Some(
                    "检测到平台风控或 IP/环境异常（如 300012），请在弹出的浏览器窗口中完成验证或稍后重试".into(),
                );
            }
            return Some(format!("登录环境异常：命中「{kw}」，请在浏览器窗口中处理后重试"));
        }
    }
    None
}

async fn is_logged_in_live(session: &CdpSession, platform: PlatformKey) -> bool {
    let cookie_ok = has_auth_cookie(session, platform).await;
    if !cookie_ok {
        return false;
    }
    match probe_dom_logged_in(session, platform).await {
        Some(true) => {
            set_verified_marker(platform);
            true
        }
        Some(false) => {
            clear_verified_marker(platform);
            false
        }
        None => has_verified_marker(platform),
    }
}

pub async fn status_all() -> ScrapeStatusResp {
    let mut platforms = HashMap::new();
    let guard = INSTANCES.lock().await;
    for p in [PlatformKey::Douyin, PlatformKey::Xhs] {
        let logged = if let Some(inst) = guard.get(&p) {
            is_logged_in_live(&inst.session, p).await
        } else {
            has_verified_marker(p)
        };
        platforms.insert(p.name().to_string(), logged);
    }
    ScrapeStatusResp {
        electron: true,
        platforms,
    }
}

pub async fn start_login_qr(platform_name: &str) -> Result<QrLoginResp, String> {
    let platform = PlatformKey::from_name(platform_name)
        .ok_or_else(|| format!("首版聚焦抖音与小红书，暂不支持「{platform_name}」"))?;
    let session = ensure_session(platform).await?;

    session.navigate(platform.login_url()).await?;
    tokio::time::sleep(Duration::from_millis(2200)).await;

    if is_logged_in_live(&session, platform).await {
        return Ok(QrLoginResp {
            connected: true,
            qr: None,
            headful: true,
            error: None,
        });
    }

    // 尝试点击登录按钮
    let triggers_json = serde_json::to_string(platform.login_triggers()).unwrap_or_default();
    let _ = session
        .eval_json(&format!(
            r#"(() => {{
              for (const sel of {triggers_json}) {{
                const el = document.querySelector(sel);
                if (el && el.getBoundingClientRect().width > 0) {{ el.click(); return true; }}
              }}
              return false;
            }})()"#
        ))
        .await;
    tokio::time::sleep(Duration::from_millis(1200)).await;

    // 优先读取二维码 data:image src，其次按元素坐标截图
    let qr_sels_json = serde_json::to_string(platform.qr_selectors()).unwrap_or_default();
    let mut qr_data: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if let Ok(val) = session
            .eval_json(&format!(
                r#"(() => {{
                  for (const sel of {qr_sels_json}) {{
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width < 40 || r.height < 40) continue;
                    if (el.tagName === 'IMG' && el.src && el.src.startsWith('data:image')) {{
                      return {{ dataUrl: el.src }};
                    }}
                    return {{ rect: {{ x: r.x, y: r.y, width: r.width, height: r.height }} }};
                  }}
                  return null;
                }})()"#
            ))
            .await
        {
            if let Some(url) = val.get("dataUrl").and_then(|v| v.as_str()) {
                qr_data = Some(url.to_string());
                break;
            }
            if let Some(rect) = val.get("rect") {
                let x = rect.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let y = rect.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let w = rect.get("width").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let h = rect.get("height").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if w >= 40.0 && h >= 40.0 {
                    if let Ok(b64) = session.capture_clip_png(x, y, w, h).await {
                        qr_data = Some(format!("data:image/png;base64,{b64}"));
                        break;
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(600)).await;
    }

    let err = check_risk_message(&session).await;
    Ok(QrLoginResp {
        connected: false,
        qr: qr_data,
        headful: true,
        error: err,
    })
}

pub async fn poll_login_session(platform_name: &str) -> Result<LoginSessionResp, String> {
    let platform = PlatformKey::from_name(platform_name)
        .ok_or_else(|| format!("暂不支持「{platform_name}」"))?;
    let guard = INSTANCES.lock().await;
    let Some(inst) = guard.get(&platform) else {
        return Ok(LoginSessionResp {
            connected: has_verified_marker(platform),
            error: None,
        });
    };
    let connected = is_logged_in_live(&inst.session, platform).await;
    let error = if !connected {
        check_risk_message(&inst.session).await
    } else {
        None
    };
    Ok(LoginSessionResp { connected, error })
}

pub async fn logout_platform(platform_name: &str) -> Result<(), String> {
    let platform = PlatformKey::from_name(platform_name)
        .ok_or_else(|| format!("暂不支持「{platform_name}」"))?;
    clear_verified_marker(platform);
    let mut guard = INSTANCES.lock().await;
    if let Some(mut inst) = guard.remove(&platform) {
        let _ = inst.child.kill();
    }
    Ok(())
}

pub async fn search_platform(
    platform_name: &str,
    keyword: &str,
    limit: usize,
) -> SearchResp {
    let kw = keyword.trim();
    if kw.is_empty() {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("empty_keyword".into()),
            message: Some("关键词不能为空".into()),
        };
    }

    let Some(platform) = PlatformKey::from_name(platform_name) else {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("unsupported".into()),
            message: Some(format!("首版聚焦抖音与小红书，暂不支持「{platform_name}」")),
        };
    };

    if let Err(msg) = cooldown::check_and_acquire("topic", platform.name(), 6) {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("cooldown".into()),
            message: Some(msg),
        };
    }

    let session = match ensure_session(platform).await {
        Ok(s) => s,
        Err(e) => {
            return SearchResp {
                items: vec![],
                live: false,
                reason: Some("browser_missing".into()),
                message: Some(e),
            };
        }
    };

    if !has_verified_marker(platform) && !is_logged_in_live(&session, platform).await {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("not_logged_in".into()),
            message: Some(format!("未登录「{}」，请先到设置页扫码登录后再搜索", platform.name())),
        };
    }

    let mut rx = session.subscribe();
    let hints = platform.search_api_hints();
    let target_url = platform.search_url(kw);
    if let Err(e) = session.navigate(&target_url).await {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("navigate_failed".into()),
            message: Some(format!("打开搜索页失败：{e}")),
        };
    }

    let mut captured: Vec<SearchItem> = Vec::new();
    let mut risk_err: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(16);

    while Instant::now() < deadline && captured.is_empty() && risk_err.is_none() {
        match tokio::time::timeout(Duration::from_millis(600), rx.recv()).await {
            Ok(Ok(ev)) if ev.method == "Network.responseReceived" => {
                let url = ev
                    .params
                    .get("response")
                    .and_then(|r| r.get("url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                if !hints.iter().any(|h| url.contains(h)) {
                    continue;
                }
                let Some(req_id) = ev.params.get("requestId").and_then(|v| v.as_str()) else {
                    continue;
                };
                // 略等响应体落齐
                tokio::time::sleep(Duration::from_millis(250)).await;
                if let Ok(body_str) = session.get_response_body(req_id).await {
                    if let Ok(payload) = serde_json::from_str::<Value>(&body_str) {
                        let (items, err) = parse_search_payload(platform, &payload);
                        if let Some(e) = err {
                            risk_err = Some(e);
                        }
                        if !items.is_empty() {
                            captured.extend(items);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    if let Some(err) = risk_err {
        if captured.is_empty() {
            cooldown::mark_risk_control("topic", platform.name(), 60);
            return SearchResp {
                items: vec![],
                live: false,
                reason: Some("risk_control".into()),
                message: Some(err),
            };
        }
    }

    // API 拦截未命中时，使用页面 DOM 兜底抽取
    if captured.is_empty() {
        tokio::time::sleep(Duration::from_millis(1200)).await;
        if let Ok(val) = session.eval_json(platform.dom_extract_js()).await {
            if let Ok(dom_items) = serde_json::from_value::<Vec<SearchItem>>(val) {
                captured.extend(dom_items.into_iter().filter(|i| !i.t.is_empty()));
            }
        }
    }

    if captured.is_empty() {
        return SearchResp {
            items: vec![],
            live: false,
            reason: Some("no_result".into()),
            message: Some(format!(
                "「{}」未抓到结果（可能登录态过期或触发验证码，请检查浏览器窗口）",
                platform.name()
            )),
        };
    }

    let mut seen = HashSet::new();
    let mut uniq = Vec::new();
    for item in captured {
        if seen.insert(item.t.clone()) {
            uniq.push(item);
            if uniq.len() >= limit {
                break;
            }
        }
    }

    SearchResp {
        items: uniq,
        live: true,
        reason: None,
        message: None,
    }
}

/// 提取指定平台的实时 Cookie 请求头字符串，供 Phase 4 抖音/小红书原生下载器共享同一登录态！
pub async fn get_cookie_header(platform: PlatformKey) -> Result<String, String> {
    let session = ensure_session(platform).await?;
    let cookies = session.get_cookies().await?;
    let host_kw = platform.host_keyword();
    let pairs: Vec<String> = cookies
        .iter()
        .filter_map(|c| {
            let domain = c.get("domain").and_then(|v| v.as_str()).unwrap_or("");
            if !domain.contains(host_kw) {
                return None;
            }
            let name = c.get("name").and_then(|v| v.as_str())?;
            let value = c.get("value").and_then(|v| v.as_str())?;
            Some(format!("{name}={value}"))
        })
        .collect();
    if pairs.is_empty() {
        return Err(format!("尚未获取到「{}」有效 Cookie，请先完成扫码登录", platform.name()));
    }
    Ok(pairs.join("; "))
}

/// 通过已登录的真实浏览器会话访问页面并提取 `window.__INITIAL_STATE__`（天然真实 TLS 指纹，抗风控最强）
pub async fn fetch_initial_state_via_cdp(
    platform: PlatformKey,
    url: &str,
) -> Result<Value, String> {
    let session = ensure_session(platform).await?;
    session.navigate(url).await?;

    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Ok(val) = session
            .eval_json(
                r#"(() => {
                  try {
                    if (window.__INITIAL_STATE__) {
                      return JSON.parse(JSON.stringify(window.__INITIAL_STATE__));
                    }
                  } catch (e) {}
                  return null;
                })()"#,
            )
            .await
        {
            if !val.is_null() {
                return Ok(val);
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    Err("未在页面中获取到内容数据，可能登录已过期或链接受风控保护".into())
}

/// 退出工作台时安全回收本次启动的所有浏览器进程（完整保留磁盘 Profile）
pub fn shutdown_all_sync() {
    if let Ok(mut guard) = INSTANCES.try_lock() {
        for (_, mut inst) in guard.drain() {
            let _ = inst.child.kill();
        }
    }
}
