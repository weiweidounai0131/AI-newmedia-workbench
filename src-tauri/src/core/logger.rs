use chrono::Local;
use once_cell::sync::Lazy;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::core::paths::resolve_app_data_dir;

const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024; // 单文件上限 5 MB，自动轮转
static LOG_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub fn log_file_path() -> Option<PathBuf> {
    let dir = resolve_app_data_dir().ok()?.join("logs");
    let _ = fs::create_dir_all(&dir);
    Some(dir.join("app.log"))
}

pub fn write_log(level: &str, module: &str, message: &str) {
    let _guard = LOG_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let Some(path) = log_file_path() else {
        return;
    };

    // 超过上限时滚动备份为 app.log.1（仅保留 1 份历史，防止磁盘膨胀）
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() >= MAX_LOG_BYTES {
            let backup = path.with_extension("log.1");
            let _ = fs::remove_file(&backup);
            let _ = fs::rename(&path, &backup);
        }
    }

    let ts = Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let sanitized = message.replace('\r', " ").replace('\n', " | ");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{ts}] [{level}] [{module}] {sanitized}");
    }
}

pub fn info(module: &str, msg: impl AsRef<str>) {
    write_log("INFO", module, msg.as_ref());
}

pub fn warn(module: &str, msg: impl AsRef<str>) {
    write_log("WARN", module, msg.as_ref());
}

pub fn error(module: &str, msg: impl AsRef<str>) {
    write_log("ERROR", module, msg.as_ref());
}

/// 安装全局 Panic Hook，将任何未预期崩溃完整写入本地开发日志，便于事后定位
pub fn install_panic_hook() {
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown".into());
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "non-string panic payload".to_string()
        };
        write_log("PANIC", "rust", &format!("at {loc}: {payload}"));
        prev(info);
    }));
}
