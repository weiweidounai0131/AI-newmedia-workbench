// 单一事实源：BACKEND-PATH §2.1 / §6.1（CAP_SLOTS 三能力槽位）
// aiProxy 据此路由到对应 baseURL 的 openai 客户端。
// text / image 槽位支持多个 OpenAI 兼容供应商；默认仍保持原来的 DeepSeek / AIHubMix。

export type CapId = 'text' | 'visionImg' | 'visionVideo' | 'image';

export interface ProviderDef {
  /** 设置页与审计中使用的稳定 ID */
  id: string;
  /** 设置页展示名称 */
  label: string;
  /** 设置/存储中该供应商 Key 的存储键名 */
  keyId: string;
  /** OpenAI 兼容 base_url */
  baseURL: string;
  /** 该供应商的默认模型 */
  defaultModel: string;
  /** 该供应商可切换的备选模型 */
  alternatives: string[];
  /** 设置页“点击获取 API Key”跳转地址 */
  portal: string;
  /** API 模型 ID 到友好名称的映射 */
  modelLabels?: Record<string, string>;
}

export interface CapDef {
  id: CapId;
  /** 设置页展示标签 */
  label: string;
  /** 设置/存储中该槽位 Key 的存储键名 */
  keyId: string;
  /** OpenAI 兼容 base_url（image 经 AIHubMix 中转） */
  baseURL: string;
  /** 默认模型（运行时可在设置页切备选） */
  defaultModel: string;
  /** 备选供应商模型 */
  alternatives: string[];
  /** 调用类型：chat=chat.completions；image=images.generate/edits */
  kind: 'chat' | 'image';
  /** 是否锁定（用户不可改） */
  locked: boolean;
  /** 可选供应商；未配置时沿用上面的单供应商字段 */
  providers?: ProviderDef[];
  /** 默认供应商 ID（仅用于显式声明默认值） */
  defaultProvider?: string;
}

const DEEPSEEK_PROVIDER: ProviderDef = {
  id: 'deepseek',
  label: 'DeepSeek',
  keyId: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  defaultModel: 'deepseek-chat',
  alternatives: ['deepseek-reasoner'],
  portal: 'https://platform.deepseek.com/',
};

const ZHIPU_TEXT_PROVIDER: ProviderDef = {
  id: 'zhipu',
  label: '智谱',
  keyId: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  defaultModel: 'glm-5.3-flash',
  alternatives: ['glm-4.5-air'],
  portal: 'https://open.bigmodel.cn/',
  modelLabels: {
    'glm-5.3-flash': 'GLM-5.3-Flash',
    'glm-4.5-air': 'GLM-4.5-Air',
  },
};

const ZHIPU_VISION_PROVIDER: ProviderDef = {
  id: 'zhipu',
  label: '智谱',
  keyId: 'zhipu',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  defaultModel: 'glm-4v-flash',
  alternatives: ['glm-4v-plus'],
  portal: 'https://open.bigmodel.cn/',
};

const DEEPSEEK_VISION_PROVIDER: ProviderDef = {
  id: 'deepseek',
  label: 'DeepSeek',
  keyId: 'deepseek',
  baseURL: 'https://api.deepseek.com',
  defaultModel: 'deepseek-flash',
  alternatives: [],
  portal: 'https://platform.deepseek.com/',
  modelLabels: {
    'deepseek-flash': 'DeepSeek Flash',
  },
};

const QWEN_VISION_PROVIDER: ProviderDef = {
  id: 'qwen',
  label: '通义千问',
  keyId: 'qwen',
  baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  defaultModel: 'qwen-vl-max',
  alternatives: ['qwen-vl-plus'],
  portal: 'https://bailian.console.aliyun.com/',
};

