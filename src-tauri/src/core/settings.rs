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

use crate::core::caps::{
    builtin_provider_map, builtin_providers, validate_base_url, validate_key_format, CapId,
    ProviderModel, ProviderProtocol, ProviderRecord,
};
use crate::core::paths::resolve_app_data_dir;

const KEYRING_SERVICE: &str = "com.gztelecom.newmedia.workbench.rs";

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
    pub key_versions: HashMap<String, u32>,
    #[serde(default)]
    pub verified: HashMap<CapId, VerificationStamp>,
    #[serde(default)]
    pub root_dir: Option<String>,
    #[serde(default)]
    pub xhs_download_dir: Option<String>,
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

fn settings_file_path() -> Result<PathBuf, String> {
    Ok(resolve_app_data_dir()
        .map_err(|e| e.to_string())?
        .join("settings.json"))
}

fn use_isolated_aes_only() -> bool {
    // 自动化测试或显式指定隔离目录时，只使用目录级 AES，不污染本机钥匙串。
    std::env::var("NEWMEDIA_RS_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

fn derive_aes_key(dir: &Path) -> Result<[u8; 32], String> {
    let salt_path = dir.join(".salt");
    let salt = if salt_path.is_file() {
        fs::read(&salt_path).map_err(|e| format!("读取加密盐失败：{e}"))?
    } else {
        let mut s = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut s);
        fs::write(&salt_path, s).map_err(|e| format!("写入加密盐失败：{e}"))?;
        s.to_vec()
    };

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
    let key = derive_aes_key(dir)?;
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
    Ok(format!("aes:{}", B64.encode(combined)))
}

fn decrypt_aes(dir: &Path, stored: &str) -> Option<String> {
    let b64 = stored.strip_prefix("aes:")?;
    let raw = B64.decode(b64).ok()?;
    if raw.len() <= 12 {
        return None;
    }
    let key = derive_aes_key(dir).ok()?;
    let cipher = Aes256Gcm::new_from_slice(&key).ok()?;
    let nonce = Nonce::from_slice(&raw[..12]);
    let plain = cipher.decrypt(nonce, &raw[12..]).ok()?;
    String::from_utf8(plain).ok()
}

pub fn store_secret_key(key_id: &str, plain: &str) -> Result<String, String> {
    let dir = resolve_app_data_dir().map_err(|e| e.to_string())?;
    if !use_isolated_aes_only() {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key_id) {
            if entry.set_password(plain).is_ok() {
                return Ok("keyring".to_string());
            }
        }
    }
    encrypt_aes(&dir, plain)
}

pub fn load_secret_key(key_id: &str, marker: &str) -> Option<String> {
    let dir = resolve_app_data_dir().ok()?;
    if marker == "keyring" {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, key_id) {
            if let Ok(pwd) = entry.get_password() {
                if !pwd.trim().is_empty() {
                    return Some(pwd);
                }
            }
        }
        return None;
    }
    decrypt_aes(&dir, marker)
}

pub fn delete_secret_key(key_id: &str, marker: Option<&str>) {
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
    fs::write(&path, text).map_err(|e| format!("写入设置文件失败：{e}"))
}

fn all_providers(stored: &StoredSettings) -> Vec<ProviderRecord> {
    let mut map = builtin_provider_map();
    for (id, rec) in &stored.provider_catalog {
        map.insert(id.clone(), rec.clone());
    }
    // 保持内置顺序在前，自定义按 id 稳定排序在后
    let mut list: Vec<ProviderRecord> = builtin_providers()
        .into_iter()
        .filter_map(|p| map.remove(&p.id))
        .collect();
    let mut custom: Vec<ProviderRecord> = map.into_values().collect();
    custom.sort_by(|a, b| a.id.cmp(&b.id));
    list.extend(custom);
    list
}

pub fn provider_by_id(stored: &StoredSettings, id: &str) -> Option<ProviderRecord> {
    if let Some(rec) = stored.provider_catalog.get(id) {
        return Some(rec.clone());
    }
    builtin_provider_map().remove(id)
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
    let provider_id = stored
        .providers
        .get(&cap)
        .cloned()
        .unwrap_or_else(|| cap.default_provider_id().to_string());
    let model = stored
        .suppliers
        .get(&cap)
        .cloned()
        .unwrap_or_else(|| cap.default_model().to_string());
    (provider_id, model)
}

fn cap_configs_for(
    stored: &StoredSettings,
    providers: &[ProviderRecord],
    cap: CapId,
) -> Vec<CapConfigEntry> {
    let mut entries: Vec<CapConfigEntry> = Vec::new();
    let mut seen = std::collections::HashSet::new();

    let mut push_unique = |provider_id: String, model: String| {
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

    let (active_p, active_m) = active_pair(stored, cap);
    if providers.iter().any(|p| p.id == active_p) {
        push_unique(active_p, active_m);
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
            let key_ok = is_key_configured(stored, &p.key_id);
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
            let configured = is_key_configured(stored, &p.key_id);
            let active = entry.provider_id == active_pid && entry.model == active_model;
            let key_ver = *stored.key_versions.get(&p.key_id).unwrap_or(&0);
            let verified = active
                && stamp
                    .map(|s| {
                        s.provider_id == p.id
                            && s.model == entry.model
                            && s.provider_revision == p.revision
                            && s.key_version == key_ver
                    })
                    .unwrap_or(false);
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
                (
                    m_list,
                    labels,
                    ap.label.clone(),
                    ap.portal.clone(),
                    is_key_configured(stored, &ap.key_id),
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
    let stored = load_stored()?;
    Ok(build_summary(&stored))
}

pub fn resolve_request(cap: CapId, model_override: Option<&str>) -> Result<ProviderRequestSnapshot, String> {
    let _g = SETTINGS_LOCK.lock().unwrap();
    let stored = load_stored()?;
    let (provider_id, active_model) = active_pair(&stored, cap);
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

    let is_create = draft.mode.as_deref() == Some("create") || draft.id.as_deref().unwrap_or("").is_empty();
    let id = if is_create {
        format!("custom-{}", &uuid::Uuid::new_v4().to_string()[..8])
    } else {
        draft.id.clone().unwrap()
    };

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
            if let Some(c) = scope_cap {
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
        models: clean_models.clone(),
        builtin,
        revision,
        scope_cap,
    };

    stored.provider_catalog.insert(id.clone(), record);

    // 新增配置按需求不自动启用，仅添加到对应能力的可选列表；编辑活动项时使验证失效
    if let Some(cap) = draft.cap {
        let list = stored.capability_configs.entry(cap).or_default();
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

    if let Some(list) = stored.capability_configs.get_mut(&cap) {
        list.retain(|e| !(e.provider_id == provider_id && e.model == model));
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
    stored.verified.insert(
        snapshot.cap,
        VerificationStamp {
            provider_id: snapshot.provider.id.clone(),
            model: snapshot.model.clone(),
            provider_revision: snapshot.provider.revision,
            key_version: snapshot.key_version,
        },
    );
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
