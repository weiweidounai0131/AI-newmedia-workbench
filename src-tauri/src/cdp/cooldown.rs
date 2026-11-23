use once_cell::sync::Lazy;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CooldownEntry {
    pub expires_at: u64,
    pub remaining_sec: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PlatformCooldownsResp {
    pub platforms: HashMap<String, CooldownEntry>,
}

struct StoredCooldown {
    expires_at_ms: u64,
    reason: String,
}

static COOLDOWNS: Lazy<Mutex<HashMap<String, StoredCooldown>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn key_of(scope: &str, platform: &str) -> String {
    format!("{scope}:{platform}")
}

pub fn check_and_acquire(scope: &str, platform: &str, normal_secs: u64) -> Result<(), String> {
    let mut map = COOLDOWNS.lock().unwrap();
    let k = key_of(scope, platform);
    let now = now_ms();
    if let Some(entry) = map.get(&k) {
        if entry.expires_at_ms > now {
            let rem = (entry.expires_at_ms - now).div_ceil(1000);
            return Err(format!(
                "「{platform}」冷却中（还剩 {rem} 秒），请稍后再试以避免触发平台风控"
            ));
        }
    }
    map.insert(
        k,
        StoredCooldown {
            expires_at_ms: now + normal_secs * 1000,
            reason: "normal".to_string(),
        },
    );
    Ok(())
}

pub fn mark_risk_control(scope: &str, platform: &str, penalty_secs: u64) {
    let mut map = COOLDOWNS.lock().unwrap();
    let k = key_of(scope, platform);
    map.insert(
        k,
        StoredCooldown {
            expires_at_ms: now_ms() + penalty_secs * 1000,
            reason: "risk_control".to_string(),
        },
    );
}

pub fn list_cooldowns(scope: &str) -> PlatformCooldownsResp {
    let map = COOLDOWNS.lock().unwrap();
    let now = now_ms();
    let prefix = format!("{scope}:");
    let mut platforms = HashMap::new();
    for (k, v) in map.iter() {
        if let Some(plat) = k.strip_prefix(&prefix) {
            if v.expires_at_ms > now {
                platforms.insert(
                    plat.to_string(),
                    CooldownEntry {
                        expires_at: v.expires_at_ms,
                        remaining_sec: (v.expires_at_ms - now).div_ceil(1000),
                        reason: Some(v.reason.clone()),
                    },
                );
            }
        }
    }
    PlatformCooldownsResp { platforms }
}
