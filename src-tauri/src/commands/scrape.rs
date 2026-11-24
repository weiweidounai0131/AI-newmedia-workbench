use serde::Serialize;

use crate::cdp::cooldown::{self, PlatformCooldownsResp};
use crate::cdp::manager::{self, LoginSessionResp, QrLoginResp, ScrapeStatusResp, SearchResp};

#[derive(Debug, Serialize)]
pub struct ScrapeLoginResp {
    pub ok: bool,
    pub connected: bool,
    pub platforms: std::collections::HashMap<String, bool>,
}

#[tauri::command]
pub async fn scrape_status() -> ScrapeStatusResp {
    manager::status_all().await
}

#[tauri::command]
pub fn scrape_cooldowns(scope: String) -> PlatformCooldownsResp {
    cooldown::list_cooldowns(&scope)
}

#[tauri::command]
pub async fn scrape_login_qr(platform: String) -> Result<QrLoginResp, String> {
    manager::start_login_qr(&platform).await
}

#[tauri::command]
pub async fn scrape_login_session(platform: String) -> Result<LoginSessionResp, String> {
    manager::poll_login_session(&platform).await
}

#[tauri::command]
pub async fn scrape_login(platform: String) -> Result<ScrapeLoginResp, String> {
    let session = manager::poll_login_session(&platform).await?;
    let all = manager::status_all().await;
    Ok(ScrapeLoginResp {
        ok: true,
        connected: session.connected,
        platforms: all.platforms,
    })
}

#[tauri::command]
pub async fn scrape_logout(platform: String) -> Result<bool, String> {
    manager::logout_platform(&platform).await?;
    Ok(true)
}

#[tauri::command]
pub async fn search_content(
    kw: String,
    platform: String,
    limit: Option<usize>,
) -> SearchResp {
    manager::search_platform(&platform, &kw, limit.unwrap_or(20).clamp(1, 30)).await
}

#[tauri::command]
pub async fn open_verify_window(platform: String, kw: Option<String>) -> Result<bool, String> {
    manager::open_verify_window(&platform, kw.as_deref()).await?;
    Ok(true)
}
