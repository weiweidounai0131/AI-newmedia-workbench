use serde::Serialize;

use crate::cdp::browser::{detect_system_browser, BrowserInfo};
use crate::core::paths::{inspect_legacy_install, resolve_app_data_dir, LegacyInstallInfo};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemHealth {
    pub ok: bool,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    pub data_dir: String,
    pub python_required: bool,
    pub browser: BrowserInfo,
    pub legacy: LegacyInstallInfo,
}

#[tauri::command]
pub fn get_system_health() -> Result<SystemHealth, String> {
    let data_dir = resolve_app_data_dir().map_err(|e| e.to_string())?;
    let browser = detect_system_browser();
    let legacy = inspect_legacy_install();

    Ok(SystemHealth {
        ok: true,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
        python_required: false,
        browser,
        legacy,
    })
}

#[tauri::command]
pub fn write_client_log(level: String, module: String, message: String) {
    let lv = match level.to_uppercase().as_str() {
        "ERROR" => "ERROR",
        "WARN" => "WARN",
        _ => "INFO",
    };
    crate::core::logger::write_log(lv, &format!("web:{module}"), &message);
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("仅支持打开 http(s) 链接".into());
    }
    let normalized = if trimmed.contains("xiaohongshu.com/search_result/") {
        trimmed.replace("/search_result/", "/explore/")
    } else {
        trimmed.to_string()
    };

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&normalized)
            .spawn()
            .map_err(|e| format!("打开系统浏览器失败：{e}"))?;
        Ok(())
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32")
            .args(["url.dll,FileProtocolHandler", &normalized])
            .spawn()
            .map_err(|e| format!("打开系统浏览器失败：{e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&normalized)
            .spawn()
            .map_err(|e| format!("打开系统浏览器失败：{e}"))?;
        Ok(())
    }
}
