use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use pbkdf2::pbkdf2_hmac;
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use sha1::Sha1;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::core::caps::{CapId, ProviderRecord};
use crate::core::paths::{legacy_electron_data_dir, resolve_app_data_dir};
use crate::core::settings::{self, CapConfigEntry};

type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySettingsFile {
    #[serde(default)]
    keys: HashMap<String, String>,
    #[serde(default)]
    suppliers: HashMap<String, String>,
    #[serde(default)]
    providers: HashMap<String, String>,
    #[serde(default)]
    provider_catalog: HashMap<String, ProviderRecord>,
    #[serde(default)]
    capability_configs: HashMap<String, Vec<CapConfigEntry>>,
    #[serde(default)]
    root_dir: Option<String>,
    #[serde(default)]
    xhs_download_dir: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyMigrationPreview {
    pub detected: bool,
    pub legacy_dir: Option<String>,
    pub has_settings: bool,
    pub provider_count: usize,
    pub key_ids: Vec<String>,
    pub root_dir: Option<String>,
    pub xhs_download_dir: Option<String>,
    pub has_douyin_profile: bool,
    pub has_xhs_profile: bool,
    pub runtime_bytes: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOptions {
    pub custom_legacy_dir: Option<String>,
    #[serde(default = "default_true")]
    pub migrate_settings: bool,
    #[serde(default = "default_true")]
    pub migrate_keys: bool,
    #[serde(default)]
    pub copy_browser_profiles: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyMigrationFailure {
    pub key_id: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub ok: bool,
    pub legacy_dir: String,
    pub providers_migrated: usize,
    pub caps_migrated: usize,
    pub keys_migrated: Vec<String>,
    pub keys_failed: Vec<KeyMigrationFailure>,
    pub root_dir_migrated: bool,
    pub xhs_dir_migrated: bool,
    pub profiles_copied: Vec<String>,
    pub runtime_bytes_reclaimable: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupRuntimeResult {
    pub ok: bool,
    pub freed_bytes: u64,
    pub message: String,
}

fn resolve_legacy_root(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(dir) = custom.map(str::trim).filter(|s| !s.is_empty()) {
        let p = PathBuf::from(dir);
        if p.exists() {
            return Some(p);
        }
        return None;
    }
    legacy_electron_data_dir()
}

fn parse_cap_id(s: &str) -> Option<CapId> {
    match s {
        "text" => Some(CapId::Text),
        "visionImg" => Some(CapId::VisionImg),
        "visionVideo" => Some(CapId::VisionVideo),
        "image" => Some(CapId::Image),
        _ => None,
    }
}

fn dir_size(path: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else {
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

/// 预览旧版 Electron 数据（严格只读）
pub fn inspect_legacy(custom_dir: Option<&str>) -> LegacyMigrationPreview {
    let Some(root) = resolve_legacy_root(custom_dir) else {
        return LegacyMigrationPreview {
            detected: false,
            legacy_dir: None,
            has_settings: false,
            provider_count: 0,
            key_ids: vec![],
            root_dir: None,
            xhs_download_dir: None,
            has_douyin_profile: false,
            has_xhs_profile: false,
            runtime_bytes: 0,
        };
    };

    let settings_path = root.join("settings.json");
    let parsed: Option<LegacySettingsFile> = fs::read_to_string(&settings_path)
        .ok()
        .and_then(|txt| serde_json::from_str(&txt).ok());

    let runtime_dir = root.join("runtime");
    let runtime_bytes = if runtime_dir.is_dir() {
        dir_size(&runtime_dir)
    } else {
        0
    };

    let has_douyin_profile = root.join("mc-profiles").join("douyin").is_dir();
    let has_xhs_profile = root.join("mc-profiles").join("xhs").is_dir();

    if let Some(s) = parsed {
        let mut key_ids: Vec<String> = s.keys.keys().cloned().collect();
        key_ids.sort();
        LegacyMigrationPreview {
            detected: true,
            legacy_dir: Some(root.to_string_lossy().to_string()),
            has_settings: true,
            provider_count: s.provider_catalog.len(),
            key_ids,
            root_dir: s.root_dir,
            xhs_download_dir: s.xhs_download_dir,
            has_douyin_profile,
            has_xhs_profile,
            runtime_bytes,
        }
    } else {
        LegacyMigrationPreview {
            detected: runtime_bytes > 0 || has_douyin_profile || has_xhs_profile,
            legacy_dir: Some(root.to_string_lossy().to_string()),
            has_settings: false,
            provider_count: 0,
            key_ids: vec![],
            root_dir: None,
            xhs_download_dir: None,
            has_douyin_profile,
            has_xhs_profile,
            runtime_bytes,
        }
    }
}

/// 路径 1：解密旧版 Node/AES-256-GCM 降级密文
/// 对应旧版 electron/main/server/services/settings.ts:63-93
/// 格式：base64(iv[12] || authTag[16] || ciphertext)
pub fn decrypt_legacy_aes(legacy_dir: &Path, cipher_b64: &str) -> Option<String> {
    let salt_path = legacy_dir.join(".salt");
    let salt = fs::read(&salt_path).ok()?;
    let raw = B64.decode(cipher_b64.trim()).ok()?;
    if raw.len() <= 28 {
        return None;
    }

    let iv = &raw[..12];
    let tag = &raw[12..28];
    let enc = &raw[28..];
    // aes-gcm crate expects ciphertext || tag
    let mut ct_with_tag = Vec::with_capacity(enc.len() + 16);
    ct_with_tag.extend_from_slice(enc);
    ct_with_tag.extend_from_slice(tag);

    let host_candidates = hostname_candidates();
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();

    let params = ScryptParams::new(14, 8, 1, 32).ok()?;
    for host in host_candidates {
        let fingerprint = format!("{host}|{user}|newmedia-workbench");
        let mut key = [0u8; 32];
        if scrypt(fingerprint.as_bytes(), &salt, &params, &mut key).is_err() {
            continue;
        }
        let Ok(cipher) = Aes256Gcm::new_from_slice(&key) else {
            continue;
        };
        if let Ok(plain) = cipher.decrypt(Nonce::from_slice(iv), ct_with_tag.as_slice()) {
            if let Ok(s) = String::from_utf8(plain) {
                if !s.trim().is_empty() {
                    return Some(s);
                }
            }
        }
    }
    None
}

fn hostname_candidates() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(h) = std::env::var("HOSTNAME").or_else(|_| std::env::var("COMPUTERNAME")) {
        if !h.is_empty() {
            out.push(h);
        }
    }
    #[cfg(unix)]
    if let Ok(output) = std::process::Command::new("hostname").output() {
        if output.status.success() {
            let h = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !h.is_empty() && !out.contains(&h) {
                out.push(h);
            }
        }
    }
    if out.is_empty() {
        out.push("localhost".to_string());
    }
    out
}

/// 路径 2：macOS Chromium OSCrypt `v10` 解密（Electron safeStorage on macOS）
/// 规则：raw = b"v10" || AES-128-CBC(key=PBKDF2-SHA1(password, "saltysalt", 1003, 16), iv="                ", PKCS7)
pub fn decrypt_macos_oscrypt_v10(raw: &[u8], keychain_password: &str) -> Option<String> {
    if !raw.starts_with(b"v10") || raw.len() <= 3 {
        return None;
    }
    let mut key = [0u8; 16];
    pbkdf2_hmac::<Sha1>(keychain_password.as_bytes(), b"saltysalt", 1003, &mut key);
    let iv = [b' '; 16];
    let mut buf = raw[3..].to_vec();
    let decrypted = Aes128CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    let s = String::from_utf8(decrypted.to_vec()).ok()?;
    if s.trim().is_empty() {
        None
    } else {
        Some(s)
    }
}

#[cfg(target_os = "macos")]
fn load_macos_legacy_safe_storage_passwords() -> Vec<String> {
    let candidates = [
        ("AI新媒体工作台 Safe Storage", "AI新媒体工作台"),
        ("newmedia-workbench Safe Storage", "newmedia-workbench"),
        ("Electron Safe Storage", "Electron"),
        ("Chrome Safe Storage", "Chrome"),
    ];
    let mut passwords = Vec::new();
    for (service, account) in candidates {
        if let Ok(entry) = keyring::Entry::new(service, account) {
            if let Ok(pwd) = entry.get_password() {
                if !pwd.is_empty() && !passwords.contains(&pwd) {
                    passwords.push(pwd);
                }
            }
        }
    }
    passwords
}

#[cfg(target_os = "windows")]
fn decrypt_windows_dpapi(raw: &[u8]) -> Option<String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptUnprotectData, CRYPT_INTEGER_BLOB};

    if raw.is_empty() {
        return None;
    }
    let mut in_blob = CRYPT_INTEGER_BLOB {
        cbData: raw.len() as u32,
        pbData: raw.as_ptr() as *mut u8,
    };
    let mut out_blob = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    let ok = unsafe {
        CryptUnprotectData(
            &mut in_blob,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            &mut out_blob,
        )
    };
    if ok == 0 || out_blob.pbData.is_null() {
        return None;
    }
    let slice = unsafe { std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize) };
    let plain = String::from_utf8(slice.to_vec()).ok();
    unsafe {
        LocalFree(out_blob.pbData as _);
    }
    plain.filter(|s| !s.trim().is_empty())
}

fn decrypt_legacy_value(
    legacy_dir: &Path,
    cipher_b64: &str,
    macos_passwords: &[String],
) -> Result<String, String> {
    // 1) 先尝试旧版 AES-256-GCM 降级格式（无系统弹窗，速度最快）
    if let Some(plain) = decrypt_legacy_aes(legacy_dir, cipher_b64) {
        return Ok(plain);
    }

    let raw = B64
        .decode(cipher_b64.trim())
        .map_err(|_| "密文格式非法（非有效 Base64）".to_string())?;

    // 2) macOS Electron safeStorage (v10)
    if raw.starts_with(b"v10") {
        for pwd in macos_passwords {
            if let Some(plain) = decrypt_macos_oscrypt_v10(&raw, pwd) {
                return Ok(plain);
            }
        }
        return Err("未能从 macOS 钥匙串读取旧版 Safe Storage 授权密钥，请在设置页补填该 Key".into());
    }

    // 3) Windows Electron safeStorage (DPAPI)
    #[cfg(target_os = "windows")]
    if let Some(plain) = decrypt_windows_dpapi(&raw) {
        return Ok(plain);
    }

    Err("无法解密该旧版密文（可能来自其他机器或未授权系统密钥），请在设置页补填".into())
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let path = entry.path();
        let target = dst.join(entry.file_name());
        let meta = entry.metadata()?;
        if meta.is_symlink() {
            continue;
        }
        if meta.is_dir() {
            copy_dir_recursive(&path, &target)?;
        } else if meta.is_file() {
            let _ = fs::copy(&path, &target);
        }
    }
    Ok(())
}

/// 执行无损迁移（全程只读旧目录，明文 Key 永不落盘）
pub fn run_migration(opts: MigrationOptions) -> Result<MigrationReport, String> {
    let legacy_root = resolve_legacy_root(opts.custom_legacy_dir.as_deref())
        .ok_or_else(|| "未检测到旧版 Electron 数据目录，请手动选择目录".to_string())?;

    let settings_path = legacy_root.join("settings.json");
    let legacy: LegacySettingsFile = if settings_path.is_file() {
        let raw = fs::read_to_string(&settings_path)
            .map_err(|e| format!("读取旧版 settings.json 失败：{e}"))?;
        serde_json::from_str(&raw)
            .map_err(|e| format!("解析旧版 settings.json 失败：{e}"))?
    } else {
        LegacySettingsFile::default()
    };

    let mut stored = settings::load_stored()?;
    let mut providers_migrated = 0usize;
    let mut caps_migrated = 0usize;
    let mut root_dir_migrated = false;
    let mut xhs_dir_migrated = false;

    if opts.migrate_settings {
        for (id, rec) in legacy.provider_catalog {
            stored.provider_catalog.insert(id, rec);
            providers_migrated += 1;
        }
        for (cap_str, pid) in legacy.providers {
            if let Some(cap) = parse_cap_id(&cap_str) {
                stored.providers.insert(cap, pid);
                caps_migrated += 1;
            }
        }
        for (cap_str, model) in legacy.suppliers {
            if let Some(cap) = parse_cap_id(&cap_str) {
                stored.suppliers.insert(cap, model);
            }
        }
        for (cap_str, entries) in legacy.capability_configs {
            if let Some(cap) = parse_cap_id(&cap_str) {
                stored.capability_configs.insert(cap, entries);
            }
        }
        if let Some(rd) = legacy.root_dir.filter(|s| !s.trim().is_empty()) {
            stored.root_dir = Some(rd);
            root_dir_migrated = true;
        }
        if let Some(xd) = legacy.xhs_download_dir.filter(|s| !s.trim().is_empty()) {
            stored.xhs_download_dir = Some(xd);
            xhs_dir_migrated = true;
        }
    }

    let mut keys_migrated = Vec::new();
    let mut keys_failed = Vec::new();

    if opts.migrate_keys && !legacy.keys.is_empty() {
        #[cfg(target_os = "macos")]
        let macos_passwords = {
            let needs_v10 = legacy.keys.values().any(|v| {
                B64.decode(v.trim())
                    .map(|b| b.starts_with(b"v10"))
                    .unwrap_or(false)
            });
            if needs_v10 {
                load_macos_legacy_safe_storage_passwords()
            } else {
                vec![]
            }
        };
        #[cfg(not(target_os = "macos"))]
        let macos_passwords: Vec<String> = vec![];

        for (key_id, cipher_b64) in &legacy.keys {
            match decrypt_legacy_value(&legacy_root, cipher_b64, &macos_passwords) {
                Ok(plain) => match settings::store_secret_key(key_id, &plain) {
                    Ok(marker) => {
                        stored.keys.insert(key_id.clone(), marker);
                        let ver = stored.key_versions.get(key_id).copied().unwrap_or(0) + 1;
                        stored.key_versions.insert(key_id.clone(), ver);
                        keys_migrated.push(key_id.clone());
                    }
                    Err(e) => keys_failed.push(KeyMigrationFailure {
                        key_id: key_id.clone(),
                        reason: format!("写入新版安全存储失败：{e}"),
                    }),
                },
                Err(reason) => keys_failed.push(KeyMigrationFailure {
                    key_id: key_id.clone(),
                    reason,
                }),
            }
        }
    }

    settings::save_stored(&stored)?;

    let mut profiles_copied = Vec::new();
    if opts.copy_browser_profiles {
        let new_profiles_root = resolve_app_data_dir()
            .map_err(|e| e.to_string())?
            .join("profiles");
        for plat in ["douyin", "xhs"] {
            let src = legacy_root.join("mc-profiles").join(plat);
            if src.is_dir() {
                let dst = new_profiles_root.join(plat);
                if copy_dir_recursive(&src, &dst).is_ok() {
                    profiles_copied.push(plat.to_string());
                }
            }
        }
    }

    let runtime_dir = legacy_root.join("runtime");
    let runtime_bytes_reclaimable = if runtime_dir.is_dir() {
        dir_size(&runtime_dir)
    } else {
        0
    };

    keys_migrated.sort();

    Ok(MigrationReport {
        ok: true,
        legacy_dir: legacy_root.to_string_lossy().to_string(),
        providers_migrated,
        caps_migrated,
        keys_migrated,
        keys_failed,
        root_dir_migrated,
        xhs_dir_migrated,
        profiles_copied,
        runtime_bytes_reclaimable,
    })
}

/// 安全清理旧版 Python 运行时目录（严格白名单：仅清理 `<legacy>/runtime`，绝不碰 settings.json 和用户素材库）
pub fn cleanup_legacy_runtime(
    custom_dir: Option<&str>,
    confirm_phrase: &str,
) -> Result<CleanupRuntimeResult, String> {
    if confirm_phrase.trim() != "CLEAN_LEGACY_RUNTIME" {
        return Err("缺少有效清理确认标记，已拒绝执行".into());
    }
    let legacy_root = resolve_legacy_root(custom_dir)
        .ok_or_else(|| "未检测到旧版 Electron 数据目录".to_string())?;
    let runtime_dir = legacy_root.join("runtime");
    if !runtime_dir.is_dir() {
        return Ok(CleanupRuntimeResult {
            ok: true,
            freed_bytes: 0,
            message: "旧版 Python 运行时目录已不存在，无需清理".into(),
        });
    }
    let bytes = dir_size(&runtime_dir);
    fs::remove_dir_all(&runtime_dir)
        .map_err(|e| format!("清理旧版 runtime 目录失败：{e}"))?;
    Ok(CleanupRuntimeResult {
        ok: true,
        freed_bytes: bytes,
        message: format!(
            "已安全释放 {:.1} MB 旧版 Python 运行时空间（旧版设置与素材库均完整保留）",
            bytes as f64 / 1024.0 / 1024.0
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes::cipher::{BlockEncryptMut, KeyIvInit};

    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;

    #[test]
    fn oscrypt_v10_roundtrip_matches_electron_format() {
        let password = "mock-keychain-password-123";
        let secret = "sk-test-deepseek-secret-key-9999";

        let mut key = [0u8; 16];
        pbkdf2_hmac::<Sha1>(password.as_bytes(), b"saltysalt", 1003, &mut key);
        let iv = [b' '; 16];
        let mut buf = vec![0u8; secret.len() + 16];
        buf[..secret.len()].copy_from_slice(secret.as_bytes());
        let ct = Aes128CbcEnc::new(&key.into(), &iv.into())
            .encrypt_padded_mut::<Pkcs7>(&mut buf, secret.len())
            .unwrap();

        let mut raw = b"v10".to_vec();
        raw.extend_from_slice(ct);

        let decoded = decrypt_macos_oscrypt_v10(&raw, password).expect("decrypt v10");
        assert_eq!(decoded, secret);
    }

    #[test]
    fn legacy_aes_and_full_migration_in_isolated_temp_dirs() {
        let tmp = std::env::temp_dir().join(format!("nmw-mig-test-{}", uuid::Uuid::new_v4()));
        let legacy_dir = tmp.join("legacy");
        let new_dir = tmp.join("new");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::create_dir_all(&new_dir).unwrap();

        // 模拟旧版 Electron AES-256-GCM 降级加密（iv[12] || tag[16] || ciphertext）
        let salt = [7u8; 16];
        fs::write(legacy_dir.join(".salt"), salt).unwrap();
        let host = hostname_candidates()[0].clone();
        let user = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_default();
        let fp = format!("{host}|{user}|newmedia-workbench");
        let params = ScryptParams::new(14, 8, 1, 32).unwrap();
        let mut key = [0u8; 32];
        scrypt(fp.as_bytes(), &salt, &params, &mut key).unwrap();

        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let iv = [3u8; 12];
        let ct_and_tag = cipher
            .encrypt(Nonce::from_slice(&iv), b"sk-legacy-migrated-ok".as_ref())
            .unwrap();
        let enc_len = ct_and_tag.len() - 16;
        let mut legacy_blob = Vec::new();
        legacy_blob.extend_from_slice(&iv);
        legacy_blob.extend_from_slice(&ct_and_tag[enc_len..]); // tag
        legacy_blob.extend_from_slice(&ct_and_tag[..enc_len]); // enc
        let b64_key = B64.encode(legacy_blob);

        let legacy_json = serde_json::json!({
            "keys": { "deepseek": b64_key },
            "providers": { "text": "deepseek" },
            "suppliers": { "text": "deepseek-reasoner" },
            "rootDir": "/tmp/mock-library",
            "xhsDownloadDir": "/tmp/mock-xhs"
        });
        fs::write(
            legacy_dir.join("settings.json"),
            serde_json::to_string_pretty(&legacy_json).unwrap(),
        )
        .unwrap();

        // 验证旧版解密函数
        let plain = decrypt_legacy_aes(&legacy_dir, &b64_key).expect("decrypt legacy aes");
        assert_eq!(plain, "sk-legacy-migrated-ok");

        // 指向隔离目录执行完整迁移
        std::env::set_var("NEWMEDIA_RS_DATA_DIR", &new_dir);
        let report = run_migration(MigrationOptions {
            custom_legacy_dir: Some(legacy_dir.to_string_lossy().to_string()),
            migrate_settings: true,
            migrate_keys: true,
            copy_browser_profiles: false,
        })
        .expect("run migration");

        assert!(report.ok);
        assert_eq!(report.keys_migrated, vec!["deepseek".to_string()]);
        assert!(report.keys_failed.is_empty());
        assert!(report.root_dir_migrated);

        let snap = settings::resolve_request(CapId::Text, None).expect("resolve migrated request");
        assert_eq!(snap.api_key, "sk-legacy-migrated-ok");
        assert_eq!(snap.model, "deepseek-reasoner");

        let _ = fs::remove_dir_all(&tmp);
    }
}
