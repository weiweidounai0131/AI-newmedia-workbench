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