const AIHUBMIX_IMAGE_PROVIDER: ProviderDef = {
  id: 'aihubmix',
  label: 'AIHubMix',
  keyId: 'openai',
  baseURL: 'https://aihubmix.com/v1',
  defaultModel: 'gpt-image-2',
  alternatives: ['gpt-image-1'],
  portal: 'https://aihubmix.com/',
};

const SUDOCODE_IMAGE_PROVIDER: ProviderDef = {
  id: 'sudocode',
  label: 'SudoCode',
  keyId: 'sudocode',
  // 文档提供的备用直连节点；当前主节点在本机代理环境下鉴权请求会超时。
  baseURL: 'https://api.sudorelay.com/v1',
  defaultModel: 'gpt-image-2',
  alternatives: [],
  portal: 'https://sudocode.chat/docs',
};

export const CAP_SLOTS: Record<CapId, CapDef> = {
  text: {
    id: 'text',
    label: '文字改写',
    keyId: 'deepseek',
    baseURL: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat', // BACKEND-PATH §2.1 称 DeepSeek-V4-Flash
    alternatives: ['deepseek-reasoner'],
    kind: 'chat',
    locked: false,
    providers: [DEEPSEEK_PROVIDER, ZHIPU_TEXT_PROVIDER],
    defaultProvider: 'deepseek',
  },
  visionImg: {
    id: 'visionImg',
    label: '图文识别',
    keyId: 'zhipu',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
    defaultModel: 'glm-4v-flash',
    alternatives: ['glm-4v-plus'],
    kind: 'chat',
    locked: false,
    providers: [ZHIPU_VISION_PROVIDER, DEEPSEEK_VISION_PROVIDER],
    defaultProvider: 'zhipu',
  },
  visionVideo: {
    id: 'visionVideo',
    label: '视频识别',
    keyId: 'qwen',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-vl-max',
    alternatives: ['qwen-vl-plus'],
    kind: 'chat',
    locked: false,
    providers: [QWEN_VISION_PROVIDER],
    defaultProvider: 'qwen',
  },
  image: {
    id: 'image',
    label: '出图',
    keyId: 'openai', // 注意：该槽位填的是 AIHubMix Key，非直连 OpenAI
    // 真实出图使用 AIHubMix 官方文档的主网关；避免备用网关的图片端点兼容性差异。
    baseURL: 'https://aihubmix.com/v1',
    defaultModel: 'gpt-image-2', // AIHubMix 官方 OpenAI 兼容图像接口
    alternatives: ['gpt-image-1'],
    kind: 'image',
    locked: false,
    providers: [AIHUBMIX_IMAGE_PROVIDER, SUDOCODE_IMAGE_PROVIDER],
    defaultProvider: 'aihubmix',
  },
};

export const CAP_IDS = Object.keys(CAP_SLOTS) as CapId[];

/** 返回某能力当前供应商；无多供应商配置的能力使用旧字段构造兼容定义。 */
export function getProviderDef(cap: CapId, providerId?: string): ProviderDef {
  const def = CAP_SLOTS[cap];
  if (def.providers?.length) {
    return def.providers.find((provider) => provider.id === providerId)
      ?? def.providers.find((provider) => provider.id === def.defaultProvider)
      ?? def.providers[0];
  }
  return {
    id: def.defaultProvider ?? def.keyId,
    label: def.keyId,
    keyId: def.keyId,
    baseURL: def.baseURL,
    defaultModel: def.defaultModel,
    alternatives: def.alternatives,
    portal: '',
  };
}

export function getProviderOptions(cap: CapId): ProviderDef[] {
  return CAP_SLOTS[cap].providers ?? [];
}

/** sk- 前缀校验：仅对需要 sk- 的供应商做格式校验（BACKEND-PATH §6.3） */
export function validateKeyFormat(keyId: string, key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return 'Key 不能为空';
  if ((keyId === 'deepseek' || keyId === 'openai' || keyId === 'sudocode') && !trimmed.startsWith('sk-')) {
    return `该供应商 Key 须以 sk- 开头`;
  }
  return null;
}
