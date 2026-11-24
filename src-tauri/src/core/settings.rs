use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use once_cell::sync::Lazy;
use rand::RngCore;
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::core::ai_proxy;
use crate::core::caps::{
    builtin_provider_map, builtin_providers, validate_base_url, validate_key_format, CapId,
    ProviderModel, ProviderProtocol, ProviderRecord,
};
use crate::core::paths::resolve_app_data_dir;

const KEYRING_SERVICE: &str = "com.gztelecom.newmedia.workbench.rs";
pub const CODEX_CLI_PROVIDER_ID: &str = "codex-cli";
pub const CODEX_CLI_MODEL_ID: &str = "codex-cli-image";

fn codex_cli_provider_record() -> ProviderRecord {
    ProviderRecord {
        id: CODEX_CLI_PROVIDER_ID.to_string(),
        label: "Codex CLI".to_string(),
        portal: None,
        key_id: CODEX_CLI_PROVIDER_ID.to_string(),
        base_url: "local://codex-cli".to_string(),
        protocol: ProviderProtocol::OpenaiChatCompletions,
        models: vec![ProviderModel {
            id: CODEX_CLI_MODEL_ID.to_string(),
            label: Some("本机订阅（免 API Key）".to_string()),
            capabilities: vec![CapId::Image],
        }],
        builtin: true,
        revision: 1,
        scope_cap: Some(CapId::Image),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapConfigEntry {
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationStamp {
    pub provider_id: String,
    pub model: String,
    pub provider_revision: u32,
    pub key_version: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSettings {
    #[serde(default)]
    pub keys: HashMap<String, String>, // keyId -> "keyring" 或 "aes:<base64>"
    #[serde(default)]
    pub suppliers: HashMap<CapId, String>, // cap -> active model
    #[serde(default)]
    pub providers: HashMap<CapId, String>, // cap -> active providerId
    #[serde(default)]
    pub provider_catalog: HashMap<String, ProviderRecord>,
    #[serde(default)]
    pub capability_configs: HashMap<CapId, Vec<CapConfigEntry>>,
    #[serde(default)]
    pub removed_capability_configs: HashMap<CapId, Vec<CapConfigEntry>>,
    #[serde(default)]
    pub key_versions: HashMap<String, u32>,
    #[serde(default)]
    pub verified: HashMap<CapId, VerificationStamp>,
    #[serde(default)]
    pub verified_configs: HashMap<String, VerificationStamp>,
    #[serde(default)]
    pub root_dir: Option<String>,
    #[serde(default)]
    pub xhs_download_dir: Option<String>,
    #[serde(default)]
    pub codex_cli_removed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSummary {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal: Option<String>,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub models: Vec<ProviderModel>,
    pub builtin: bool,
    pub key_configured: bool,
    pub configured: bool,
    pub revision: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_cap: Option<CapId>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityModelConfigSummary {
    pub provider_id: String,
    pub provider_label: String,
    pub model: String,
    pub model_label: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub builtin: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_cap: Option<CapId>,
    pub configured: bool,
    pub active: bool,
    pub verified: bool,
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapSummary {
    pub cap: CapId,
    pub label: String,
    pub locked: bool,
    pub model: String,
    pub alternatives: Vec<String>,
    pub models: Vec<String>,
    pub model_labels: HashMap<String, String>,
    pub provider: String,
    pub provider_label: String,
    pub provider_portal: Option<String>,
    pub configured: bool,
    pub verified: bool,
    pub configurations: Vec<CapabilityModelConfigSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSummary {
    pub root_dir: Option<String>,
    pub xhs_download_dir: Option<String>,
    pub suppliers: HashMap<String, String>,
    pub caps: Vec<CapSummary>,
    pub providers: Vec<ProviderSummary>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraft {
    pub id: Option<String>,
    pub mode: Option<String>,
    pub cap: Option<CapId>,
    pub source_provider_id: Option<String>,
    pub source_model: Option<String>,
    pub label: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub api_key: Option<String>,
    pub models: Vec<ProviderModel>,
}

#[derive(Debug, Clone)]
pub struct ProviderRequestSnapshot {
    pub cap: CapId,
    pub provider: ProviderRecord,
    pub model: String,
    pub key_id: String,
    pub key_version: u32,
    pub api_key: String,
}

static SETTINGS_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
static SECRET_CACHE: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn cache_key_id(key_id: &str) -> String {
    let scope = std::env::var("NEWMEDIA_RS_DATA_DIR").unwrap_or_default();
    format!("{scope}::{key_id}")
}

fn settings_file_path() -> Result<PathBuf, String> {
    Ok(resolve_app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

fn use_local_aes_storage() -> bool {
    // 1. 自动化测试或显式指定隔离目录时，只使用目录级 AES，不污染本机钥匙串。
    if std::env::var("NEWMEDIA_RS_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return true;
    }
    // 2. macOS 未经 Apple 付费公证的 ad-hoc 签名应用在每次更新/热更新后都会改变二进制哈希，
    //    导致 macOS Keychain ACL 反复弹窗索要密码；因此在 macOS 上统一改用 0600 本地派生 AES-256-GCM 存储，
    //    彻底告别更新后反复弹钥匙串密码，同时保持密文落盘且不进前端与日志。
    cfg!(target_os = "macos")
}

#[cfg(unix)]
fn set_owner_only_perms(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn set_owner_only_perms(_path: &Path) {}

fn read_or_create_salt(dir: &Path) -> Result<Vec<u8>, String> {
    let salt_path = dir.join(".salt");
    if salt_path.is_file() {
        set_owner_only_perms(&salt_path);
        fs::read(&salt_path).map_err(|e| format!("读取加密盐失败：{e}"))
    } else {
        let mut s = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut s);
        fs::write(&salt_path, s).map_err(|e| format!("写入加密盐失败：{e}"))?;
        set_owner_only_perms(&salt_path);
        Ok(s.to_vec())
    }
}

/// 稳定版密钥派生（不依赖会随终端/Finder 启动环境波动的 HOSTNAME）
fn derive_aes_key_v2(dir: &Path) -> Result<[u8; 32], String> {
    let salt = read_or_create_salt(dir)?;
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".into());
    let home = dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let fingerprint = format!("{user}|{home}|newmedia-workbench-rs-v2");

    let params = ScryptParams::new(14, 8, 1, 32).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    scrypt(fingerprint.as_bytes(), &salt, &params, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

/// 兼容旧版 aes: 密文的密钥派生
fn derive_aes_key_legacy(dir: &Path) -> Result<[u8; 32], String> {
    let salt = read_or_create_salt(dir)?;
    let host = std::env::var("HOSTNAME")
        .or_else(|_| std::env::var("COMPUTERNAME"))
        .unwrap_or_else(|_| "localhost".into());
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".into());
    let fingerprint = format!("{host}|{user}|newmedia-workbench-rs");

    let params = ScryptParams::new(14, 8, 1, 32).map_err(|e| e.to_string())?;
    let mut out = [0u8; 32];
    scrypt(fingerprint.as_bytes(), &salt, &params, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn encrypt_aes(dir: &Path, plain: &str) -> Result<String, String> {
    let key = derive_aes_key_v2(dir)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?;
    let mut nonce_bytes = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_bytes())
        .map_err(|e| format!("AES 加密失败：{e}"))?;
    let mut combined = Vec::with_capacity(12 + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);
    Ok(format!("aes2:{}", B64.encode(combined)))
}

fn decrypt_aes_with_key(key: &[u8; 32], b64: &str) -> Option<String> {
    let raw = B64.decode(b64).ok()?;
    if raw.len() <= 12 {
        return None;
    }
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let nonce = Nonce::from_slice(&raw[..12]);
    let plain = cipher.decrypt(nonce, &raw[12..]).ok()?;
    String::from_utf8(plain).ok()
}

fn decrypt_aes(dir: &Path, stored: &str) -> Option<String> {
    if let Some(b64) = stored.strip_prefix("aes2:") {
        let key = derive_aes_key_v2(dir).ok()?;
        return decrypt_aes_with_key(&key, b64);
    }
    if let Some(b64) = stored.strip_prefix("aes:") {
        let key = derive_aes_key_legacy(dir).ok()?;
        return decrypt_aes_with_key(&key, b64);
    }
    None
}

pub fn store_secret_key(key_id: &str, plain: &str) -> Result<String, String> {
    let dir = resolve_app_data_dir().map_err(|e| e.to_string())?;
    let marker = if !use_local_aes_storage() {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key_id) {
            if entry.set_password(plain).is_ok() {
                "keyring".to_string()
            } else {
                encrypt_aes(&dir, plain)?
            }
        } else {
            encrypt_aes(&dir, plain)?
        }
    } else {
        // 若此前该 key 曾存在 macOS 钥匙串，顺手删除旧项避免残留
        if cfg!(target_os = "macos") {
            if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key_id) {
                let _ = entry.delete_credential();
            }
        }
        encrypt_aes(&dir, plain)?
    };
    if let Ok(mut cache) = SECRET_CACHE.lock() {
        cache.insert(cache_key_id(key_id), plain.to_string());
    }
    Ok(marker)
}

pub fn load_secret_key(key_id: &str, marker: &str) -> Option<String> {
    let ck = cache_key_id(key_id);
    if let Ok(cache) = SECRET_CACHE.lock() {
        if let Some(val) = cache.get(&ck) {
            if !val.trim().is_empty() {
                return Some(val.clone());
            }
        }
    }

    let dir = resolve_app_data_dir().ok()?;
    let loaded = if marker == "keyring" {
        keyring::Entry::new(KEYRING_SERVICE, key_id)
            .ok()
            .and_then(|entry| entry.get_password().ok())
            .filter(|pwd| !pwd.trim().is_empty())
    } else {
        decrypt_aes(&dir, marker)
    };

    if let Some(ref val) = loaded {
        if let Ok(mut cache) = SECRET_CACHE.lock() {
            cache.insert(ck, val.clone());
        }
    }
    loaded
}

/// 在 macOS 上将历史存在钥匙串（marker == "keyring"）的密钥一次性静默迁移到本地 0600 AES-256-GCM 密文存储，
/// 彻底消除此后任意版本更新/热更新触发钥匙串密码弹窗的问题。
fn migrate_keyring_entries_if_needed(stored: &mut StoredSettings) {
    if !use_local_aes_storage() {
        return;
    }
    let keyring_ids: Vec<String> = stored
        .keys
        .iter()
        .filter(|(_, marker)| marker.as_str() == "keyring")
        .map(|(k, _)| k.clone())
        .collect();
    if keyring_ids.is_empty() {
        return;
    }
    let Ok(dir) = resolve_app_data_dir() else {
        return;
    };
    let mut changed = false;
    for key_id in keyring_ids {
        if let Some(plain) = load_secret_key(&key_id, "keyring") {
            if let Ok(new_marker) = encrypt_aes(&dir, &plain) {
                stored.keys.insert(key_id.clone(), new_marker);
                if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &key_id) {
                    let _ = entry.delete_credential();
                }
                changed = true;
                crate::core::logger::info("settings", format!("migrated key '{key_id}' from macOS Keychain to local AES-256-GCM"));
            }
        }
    }
    if changed {
        let _ = save_stored(stored);
    }
}

pub fn delete_secret_key(key_id: &str, marker: Option<&str>) {
    if let Ok(mut cache) = SECRET_CACHE.lock() {
        cache.remove(&cache_key_id(key_id));
    }
    if marker == Some("keyring") {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key_id) {
            let _ = entry.delete_credential();
        }
    }
}

pub fn load_stored() -> Result<StoredSettings, String> {
    let path = settings_file_path()?;
    if !path.is_file() {
        return Ok(StoredSettings::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| format!("读取设置文件失败：{e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("设置文件 JSON 格式异常：{e}"))
}

pub fn save_stored(stored: &StoredSettings) -> Result<(), String> {
    let path = settings_file_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(stored).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| format!("写入设置文件失败：{e}"))?;
    set_owner_only_perms(&path);
    Ok(())
}

fn all_providers(stored: &StoredSettings) -> Vec<ProviderRecord> {
    let mut map = builtin_provider_map();
    for (id, rec) in &stored.provider_catalog {
        map.insert(id.clone(), rec.clone());
    }
    let mut list: Vec<ProviderRecord> = Vec::new();
    // 仅当本机检测到已登录的 Codex CLI 且未被用户移除时，在图片生成中提供 Codex CLI 选项
    if ai_proxy::is_codex_cli_available_sync() && !stored.codex_cli_removed {
        list.push(codex_cli_provider_record());
    }
    // 保持内置顺序在前，自定义按 id 稳定排序在后
    list.extend(
        builtin_providers()
            .into_iter()
            .filter_map(|p| map.remove(&p.id)),
    );
    let mut custom: Vec<ProviderRecord> = map.into_values().collect();
    custom.sort_by(|a, b| a.id.cmp(&b.id));
    list.extend(custom);
    list
}

pub fn provider_by_id(stored: &StoredSettings, id: &str) -> Option<ProviderRecord> {
    if id == CODEX_CLI_PROVIDER_ID {
        if ai_proxy::is_codex_cli_available_sync() {
            return Some(codex_cli_provider_record());
        }
        return None;
    }
    if let Some(rec) = stored.provider_catalog.get(id) {
        return Some(rec.clone());
    }
    builtin_provider_map().remove(id)
}

pub fn is_active_image_codex_cli() -> bool {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let Ok(stored) = load_stored() else {
        return false;
    };
    stored.providers.get(&CapId::Image).map(String::as_str) == Some(CODEX_CLI_PROVIDER_ID)
        && !stored.codex_cli_removed
        && ai_proxy::is_codex_cli_available_sync()
}

pub fn get_key_plaintext(stored: &StoredSettings, key_id: &str) -> Option<String> {
    let marker = stored.keys.get(key_id)?;
    load_secret_key(key_id, marker)
}

fn is_key_configured(stored: &StoredSettings, key_id: &str) -> bool {
    stored
        .keys
        .get(key_id)
        .and_then(|m| load_secret_key(key_id, m))
        .is_some()
}

fn active_pair(stored: &StoredSettings, cap: CapId) -> (String, String) {
    let mut provider_id = stored
        .providers
        .get(&cap)
        .cloned()
        .unwrap_or_else(|| cap.default_provider_id().to_string());
    let mut model = stored
        .suppliers
        .get(&cap)
        .cloned()
        .unwrap_or_else(|| cap.default_model().to_string());

    // 若之前选了 Codex CLI 但当前机器未检测到或已被移除，自动回退到默认供应商
    if cap == CapId::Image
        && provider_id == CODEX_CLI_PROVIDER_ID
        && (stored.codex_cli_removed || !ai_proxy::is_codex_cli_available_sync())
    {
        provider_id = cap.default_provider_id().to_string();
        model = cap.default_model().to_string();
    }
    (provider_id, model)
}

fn cap_configs_for(
    stored: &StoredSettings,
    providers: &[ProviderRecord],
    cap: CapId,
) -> Vec<CapConfigEntry> {
    let mut entries: Vec<CapConfigEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let (active_p, active_m) = active_pair(stored, cap);

    let is_removed = |pid: &str, mid: &str| -> bool {
        if pid == active_p && mid == active_m {
            return false;
        }
        stored
            .removed_capability_configs
            .get(&cap)
            .map(|list| list.iter().any(|e| e.provider_id == pid && e.model == mid))
            .unwrap_or(false)
    };

    let mut push_unique = |provider_id: String, model: String| {
        if is_removed(&provider_id, &model) {
            return;
        }
        let key = format!("{provider_id}::{model}");
        if seen.insert(key) {
            entries.push(CapConfigEntry { provider_id, model });
        }
    };

    // 先放显式保存的能力配置
    if let Some(saved) = stored.capability_configs.get(&cap) {
        for item in saved {
            if providers.iter().any(|p| p.id == item.provider_id) {
                push_unique(item.provider_id.clone(), item.model.clone());
            }
        }
    }

    // 补充所有内置与自定义中声明支持该能力的模型
    for p in providers {
        if let Some(scope) = p.scope_cap {
            if scope != cap {
                continue;
            }
        }
        if !p.protocol.supports_cap(cap) {
            continue;
        }
        for m in &p.models {
            if m.capabilities.contains(&cap) {
                push_unique(p.id.clone(), m.id.clone());
            }
        }
    }

    if providers.iter().any(|p| p.id == active_p) {
        push_unique(active_p.clone(), active_m.clone());
    }

    entries
}

pub fn build_summary(stored: &StoredSettings) -> SettingsSummary {
    let providers = all_providers(stored);
    let provider_map: HashMap<String, &ProviderRecord> =
        providers.iter().map(|p| (p.id.clone(), p)).collect();

    let provider_summaries: Vec<ProviderSummary> = providers
        .iter()
        .map(|p| {
            let key_ok = if p.id == CODEX_CLI_PROVIDER_ID {
                true
            } else {
                is_key_configured(stored, &p.key_id)
            };
            ProviderSummary {
                id: p.id.clone(),
                label: p.label.clone(),
                portal: p.portal.clone(),
                base_url: p.base_url.clone(),
                protocol: p.protocol,
                models: p.models.clone(),
                builtin: p.builtin,
                key_configured: key_ok,
                configured: key_ok,
                revision: p.revision,
                scope_cap: p.scope_cap,
            }
        })
        .collect();

    let mut suppliers_out = HashMap::new();
    let mut caps_out = Vec::new();

    for cap in CapId::ALL {
        let (active_pid, active_model) = active_pair(stored, cap);
        suppliers_out.insert(cap.as_str().to_string(), active_model.clone());

        let active_provider = provider_map
            .get(&active_pid)
            .copied()
            .or_else(|| provider_map.get(cap.default_provider_id()).copied());

        let entries = cap_configs_for(stored, &providers, cap);
        let stamp = stored.verified.get(&cap);

        let mut configurations = Vec::new();
        for entry in entries {
            let Some(p) = provider_map.get(&entry.provider_id) else {
                continue;
            };
            let is_codex = p.id == CODEX_CLI_PROVIDER_ID;
            let configured = if is_codex {
                true
            } else {
                is_key_configured(stored, &p.key_id)
            };
            let active = entry.provider_id == active_pid && entry.model == active_model;
            let key_ver = *stored.key_versions.get(&p.key_id).unwrap_or(&0);
            let cfg_key = verified_config_key(cap, &p.id, &entry.model);
            let stamp_matches = |s: &VerificationStamp| {
                s.provider_id == p.id
                    && s.model == entry.model
                    && s.provider_revision == p.revision
                    && s.key_version == key_ver
            };
            let verified = if is_codex {
                true
            } else {
                stored
                    .verified_configs
                    .get(&cfg_key)
                    .map(stamp_matches)
                    .unwrap_or(false)
                    || stamp.map(stamp_matches).unwrap_or(false)
            };
            let model_label = p
                .models
                .iter()
                .find(|m| m.id == entry.model)
                .and_then(|m| m.label.clone())
                .unwrap_or_else(|| entry.model.clone());

            configurations.push(CapabilityModelConfigSummary {
                provider_id: p.id.clone(),
                provider_label: p.label.clone(),
                model: entry.model.clone(),
                model_label,
                base_url: p.base_url.clone(),
                protocol: p.protocol,
                builtin: p.builtin,
                scope_cap: p.scope_cap,
                configured,
                active,
                verified,
                editable: !is_codex,
            });
        }

        let (models, model_labels, provider_label, provider_portal, configured) =
            if let Some(ap) = active_provider {
                let mut m_list = Vec::new();
                let mut labels = HashMap::new();
                for m in &ap.models {
                    if m.capabilities.contains(&cap) {
                        m_list.push(m.id.clone());
                        if let Some(l) = &m.label {
                            labels.insert(m.id.clone(), l.clone());
                        }
                    }
                }
                if !m_list.contains(&active_model) {
                    m_list.insert(0, active_model.clone());
                }
                let ap_configured = if ap.id == CODEX_CLI_PROVIDER_ID {
                    true
                } else {
                    is_key_configured(stored, &ap.key_id)
                };
                (
                    m_list,
                    labels,
                    ap.label.clone(),
                    ap.portal.clone(),
                    ap_configured,
                )
            } else {
                (
                    vec![active_model.clone()],
                    HashMap::new(),
                    active_pid.clone(),
                    None,
                    false,
                )
            };

        let verified = configurations.iter().any(|c| c.active && c.verified);
        let alternatives = models
            .iter()
            .filter(|m| **m != active_model)
            .cloned()
            .collect();

        caps_out.push(CapSummary {
            cap,
            label: cap.label().to_string(),
            locked: false,
            model: active_model,
            alternatives,
            models,
            model_labels,
            provider: active_pid,
            provider_label,
            provider_portal,
            configured,
            verified,
            configurations,
        });
    }

    SettingsSummary {
        root_dir: stored.root_dir.clone(),
        xhs_download_dir: stored.xhs_download_dir.clone(),
        suppliers: suppliers_out,
        caps: caps_out,
        providers: provider_summaries,
    }
}

pub fn get_summary() -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    migrate_keyring_entries_if_needed(&mut stored);
    Ok(build_summary(&stored))
}

pub fn verified_config_key(cap: CapId, provider_id: &str, model: &str) -> String {
    format!("{}::{}::{}", cap.as_str(), provider_id, model)
}

pub fn resolve_request(cap: CapId, model_override: Option<&str>) -> Result<ProviderRequestSnapshot, String> {
    resolve_request_for(cap, None, model_override)
}

pub fn resolve_request_for(
    cap: CapId,
    provider_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<ProviderRequestSnapshot, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let stored = load_stored()?;
    let (active_pid, active_model) = active_pair(&stored, cap);
    let provider_id = provider_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or(active_pid);
    let provider = provider_by_id(&stored, &provider_id)
        .ok_or_else(|| format!("未找到能力「{}」对应的供应商配置", cap.label()))?;
    if !provider.protocol.supports_cap(cap) {
        return Err(format!("当前协议不支持「{}」能力", cap.label()));
    }
    let api_key = get_key_plaintext(&stored, &provider.key_id)
        .ok_or_else(|| format!("请先在设置页为「{}」配置 {} 的 API Key", cap.label(), provider.label))?;
    let model = model_override
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or(active_model);
    let key_id = provider.key_id.clone();
    let key_version = *stored.key_versions.get(&key_id).unwrap_or(&0);

    Ok(ProviderRequestSnapshot {
        cap,
        provider,
        model,
        key_id,
        key_version,
        api_key,
    })
}

pub fn set_capability(cap: CapId, provider_id: &str, model: &str) -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    if provider_id == CODEX_CLI_PROVIDER_ID {
        if cap != CapId::Image {
            return Err("Codex CLI 仅支持图片生成能力".into());
        }
        if !ai_proxy::is_codex_cli_available_sync() {
            return Err("未检测到已登录的本机 Codex CLI".into());
        }
        stored.codex_cli_removed = false;
    }
    let provider = provider_by_id(&stored, provider_id)
        .ok_or_else(|| format!("供应商不存在：{provider_id}"))?;
    if !provider.protocol.supports_cap(cap) {
        return Err(format!("所选协议不支持「{}」能力", cap.label()));
    }
    let model_trimmed = model.trim();
    if model_trimmed.is_empty() {
        return Err("模型 ID 不能为空".into());
    }
    stored.providers.insert(cap, provider.id.clone());
    stored.suppliers.insert(cap, model_trimmed.to_string());
    // 切换配置后，旧验证状态若不匹配自动失效（build_summary 也会按 stamp 比对）
    if let Some(stamp) = stored.verified.get(&cap) {
        if stamp.provider_id != provider.id || stamp.model != model_trimmed {
            stored.verified.remove(&cap);
        }
    }
    save_stored(&stored)?;
    Ok(build_summary(&stored))
}

pub fn set_provider_key(provider_id: &str, api_key: &str) -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    let provider = provider_by_id(&stored, provider_id)
        .ok_or_else(|| format!("供应商不存在：{provider_id}"))?;
    validate_key_format(&provider.key_id, api_key)?;
    let marker = store_secret_key(&provider.key_id, api_key.trim())?;
    stored.keys.insert(provider.key_id.clone(), marker);
    let next_ver = stored.key_versions.get(&provider.key_id).copied().unwrap_or(0) + 1;
    stored.key_versions.insert(provider.key_id.clone(), next_ver);
    // Key 变更后清理对应能力的验证状态
    for cap in CapId::ALL {
        let (pid, _) = active_pair(&stored, cap);
        if pid == provider.id {
            stored.verified.remove(&cap);
        }
    }
    save_stored(&stored)?;
    Ok(build_summary(&stored))
}

pub fn save_provider(draft: ProviderDraft) -> Result<(String, SettingsSummary), String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;

    let label = draft.label.trim().to_string();
    if label.is_empty() {
        return Err("请填写供应商显示名称".into());
    }
    let base_url = validate_base_url(&draft.base_url)?;
    if draft.models.is_empty() {
        return Err("请至少添加一个模型 ID".into());
    }

    let is_edit = draft.mode.as_deref() == Some("edit");
    let target_id = if is_edit {
        draft
            .id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .or_else(|| draft.source_provider_id.as_deref().filter(|s| !s.trim().is_empty()))
            .map(|s| s.trim().to_string())
    } else {
        draft
            .id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| s.trim().to_string())
    };
    let is_create = draft.mode.as_deref() == Some("create") || target_id.is_none();
    let id = if is_create {
        format!("custom-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        target_id.unwrap()
    };
    if id == CODEX_CLI_PROVIDER_ID {
        return Err("Codex CLI 为本机自动探测项，仅支持勾选或移除，不能编辑配置".into());
    }

    let existing = provider_by_id(&stored, &id);
    let builtin = existing.as_ref().map(|p| p.builtin).unwrap_or(false);
    let key_id = existing
        .as_ref()
        .map(|p| p.key_id.clone())
        .unwrap_or_else(|| id.clone());
    let revision = existing.as_ref().map(|p| p.revision + 1).unwrap_or(1);

    let scope_cap = if builtin {
        None
    } else {
        draft.cap.or_else(|| existing.as_ref().and_then(|p| p.scope_cap))
    };

    if let Some(cap) = scope_cap {
        if !draft.protocol.supports_cap(cap) {
            return Err(format!("所选协议不支持「{}」能力", cap.label()));
        }
    }

    let mut clean_models: Vec<ProviderModel> = Vec::new();
    for m in draft.models {
        let mid = m.id.trim().to_string();
        if mid.is_empty() {
            continue;
        }
        let mut caps = m.capabilities;
        if caps.is_empty() {
            if let Some(c) = scope_cap.or(draft.cap) {
                caps.push(c);
            }
        }
        clean_models.push(ProviderModel {
            id: mid,
            label: m.label.filter(|l| !l.trim().is_empty()),
            capabilities: caps,
        });
    }
    if clean_models.is_empty() {
        return Err("模型 ID 列表不能为空".into());
    }

    // 原地编辑已有供应商（特别是内置供应商如 SudoCode / 智谱 / DeepSeek）时，保留该供应商原有的其他模型，仅更新当前编辑项
    let final_models: Vec<ProviderModel> = if let Some(prev) = existing.as_ref().filter(|p| p.builtin) {
        let mut merged = prev.models.clone();
        if let (Some(src_model), Some(edited_first)) = (
            draft.source_model.as_deref().filter(|s| !s.trim().is_empty()),
            clean_models.first(),
        ) {
            if src_model != edited_first.id {
                if let Some(cap) = draft.cap {
                    if let Some(pos) = merged.iter().position(|m| m.id == src_model) {
                        merged[pos].capabilities.retain(|c| *c != cap);
                        if merged[pos].capabilities.is_empty() {
                            merged.remove(pos);
                        }
                    }
                }
            }
        }
        for cm in &clean_models {
            if let Some(hit) = merged.iter_mut().find(|m| m.id == cm.id) {
                for c in &cm.capabilities {
                    if !hit.capabilities.contains(c) {
                        hit.capabilities.push(*c);
                    }
                }
                if cm.label.is_some() {
                    hit.label = cm.label.clone();
                }
            } else {
                merged.push(cm.clone());
            }
        }
        merged
    } else {
        clean_models.clone()
    };

    if let Some(key) = draft.api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        validate_key_format(&key_id, key)?;
        let marker = store_secret_key(&key_id, key)?;
        stored.keys.insert(key_id.clone(), marker);
        let next_ver = stored.key_versions.get(&key_id).copied().unwrap_or(0) + 1;
        stored.key_versions.insert(key_id.clone(), next_ver);
    }

    let record = ProviderRecord {
        id: id.clone(),
        label,
        portal: existing.and_then(|p| p.portal),
        key_id: key_id.clone(),
        base_url,
        protocol: draft.protocol,
        models: final_models,
        builtin,
        revision,
        scope_cap,
    };

    stored.provider_catalog.insert(id.clone(), record);

    // 新增配置按需求不自动启用，仅添加到对应能力的可选列表；若此前曾移除过同项，自动解除黑名单
    if let Some(cap) = draft.cap {
        if let Some(removed) = stored.removed_capability_configs.get_mut(&cap) {
            for m in &clean_models {
                removed.retain(|e| !(e.provider_id == id && e.model == m.id));
            }
        }
        let list = stored.capability_configs.entry(cap).or_default();
        // 原地编辑改了模型 ID 时，同步替换旧条目，避免列表出现重复
        if is_edit {
            if let Some(src_model) = draft.source_model.as_deref().filter(|s| !s.trim().is_empty()) {
                if !clean_models.iter().any(|m| m.id == src_model) {
                    list.retain(|e| !(e.provider_id == id && e.model == src_model));
                }
            }
        }
        for m in &clean_models {
            if !list.iter().any(|e| e.provider_id == id && e.model == m.id) {
                list.push(CapConfigEntry {
                    provider_id: id.clone(),
                    model: m.id.clone(),
                });
            }
        }
        let (active_p, _) = active_pair(&stored, cap);
        if active_p == id {
            stored.verified.remove(&cap);
        }
        stored
            .verified_configs
            .retain(|_, s| s.provider_id != id);
    }

    save_stored(&stored)?;
    Ok((id, build_summary(&stored)))
}

pub fn delete_capability_config(
    cap: CapId,
    provider_id: &str,
    model: &str,
) -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    let (active_p, active_m) = active_pair(&stored, cap);
    if active_p == provider_id && active_m == model {
        return Err("当前正在使用的模型配置不能直接删除，请先切换到其他配置".into());
    }

    if cap == CapId::Image && provider_id == CODEX_CLI_PROVIDER_ID {
        stored.codex_cli_removed = true;
        save_stored(&stored)?;
        return Ok(build_summary(&stored));
    }

    if let Some(list) = stored.capability_configs.get_mut(&cap) {
        list.retain(|e| !(e.provider_id == provider_id && e.model == model));
    }

    // 无论内置还是自定义配置，统一记录至该能力的移除黑名单，彻底避免内置模型复活
    let removed_list = stored.removed_capability_configs.entry(cap).or_default();
    if !removed_list
        .iter()
        .any(|e| e.provider_id == provider_id && e.model == model)
    {
        removed_list.push(CapConfigEntry {
            provider_id: provider_id.to_string(),
            model: model.to_string(),
        });
    }

    // 若属于自定义供应商，同步从其 models 移除；若该自定义供应商已无模型，则清理整个自定义供应商及密钥
    if let Some(rec) = stored.provider_catalog.get_mut(provider_id) {
        if !rec.builtin {
            rec.models.retain(|m| m.id != model);
            if rec.models.is_empty() {
                let key_id = rec.key_id.clone();
                stored.provider_catalog.remove(provider_id);
                let marker = stored.keys.remove(&key_id);
                delete_secret_key(&key_id, marker.as_deref());
            }
        }
    }

    save_stored(&stored)?;
    Ok(build_summary(&stored))
}

pub fn mark_verified(snapshot: &ProviderRequestSnapshot) -> Result<(), String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    let stamp = VerificationStamp {
        provider_id: snapshot.provider.id.clone(),
        model: snapshot.model.clone(),
        provider_revision: snapshot.provider.revision,
        key_version: snapshot.key_version,
    };
    let cfg_key = verified_config_key(snapshot.cap, &snapshot.provider.id, &snapshot.model);
    stored.verified_configs.insert(cfg_key, stamp.clone());
    let (active_p, active_m) = active_pair(&stored, snapshot.cap);
    if active_p == snapshot.provider.id && active_m == snapshot.model {
        stored.verified.insert(snapshot.cap, stamp);
    }
    save_stored(&stored)
}

pub fn set_root_dir(root_dir: Option<String>) -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    stored.root_dir = root_dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    save_stored(&stored)?;
    Ok(build_summary(&stored))
}

pub fn set_xhs_download_dir(dir: Option<String>) -> Result<SettingsSummary, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let mut stored = load_stored()?;
    stored.xhs_download_dir = dir.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    save_stored(&stored)?;
    Ok(build_summary(&stored))
}

pub fn current_root_dir() -> Option<String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    load_stored().ok().and_then(|s| s.root_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remove_builtin_model_persists_in_blacklist() {
        let mut stored = StoredSettings::default();
        // 切换 text 当前活动项为智谱，使得 deepseek-chat / deepseek-reasoner 可被移除
        stored.providers.insert(CapId::Text, "zhipu".into());
        stored.suppliers.insert(CapId::Text, "glm-5.3-flash".into());
        stored.removed_capability_configs.insert(
            CapId::Text,
            vec![
                CapConfigEntry {
                    provider_id: "deepseek".into(),
                    model: "deepseek-chat".into(),
                },
                CapConfigEntry {
                    provider_id: "deepseek".into(),
                    model: "deepseek-reasoner".into(),
                },
            ],
        );

        let summary = build_summary(&stored);
        let text_cap = summary.caps.iter().find(|c| c.cap == CapId::Text).unwrap();
        assert!(
            !text_cap
                .configurations
                .iter()
                .any(|c| c.provider_id == "deepseek"),
            "removed builtin deepseek models must not reappear"
        );
    }

    #[test]
    fn edit_builtin_provider_updates_in_place_without_duplicating() {
        let mut stored = StoredSettings::default();
        // 模拟编辑内置 SudoCode (sudocode / gpt-image-2) 保存配置
        let mut sudocode = builtin_providers()
            .into_iter()
            .find(|p| p.id == "sudocode")
            .unwrap();
        sudocode.revision += 1;
        stored.provider_catalog.insert("sudocode".into(), sudocode);
        stored.keys.insert("sudocode".into(), "aes:dummy".into());
        stored.key_versions.insert("sudocode".into(), 1);
        stored.capability_configs.insert(
            CapId::Image,
            vec![CapConfigEntry {
                provider_id: "sudocode".into(),
                model: "gpt-image-2".into(),
            }],
        );
        // 即使同时验证了非 active 项，验证状态也独立生效
        stored.verified_configs.insert(
            verified_config_key(CapId::Image, "sudocode", "gpt-image-2"),
            VerificationStamp {
                provider_id: "sudocode".into(),
                model: "gpt-image-2".into(),
                provider_revision: 2,
                key_version: 1,
            },
        );

        let summary = build_summary(&stored);
        let img_cap = summary.caps.iter().find(|c| c.cap == CapId::Image).unwrap();
        let sudocode_rows: Vec<_> = img_cap
            .configurations
            .iter()
            .filter(|c| c.provider_id == "sudocode" && c.model == "gpt-image-2")
            .collect();
        assert_eq!(sudocode_rows.len(), 1, "builtin sudocode must not duplicate");
        assert!(sudocode_rows[0].verified, "per-config verified stamp must take effect");
    }

    #[test]
    fn aes2_roundtrip_without_keychain() {
        let tmp = std::env::temp_dir().join(format!("newmedia-aes2-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let secret = "sk-test-1234567890abcdef";
        let enc = encrypt_aes(&tmp, secret).unwrap();
        assert!(enc.starts_with("aes2:"));
        assert_ne!(enc, secret);
        let dec = decrypt_aes(&tmp, &enc).unwrap();
        assert_eq!(dec, secret);
        let _ = fs::remove_dir_all(&tmp);
    }
}
