use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub found: bool,
    pub name: Option<String>,
    pub path: Option<String>,
}

/// 探测本机已安装的 Chromium 系浏览器（Chrome / Edge），用于 Phase 3 原生 CDP 驱动。
/// 优先顺序：环境变量覆盖 → Google Chrome → Microsoft Edge → Chromium。
pub fn detect_system_browser() -> BrowserInfo {
    if let Ok(custom) = std::env::var("NEWMEDIA_BROWSER_PATH") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return BrowserInfo {
                found: true,
                name: Some("自定义浏览器".to_string()),
                path: Some(trimmed.to_string()),
            };
        }
    }

    for (name, candidate) in candidate_browser_paths() {
        if candidate.is_file() {
            return BrowserInfo {
                found: true,
                name: Some(name.to_string()),
                path: Some(candidate.to_string_lossy().to_string()),
            };
        }
    }

    BrowserInfo {
        found: false,
        name: None,
        path: None,
    }
}

#[cfg(target_os = "macos")]
fn candidate_browser_paths() -> Vec<(&'static str, PathBuf)> {
    let mut list = vec![
        (
            "Google Chrome",
            PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ),
        (
            "Microsoft Edge",
            PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ),
        (
            "Chromium",
            PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
        ),
    ];
    if let Some(home) = dirs::home_dir() {
        list.push((
            "Google Chrome (用户目录)",
            home.join("Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ));
        list.push((
            "Microsoft Edge (用户目录)",
            home.join("Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ));
    }
    list
}

#[cfg(target_os = "windows")]
fn candidate_browser_paths() -> Vec<(&'static str, PathBuf)> {
    let mut list = vec![
        (
            "Google Chrome",
            PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
        ),
        (
            "Google Chrome (x86)",
            PathBuf::from(r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"),
        ),
        (
            "Microsoft Edge",
            PathBuf::from(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
        ),
        (
            "Microsoft Edge (x64)",
            PathBuf::from(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
        ),
    ];
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let base = PathBuf::from(local_app_data);
        list.push((
            "Google Chrome (用户目录)",
            base.join(r"Google\Chrome\Application\chrome.exe"),
        ));
        list.push((
            "Microsoft Edge (用户目录)",
            base.join(r"Microsoft\Edge\Application\msedge.exe"),
        ));
    }
    list
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn candidate_browser_paths() -> Vec<(&'static str, PathBuf)> {
    vec![
        ("Google Chrome", PathBuf::from("/usr/bin/google-chrome")),
        ("Chromium", PathBuf::from("/usr/bin/chromium")),
        ("Microsoft Edge", PathBuf::from("/usr/bin/microsoft-edge")),
    ]
}
