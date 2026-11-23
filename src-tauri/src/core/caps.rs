use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum CapId {
    #[serde(rename = "text")]
    Text,
    #[serde(rename = "visionImg")]
    VisionImg,
    #[serde(rename = "visionVideo")]
    VisionVideo,
    #[serde(rename = "image")]
    Image,
}

impl CapId {
    pub const ALL: [CapId; 4] = [
        CapId::Text,
        CapId::VisionImg,
        CapId::VisionVideo,
        CapId::Image,
    ];

    pub fn as_str(&self) -> &'static str {
        match self {
            CapId::Text => "text",
            CapId::VisionImg => "visionImg",
            CapId::VisionVideo => "visionVideo",
            CapId::Image => "image",
        }
    }

    pub fn label(&self) -> &'static str {
        match self {
            CapId::Text => "文字改写",
            CapId::VisionImg => "图文识别",
            CapId::VisionVideo => "视频识别",
            CapId::Image => "出图",
        }
    }

    pub fn default_provider_id(&self) -> &'static str {
        match self {
            CapId::Text => "deepseek",
            CapId::VisionImg => "zhipu",
            CapId::VisionVideo => "qwen",
            CapId::Image => "aihubmix",
        }
    }

    pub fn default_model(&self) -> &'static str {
        match self {
            CapId::Text => "deepseek-chat",
            CapId::VisionImg => "glm-4v-flash",
            CapId::VisionVideo => "qwen-vl-max",
            CapId::Image => "gpt-image-2",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderProtocol {
    #[serde(rename = "openai-chat-completions")]
    OpenaiChatCompletions,
    #[serde(rename = "openai-responses")]
    OpenaiResponses,
    #[serde(rename = "anthropic-messages")]
    AnthropicMessages,
}

impl ProviderProtocol {
    pub fn supports_cap(&self, cap: CapId) -> bool {
        match cap {
            CapId::Image | CapId::VisionVideo => *self == ProviderProtocol::OpenaiChatCompletions,
            CapId::Text | CapId::VisionImg => true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub capabilities: Vec<CapId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderRecord {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub portal: Option<String>,
    pub key_id: String,
    #[serde(rename = "baseURL")]
    pub base_url: String,
    pub protocol: ProviderProtocol,
    pub models: Vec<ProviderModel>,
    pub builtin: bool,
    pub revision: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope_cap: Option<CapId>,
}

pub fn builtin_providers() -> Vec<ProviderRecord> {
    vec![
        ProviderRecord {
            id: "deepseek".into(),
            label: "DeepSeek".into(),
            portal: Some("https://platform.deepseek.com/".into()),
            key_id: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            protocol: ProviderProtocol::OpenaiChatCompletions,
            models: vec![
                ProviderModel {
                    id: "deepseek-chat".into(),
                    label: None,
                    capabilities: vec![CapId::Text],
                },
                ProviderModel {
                    id: "deepseek-reasoner".into(),
                    label: None,
                    capabilities: vec![CapId::Text],
                },
                ProviderModel {
                    id: "deepseek-flash".into(),
                    label: Some("DeepSeek Flash".into()),
                    capabilities: vec![CapId::VisionImg],
                },
            ],
            builtin: true,
            revision: 1,
            scope_cap: None,
        },
        ProviderRecord {
            id: "zhipu".into(),
            label: "智谱".into(),
            portal: Some("https://open.bigmodel.cn/".into()),
            key_id: "zhipu".into(),
            base_url: "https://open.bigmodel.cn/api/paas/v4/".into(),
            protocol: ProviderProtocol::OpenaiChatCompletions,
            models: vec![
                ProviderModel {
                    id: "glm-5.3-flash".into(),
                    label: Some("GLM-5.3-Flash".into()),
                    capabilities: vec![CapId::Text],
                },
                ProviderModel {
                    id: "glm-4.5-air".into(),
                    label: Some("GLM-4.5-Air".into()),
                    capabilities: vec![CapId::Text],
                },
                ProviderModel {
                    id: "glm-4v-flash".into(),
                    label: None,
                    capabilities: vec![CapId::VisionImg],
                },
                ProviderModel {
                    id: "glm-4v-plus".into(),
                    label: None,
                    capabilities: vec![CapId::VisionImg],
                },
            ],
            builtin: true,
            revision: 1,
            scope_cap: None,
        },
        ProviderRecord {
            id: "qwen".into(),
            label: "通义千问".into(),
            portal: Some("https://bailian.console.aliyun.com/".into()),
            key_id: "qwen".into(),
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1".into(),
            protocol: ProviderProtocol::OpenaiChatCompletions,
            models: vec![
                ProviderModel {
                    id: "qwen-vl-max".into(),
                    label: None,
                    capabilities: vec![CapId::VisionVideo],
                },
                ProviderModel {
                    id: "qwen-vl-plus".into(),
                    label: None,
                    capabilities: vec![CapId::VisionVideo],
                },
            ],
            builtin: true,
            revision: 1,
            scope_cap: None,
        },
        ProviderRecord {
            id: "aihubmix".into(),
            label: "AIHubMix".into(),
            portal: Some("https://aihubmix.com/".into()),
            key_id: "openai".into(),
            base_url: "https://aihubmix.com/v1".into(),
            protocol: ProviderProtocol::OpenaiChatCompletions,
            models: vec![
                ProviderModel {
                    id: "gpt-image-2".into(),
                    label: None,
                    capabilities: vec![CapId::Image],
                },
                ProviderModel {
                    id: "gpt-image-1".into(),
                    label: None,
                    capabilities: vec![CapId::Image],
                },
            ],
            builtin: true,
            revision: 1,
            scope_cap: None,
        },
        ProviderRecord {
            id: "sudocode".into(),
            label: "SudoCode".into(),
            portal: Some("https://sudocode.chat/docs".into()),
            key_id: "sudocode".into(),
            base_url: "https://api.sudorelay.com/v1".into(),
            protocol: ProviderProtocol::OpenaiChatCompletions,
            models: vec![ProviderModel {
                id: "gpt-image-2".into(),
                label: None,
                capabilities: vec![CapId::Image],
            }],
            builtin: true,
            revision: 1,
            scope_cap: None,
        },
    ]
}

pub fn builtin_provider_map() -> HashMap<String, ProviderRecord> {
    builtin_providers()
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect()
}

pub fn validate_key_format(key_id: &str, key: &str) -> Result<(), String> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err("API Key 不能为空".into());
    }
    if matches!(key_id, "deepseek" | "openai" | "sudocode") && !trimmed.starts_with("sk-") {
        return Err("该供应商 API Key 须以 sk- 开头".into());
    }
    Ok(())
}

pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("API 根地址不能为空".into());
    }
    let parsed = url::Url::parse(trimmed).map_err(|_| "API 根地址格式不正确，请填写完整的 http(s):// 地址".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed.trim_end_matches('/').to_string()),
        _ => Err("API 根地址仅支持 http 或 https 协议".into()),
    }
}
