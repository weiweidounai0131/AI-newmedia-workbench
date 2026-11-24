use serde::{Deserialize, Serialize};

use crate::core::ai_proxy::{self, ModelListResult};
use crate::core::caps::{CapId, ProviderProtocol};
use crate::core::settings::{self, ProviderDraft, SettingsSummary};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProviderResponse {
    pub ok: bool,
    pub provider_id: String,
    pub settings: SettingsSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsMutationResponse {
    pub ok: bool,
    pub settings: SettingsSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCapResponse {
    pub ok: bool,
    pub model: Option<String>,
    pub error: Option<String>,
    pub settings: Option<SettingsSummary>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchModelsRequest {
    pub id: Option<String>,
    #[serde(rename = "baseURL")]
    pub base_url: Option<String>,
    pub protocol: Option<ProviderProtocol>,
    pub api_key: Option<String>,
}

#[tauri::command]
pub fn get_settings() -> Result<SettingsSummary, String> {
    settings::get_summary()
}

#[tauri::command]
pub fn set_capability(
    cap: CapId,
    provider_id: String,
    model: String,
) -> Result<SettingsMutationResponse, String> {
    let summary = settings::set_capability(cap, &provider_id, &model)?;
    Ok(SettingsMutationResponse {
        ok: true,
        settings: summary,
    })
}

#[tauri::command]
pub fn set_provider_key(
    provider_id: String,
    key: String,
) -> Result<SettingsMutationResponse, String> {
    let summary = settings::set_provider_key(&provider_id, &key)?;
    Ok(SettingsMutationResponse {
        ok: true,
        settings: summary,
    })
}

#[tauri::command]
pub fn save_provider(draft: ProviderDraft) -> Result<SaveProviderResponse, String> {
    let (provider_id, summary) = settings::save_provider(draft)?;
    Ok(SaveProviderResponse {
        ok: true,
        provider_id,
        settings: summary,
    })
}

#[tauri::command]
pub fn delete_capability_config(
    cap: CapId,
    provider_id: String,
    model: String,
) -> Result<SettingsMutationResponse, String> {
    let summary = settings::delete_capability_config(cap, &provider_id, &model)?;
    Ok(SettingsMutationResponse {
        ok: true,
        settings: summary,
    })
}

#[tauri::command]
pub async fn fetch_provider_models(req: FetchModelsRequest) -> Result<ModelListResult, String> {
    ai_proxy::fetch_provider_models(
        req.id.as_deref(),
        req.base_url.as_deref(),
        req.protocol,
        req.api_key.as_deref(),
    )
    .await
}

#[tauri::command]
pub async fn verify_capability(
    cap: CapId,
    provider_id: Option<String>,
    model: Option<String>,
) -> VerifyCapResponse {
    match ai_proxy::verify_capability(cap, provider_id.as_deref(), model.as_deref()).await {
        Ok(model) => VerifyCapResponse {
            ok: true,
            model: Some(model),
            error: None,
            settings: settings::get_summary().ok(),
        },
        Err(err) => VerifyCapResponse {
            ok: false,
            model: None,
            error: Some(err),
            settings: settings::get_summary().ok(),
        },
    }
}

#[tauri::command]
pub fn set_root_dir(root_dir: Option<String>) -> Result<SettingsMutationResponse, String> {
    let summary = settings::set_root_dir(root_dir)?;
    Ok(SettingsMutationResponse {
        ok: true,
        settings: summary,
    })
}

#[tauri::command]
pub fn set_xhs_download_dir(
    xhs_download_dir: Option<String>,
) -> Result<SettingsMutationResponse, String> {
    let summary = settings::set_xhs_download_dir(xhs_download_dir)?;
    Ok(SettingsMutationResponse {
        ok: true,
        settings: summary,
    })
}
