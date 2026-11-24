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

#[cfg(target_os = "macos")]
const CHROME_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

#[cfg(not(target_os = "macos"))]
const CHROME_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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

/// 仅精准清理占用本工作台独立 Profile 目录的残留浏览器进程与死锁文件（绝不影响用户日常 Chrome）
fn cleanup_stale_profile_browser(user_data: &std::path::Path) {
    let dir_str = user_data.to_string_lossy().to_string();
    #[cfg(unix)]
    {
        let pattern = format!("--user-data-dir={dir_str}");
        let _ = Command::new("pkill")
            .args(["-f", &pattern])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(Duration::from_millis(250));
    }
    #[cfg(target_os = "windows")]
    {
        let escaped = dir_str.replace('\'', "''");
        let ps = format!(
            "Get-CimInstance Win32_Process | Where-Object {{ $_.CommandLine -like '*--user-data-dir={escaped}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }}"
        );
        let _ = Command::new("powershell.exe")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &ps])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(Duration::from_millis(250));
    }
    for lock_name in [
        "SingletonLock",
        "SingletonSocket",
        "SingletonCookie",
        "DevToolsActivePort",
    ] {
        let p = user_data.join(lock_name);
        let _ = fs::remove_file(&p);
    }
}

async fn fetch_page_ws_url(port: u16, child: &mut Child) -> Result<String, String> {
    // 关键：强制 no_proxy() 直连本机 127.0.0.1，防止被本机系统代理/Clash 劫持导致超时！
    let client = Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    let list_url = format!("http://127.0.0.1:{port}/json/list");
    let deadline = Instant::now() + Duration::from_secs(15);

    while Instant::now() < deadline {
        if let Ok(Some(exit_status)) = child.try_wait() {
            return Err(format!(
                "后台浏览器进程提前退出（{exit_status}），请重试或检查本机 Chrome/Edge 状态"
            ));
        }
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
        tokio::time::sleep(Duration::from_millis(220)).await;
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
    cleanup_stale_profile_browser(&user_data);

    let mut cmd = Command::new(&exe);
    let visible_browser = std::env::var("NEWMEDIA_VISIBLE_BROWSER")
        .map(|v| matches!(v.trim().to_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);

    // 默认使用 --headless=new（Chrome 新版完整有头管线）实现 100% 后台无感运行，不弹窗口不抢焦点
    if !visible_browser {
        cmd.arg("--headless=new");
    }
    cmd.args([
        "--remote-debugging-address=127.0.0.1",
        &format!("--remote-debugging-port={port}"),
        &format!("--user-data-dir={}", user_data.to_string_lossy()),
        &format!("--user-agent={CHROME_UA}"),
        // 平台登录与采集固定直连本机网络，不走系统外网代理（既免回环被劫持，又防小红书/抖音海外 IP 风控）
        "--proxy-server=direct://",
        "--proxy-bypass-list=*",
        "--disable-blink-features=AutomationControlled",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--window-size=1280,860",
        "--lang=zh-CN",
        "about:blank",
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("拉起本机浏览器失败（{exe}）：{e}"))?;
    crate::core::logger::info(
        "cdp",
        format!("spawned browser for {} on port {port} (headless={})", platform.key(), !visible_browser),
    );

    let ws_url = match fetch_page_ws_url(port, &mut child).await {
        Ok(u) => u,
        Err(e) => {
            crate::core::logger::error("cdp", format!("fetch ws url failed for {}: {e}", platform.key()));
            let _ = child.kill();
            return Err(e);
        }
    };
    let session = CdpSession::connect(&ws_url).await?;
    let _ = session
        .send(
            "Emulation.setUserAgentOverride",
            serde_json::json!({
                "userAgent": CHROME_UA,
                "acceptLanguage": "zh-CN,zh;q=0.9",
                "platform": if cfg!(target_os = "macos") { "MacIntel" } else { "Win32" }
            }),
        )
        .await;
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

/// 通过平台官方同源接口校验真实登录态（彻底杜绝小红书游客 web_session 与信息流头像误判）
async fn probe_api_logged_in(session: &CdpSession, platform: PlatformKey) -> Option<bool> {
    match platform {
        PlatformKey::Xhs => {
            let js = r#"(async () => {
              try {
                if (!location.hostname.includes('xiaohongshu.com')) return null;
                const resp = await fetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', {
                  credentials: 'include',
                  headers: { 'accept': 'application/json' }
                });
                if (!resp.ok) return null;
                const j = await resp.json();
                const d = j && j.data;
                if (!d) return false;
                if (d.guest === true) return false;
                return Boolean(d.user_id && String(d.user_id).length > 0 && d.guest === false);
              } catch (_) {
                return null;
              }
            })()"#;
            match session.eval_json(js).await {
                Ok(Value::Bool(b)) => Some(b),
                _ => None,
            }
        }
        PlatformKey::Douyin => {
            let js = r#"(async () => {
              try {
                if (!location.hostname.includes('douyin.com')) return null;
                const resp = await fetch('https://www.douyin.com/aweme/v1/web/user/profile/self/', {
                  credentials: 'include',
                  headers: { 'accept': 'application/json' }
                });
                if (!resp.ok) return null;
                const j = await resp.json();
                const u = j && j.user;
                return Boolean(u && (u.uid || u.sec_uid));
              } catch (_) {
                return null;
              }
            })()"#;
            match session.eval_json(js).await {
                Ok(Value::Bool(b)) => Some(b),
                _ => None,
            }
        }
    }
}

