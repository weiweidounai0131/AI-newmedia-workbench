use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

/// 解析新版 Rust 工作台的独立数据目录（与旧版 Electron userData 彻底隔离）。
/// 支持通过环境变量 `NEWMEDIA_RS_DATA_DIR` 覆盖，便于开发与自动化测试隔离。
pub fn resolve_app_data_dir() -> std::io::Result<PathBuf> {
    let dir = if let Ok(custom) = std::env::var("NEWMEDIA_RS_DATA_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            PathBuf::from(trimmed)
        } else {
            default_app_data_dir()
        }
    } else {
        default_app_data_dir()
    };

    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn default_app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("newmedia-workbench-rs")
}

/// 定位旧版 Electron 工作台的数据根目录（仅用于只读探测与 Phase 2 迁移工具）。
pub fn legacy_electron_data_dir() -> Option<PathBuf> {
    if let Ok(custom) = std::env::var("NEWMEDIA_LEGACY_DATA_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.exists() {
                return Some(p);
            }
        }
    }

    let candidate = dirs::data_dir()?.join("newmedia-workbench");
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyInstallInfo {
    pub detected: bool,
    pub data_dir: Option<String>,
    pub has_settings: bool,
    pub runtime_bytes: u64,
}

/// 只读检测旧版 Electron 安装数据与可释放的 Python runtime 体积。
pub fn inspect_legacy_install() -> LegacyInstallInfo {
    let Some(root) = legacy_electron_data_dir() else {
        return LegacyInstallInfo {
            detected: false,
            data_dir: None,
            has_settings: false,
            runtime_bytes: 0,
        };
    };

    let has_settings = root.join("settings.json").is_file();
    let runtime_dir = root.join("runtime");
    let runtime_bytes = if runtime_dir.is_dir() {
        dir_size_fast(&runtime_dir)
    } else {
        0
    };

    LegacyInstallInfo {
        detected: has_settings || runtime_bytes > 0,
        data_dir: Some(root.to_string_lossy().to_string()),
        has_settings,
        runtime_bytes,
    }
}

fn dir_size_fast(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_symlink() {
                continue;
            }
            if meta.is_file() {
                total = total.saturating_add(meta.len());
            } else if meta.is_dir() {
                stack.push(entry.path());
            }
        }
    }
    total
}
