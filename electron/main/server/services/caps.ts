// 单一事实源：BACKEND-PATH §2.1 / §6.1（CAP_SLOTS 三能力槽位）
// aiProxy 据此路由到对应 baseURL 的 openai 客户端。
// image 槽位经 AIHubMix 中转；默认 gpt-image-2，也保留 gpt-image-1 供用户切换。

export type CapId = 'text' | 'visionImg' | 'visionVideo' | 'image';

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
}

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
  },
  image: {
    id: 'image',
    label: '出图（AIHubMix）',
    keyId: 'openai', // 注意：该槽位填的是 AIHubMix Key，非直连 OpenAI
    // 真实出图使用 AIHubMix 官方文档的主网关；避免备用网关的图片端点兼容性差异。
    baseURL: 'https://aihubmix.com/v1',
    defaultModel: 'gpt-image-2', // AIHubMix 官方 OpenAI 兼容图像接口
    alternatives: ['gpt-image-1'],
    kind: 'image',
    locked: false,
  },
};

export const CAP_IDS = Object.keys(CAP_SLOTS) as CapId[];

/** sk- 前缀校验：仅对需要 sk- 的供应商做格式校验（BACKEND-PATH §6.3） */
export function validateKeyFormat(keyId: string, key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return 'Key 不能为空';
  if ((keyId === 'deepseek' || keyId === 'openai') && !trimmed.startsWith('sk-')) {
    return `该供应商 Key 须以 sk- 开头`;
  }
  return null;
}