async fn is_logged_in_live(session: &CdpSession, platform: PlatformKey) -> bool {
    let cookie_ok = has_auth_cookie(session, platform).await;
    if !cookie_ok {
        clear_verified_marker(platform);
        return false;
    }

    // 1. 最高权威：同源官方 /user/me 接口判定（直接区分游客与真实登录）
    if let Some(api_logged) = probe_api_logged_in(session, platform).await {
        if api_logged {
            set_verified_marker(platform);
            return true;
        } else {
            clear_verified_marker(platform);
            return false;
        }
    }

    // 2. 其次页面精确 DOM 探针（仅匹配本人头像且无登录按钮/无登录弹窗）
    match probe_dom_logged_in(session, platform).await {
        Some(true) => {
            set_verified_marker(platform);
            true
        }
        Some(false) => {
            clear_verified_marker(platform);
            false
        }
        None => {
            // 小红书游客也有 web_session，无法确认时绝不盲信
            if platform == PlatformKey::Xhs {
                false
            } else {
                has_verified_marker(platform)
            }
        }
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

    // 尝试点击登录按钮，并在抖音侧主动切换到「扫码登录」标签页确保二维码可见
    let triggers_json = serde_json::to_string(platform.login_triggers()).unwrap_or_default();
    let _ = session
        .eval_json(&format!(
            r#"(() => {{
              const clickVisible = (el) => {{
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {{ el.click(); return true; }}
                return false;
              }};
              for (const sel of {triggers_json}) {{
                if (clickVisible(document.querySelector(sel))) break;
              }}
              // 若登录框已存在但停在密码/验证码页，主动点出扫码登录
              for (const el of document.querySelectorAll('button, div, span, li, a')) {{
                const t = (el.textContent || '').trim();
                if (t === '扫码登录' || t === '二维码登录') {{
                  if (clickVisible(el)) break;
                }}
              }}
              return true;
            }})()"#
        ))
        .await;
    tokio::time::sleep(Duration::from_millis(1400)).await;

    // 优先精准读取二维码：严格校验近似正方形（过滤横幅/广告图），支持 data:image / canvas 无损直读
    let qr_sels_json = serde_json::to_string(platform.qr_selectors()).unwrap_or_default();
    let mut qr_data: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(12);
    while Instant::now() < deadline {
        if let Ok(val) = session
            .eval_json(&format!(
                r#"(() => {{
                  const isSquareQr = (r) => {{
                    if (!r || r.width < 100 || r.height < 100 || r.width > 420 || r.height > 420) return false;
                    const ratio = r.width / r.height;
                    return ratio >= 0.78 && ratio <= 1.28;
                  }};
                  const extract = (el) => {{
                    if (!el) return null;
                    const s = getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return null;
                    const r = el.getBoundingClientRect();
                    if (!isSquareQr(r)) return null;
                    if (el.tagName === 'IMG' && el.src && el.src.startsWith('data:image')) {{
                      return {{ dataUrl: el.src }};
                    }}
                    if (el.tagName === 'CANVAS') {{
                      try {{
                        const d = el.toDataURL('image/png');
                        if (d && d.startsWith('data:image') && d.length > 500) return {{ dataUrl: d }};
                      }} catch (_) {{}}
                    }}
                    return {{ rect: {{ x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height }} }};
                  }};
                  for (const sel of {qr_sels_json}) {{
                    const nodes = document.querySelectorAll(sel);
                    for (const el of nodes) {{
                      const hit = extract(el);
                      if (hit) return hit;
                    }}
                  }}
                  // 兜底：扫描页面上所有近似正方形的 data:image 或 canvas 二维码
                  for (const el of document.querySelectorAll("img[src^='data:image'], canvas")) {{
                    const r = el.getBoundingClientRect();
                    if (r.width >= 110 && r.width <= 360 && Math.abs(r.width - r.height) <= 24) {{
                      const hit = extract(el);
                      if (hit) return hit;
                    }}
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
                if w >= 100.0 && h >= 100.0 {
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
    crate::core::logger::info("cdp", format!("fetch_initial_state_via_cdp platform={} url={url}", platform.key()));
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
                crate::core::logger::info("cdp", format!("captured __INITIAL_STATE__ for {}", platform.key()));
                return Ok(val);
            }
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }

    crate::core::logger::warn("cdp", format!("timeout waiting __INITIAL_STATE__ for {} url={url}", platform.key()));
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
