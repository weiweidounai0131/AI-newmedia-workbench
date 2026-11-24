use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: String, // idle | checking | available | downloading | installing | error
    pub percent: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckUpdateResp {
    pub ok: bool,
    pub available: bool,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

static CURRENT_STATUS: Lazy<Mutex<UpdateStatus>> = Lazy::new(|| {
    Mutex::new(UpdateStatus {
        phase: "idle".into(),
        percent: 0,
        version: None,
        notes: None,
        message: None,
    })
});

static PENDING_UPDATE: Lazy<tokio::sync::Mutex<Option<Update>>> =
    Lazy::new(|| tokio::sync::Mutex::new(None));

fn set_status(app: &AppHandle, status: UpdateStatus) {
    if let Ok(mut guard) = CURRENT_STATUS.lock() {
        *guard = status.clone();
    }
    let _ = app.emit("update-status", status);
}

#[tauri::command]
pub fn get_update_status() -> UpdateStatus {
    CURRENT_STATUS
        .lock()
        .map(|g| g.clone())
        .unwrap_or(UpdateStatus {
            phase: "idle".into(),
            percent: 0,
            version: None,
            notes: None,
            message: None,
        })
}

#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> CheckUpdateResp {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    {
        let phase = CURRENT_STATUS
            .lock()
            .map(|g| g.phase.clone())
            .unwrap_or_default();
        if phase == "checking" || phase == "downloading" || phase == "installing" {
            return CheckUpdateResp {
                ok: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                reason: Some("checking".into()),
                error: Some("正在检查或下载更新，请稍候".into()),
            };
        }
    }

    set_status(
        &app,
        UpdateStatus {
            phase: "checking".into(),
            percent: 0,
            version: None,
            notes: None,
            message: Some("正在连接更新源检查新版本…".into()),
        },
    );
    crate::core::logger::info("updater", format!("checking updates (current={current_version})"));

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            let msg = format!("初始化自动更新模块失败：{e}");
            crate::core::logger::error("updater", &msg);
            set_status(
                &app,
                UpdateStatus {
                    phase: "error".into(),
                    percent: 0,
                    version: None,
                    notes: None,
                    message: Some(msg.clone()),
                },
            );
            return CheckUpdateResp {
                ok: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                reason: Some("failed".into()),
                error: Some(msg),
            };
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let new_ver = update.version.clone();
            let notes = update.body.clone();
            crate::core::logger::info("updater", format!("update available: v{new_ver}"));
            {
                let mut pending = PENDING_UPDATE.lock().await;
                *pending = Some(update);
            }
            set_status(
                &app,
                UpdateStatus {
                    phase: "available".into(),
                    percent: 0,
                    version: Some(new_ver.clone()),
                    notes: notes.clone(),
                    message: Some(format!("发现新版本 v{new_ver}")),
                },
            );
            CheckUpdateResp {
                ok: true,
                available: true,
                current_version,
                version: Some(new_ver),
                notes,
                reason: None,
                error: None,
            }
        }
        Ok(None) => {
            crate::core::logger::info("updater", "already up to date");
            {
                let mut pending = PENDING_UPDATE.lock().await;
                *pending = None;
            }
            set_status(
                &app,
                UpdateStatus {
                    phase: "idle".into(),
                    percent: 0,
                    version: None,
                    notes: None,
                    message: None,
                },
            );
            CheckUpdateResp {
                ok: true,
                available: false,
                current_version,
                version: None,
                notes: None,
                reason: Some("latest".into()),
                error: None,
            }
        }
        Err(e) => {
            let msg = format!("检查更新失败：{e}");
            crate::core::logger::warn("updater", &msg);
            set_status(
                &app,
                UpdateStatus {
                    phase: "error".into(),
                    percent: 0,
                    version: None,
                    notes: None,
                    message: Some(msg.clone()),
                },
            );
            CheckUpdateResp {
                ok: false,
                available: false,
                current_version,
                version: None,
                notes: None,
                reason: Some("failed".into()),
                error: Some(msg),
            }
        }
    }
}

#[tauri::command]
pub async fn install_pending_update(app: AppHandle) -> Result<(), String> {
    let update = {
        let mut pending = PENDING_UPDATE.lock().await;
        pending.take()
    };
    let update = match update {
        Some(u) => u,
        None => {
            // 若未缓存，尝试重新探测一次
            let updater = app
                .updater()
                .map_err(|e| format!("初始化自动更新模块失败：{e}"))?;
            updater
                .check()
                .await
                .map_err(|e| format!("重新获取更新信息失败：{e}"))?
                .ok_or_else(|| "当前已是最新版本，无需更新".to_string())?
        }
    };

    let target_ver = update.version.clone();
    let notes = update.body.clone();
    crate::core::logger::info("updater", format!("downloading update v{target_ver}"));
    set_status(
        &app,
        UpdateStatus {
            phase: "downloading".into(),
            percent: 0,
            version: Some(target_ver.clone()),
            notes: notes.clone(),
            message: Some(format!("正在下载 v{target_ver} 更新包…")),
        },
    );

    let app_for_progress = app.clone();
    let app_for_finish = app.clone();
    let ver_for_progress = target_ver.clone();
    let ver_for_finish = target_ver.clone();
    let notes_for_progress = notes.clone();
    let notes_for_finish = notes.clone();

    let mut downloaded: u64 = 0;
    let mut last_pct: u32 = 0;

    let res = update
        .download_and_install(
            move |chunk_len, content_len| {
                downloaded = downloaded.saturating_add(chunk_len as u64);
                let pct = match content_len {
                    Some(total) if total > 0 => {
                        ((downloaded as f64 / total as f64) * 100.0).round() as u32
                    }
                    _ => (last_pct + 2).min(95),
                }
                .min(99);
                if pct != last_pct {
                    last_pct = pct;
                    let mb_done = downloaded as f64 / 1024.0 / 1024.0;
                    let msg = match content_len {
                        Some(total) if total > 0 => format!(
                            "正在下载 v{ver_for_progress}（{:.1} MB / {:.1} MB）…",
                            mb_done,
                            total as f64 / 1024.0 / 1024.0
                        ),
                        _ => format!("正在下载 v{ver_for_progress}（已下载 {:.1} MB）…", mb_done),
                    };
                    set_status(
                        &app_for_progress,
                        UpdateStatus {
                            phase: "downloading".into(),
                            percent: pct,
                            version: Some(ver_for_progress.clone()),
                            notes: notes_for_progress.clone(),
                            message: Some(msg),
                        },
                    );
                }
            },
            move || {
                crate::core::logger::info("updater", format!("update v{ver_for_finish} downloaded & verified, installing"));
                set_status(
                    &app_for_finish,
                    UpdateStatus {
                        phase: "installing".into(),
                        percent: 100,
                        version: Some(ver_for_finish.clone()),
                        notes: notes_for_finish.clone(),
                        message: Some(format!("v{ver_for_finish} 签名校验通过，正在安装并重启…")),
                    },
                );
            },
        )
        .await;

    if let Err(e) = res {
        let msg = format!("下载或安装更新失败：{e}");
        crate::core::logger::error("updater", &msg);
        set_status(
            &app,
            UpdateStatus {
                phase: "error".into(),
                percent: 0,
                version: Some(target_ver),
                notes,
                message: Some(msg.clone()),
            },
        );
        return Err(msg);
    }

    // 安装成功后优雅回收后台浏览器并重启进入新版本
    crate::cdp::manager::shutdown_all_sync();
    app.restart();
}
