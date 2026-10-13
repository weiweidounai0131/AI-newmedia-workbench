// 单一事实源：BACKEND-PATH §6.3（Key 本地加密）/ §6.6（设置 API 契约）
//
// 设计要点：
//  - Key 落盘加密：优先 Electron safeStorage；非 Electron 环境（本地 dev / 测试）
//    降级为「机器指纹 + 持久 salt」派生的 AES-256-GCM（BACKEND-PATH §6.3 允许）。
//  - 明文 Key 永不出现在 GET /api/settings 响应体；前端只读 configured 布尔。
//  - 解密失败不阻塞应用启动，引导用户重配（对应风险 T21）。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { CAP_SLOTS, CAP_IDS, type CapId, type ProviderModel, type ProviderProtocol, type ProviderRecord, getBuiltinProviders, providerSupportsCapability, validateKeyFormat } from './caps.js';

const require = createRequire(import.meta.url);

function isElectron(): boolean {
  return typeof process.versions.electron !== 'undefined';
}

// ---- 数据目录解析（Electron 用 userData，Node 用 .data/） ----
function dataDir(): string {
  let base: string;
  if (isElectron()) {
    try {
      const { app } = require('electron');
      base = app.getPath('userData');
    } catch {
      base = path.join(process.cwd(), '.data');
    }
  } else {
    base = process.env.NEWMEDIA_DATA_DIR || path.join(process.cwd(), '.data');
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

// ---- 加密盒：safeStorage 优先，AES-256-GCM 降级 ----
interface Encryptor {
  encrypt(plain: string): string;
  decrypt(cipherB64: string): string;
}

function loadSafeStorage(): Encryptor | null {
  if (!isElectron()) return null;
  try {
    const electron = require('electron');
    const ss = electron.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable()) {
      // 统一成 Encryptor 接口（输入输出均为 base64 字符串），与 AES 路径一致
      return {
        encrypt: (s: string) => ss.encryptString(s).toString('base64'),
        decrypt: (c: string) => ss.decryptString(Buffer.from(c, 'base64')),
      };
    }
  } catch {
    /* fallthrough to AES */
  }
  return null;
}

function aesEncryptor(dir: string): Encryptor {
  const saltPath = path.join(dir, '.salt');
  let salt: Buffer;
  if (fs.existsSync(saltPath)) {
    salt = fs.readFileSync(saltPath);
  } else {
    salt = crypto.randomBytes(16);
    fs.writeFileSync(saltPath, salt, { mode: 0o600 });
  }
  // 机器指纹 + 持久 salt 派生密钥（BACKEND-PATH §6.3 降级方案）
  const fingerprint = `${os.hostname()}|${os.userInfo().username}|newmedia-workbench`;
  const key = crypto.scryptSync(fingerprint, salt, 32);
  return {
    encrypt(plain: string): string {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]).toString('base64');
    },
    decrypt(cipherB64: string): string {
      const buf = Buffer.from(cipherB64, 'base64');
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const enc = buf.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
    },
  };
}

interface StoredSettings {
  keys: Record<string, string>; // keyId -> 加密后的密文
  suppliers: Partial<Record<CapId, string>>; // cap -> 当前模型
  providers: Partial<Record<CapId, string>>; // cap -> 当前供应商
  providerCatalog: Record<string, ProviderRecord>; // custom provider definitions; credentials remain in encrypted keys
  capabilityConfigs?: Partial<Record<CapId, { providerId: string; model: string }[]>>;
  keyVersions: Record<string, number>;
  // 只有后端真实验证成功后才写入；前端切页不会再丢失“已验证”状态。
  verified: Partial<Record<CapId, string | VerificationStamp>>;
  rootDir?: string; // 导出根目录（方案 C，加密存，见 §5.1）
  xhsDownloadDir?: string; // 小红书图文下载/洗稿解析目录
}

interface VerificationStamp {
  providerId: string;
  model: string;
  providerRevision: number;
  keyVersion: number;
}

export interface ProviderRequestSnapshot {
  cap: CapId;
  provider: ProviderRecord;
  model: string;
  keyId: string;
  keyVersion: number;
  apiKey: string;
}

export interface ProviderDraft {
  id?: string;
  mode?: 'create' | 'edit';
  cap?: CapId;
  sourceProviderId?: string;
  sourceModel?: string;
  label: string;
  baseURL: string;
  protocol: ProviderProtocol;
  models: ProviderModel[];
  apiKey?: string;
}

export class ProviderConfigError extends Error {
  status: number;
  code: string;
  slots?: CapId[];
  constructor(code: string, message: string, status = 400, slots?: CapId[]) {
    super(message);
    this.name = 'ProviderConfigError';
    this.code = code;
    this.status = status;
    this.slots = slots;
  }
}

export function validateProviderBaseURL(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500) {
    throw new ProviderConfigError('invalid_base_url', '请输入有效的 API 根地址');
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new ProviderConfigError('invalid_base_url', 'API 根地址格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ProviderConfigError('invalid_base_url', 'API 根地址只允许 HTTP 或 HTTPS');
  if (url.username || url.password || url.hash || value.trim().includes('#')) throw new ProviderConfigError('invalid_base_url', 'API 根地址不能包含账号、密码或 fragment');
  if (url.search) {
    throw new ProviderConfigError('invalid_base_url', 'API 根地址不能包含 query 参数；请将网关路径填入地址路径');
  }
  return url.toString();
}

function normalizeProviderModels(value: unknown, protocol: ProviderProtocol): ProviderModel[] {
  if (!Array.isArray(value)) throw new ProviderConfigError('invalid_models', '模型列表格式无效');
  const byId = new Map<string, ProviderModel>();
  for (const candidate of value) {
    if (!candidate || typeof candidate.id !== 'string') throw new ProviderConfigError('invalid_models', '模型 ID 必须是文本');
    const id = candidate.id.trim();
    if (!id || id.length > 200 || /[\r\n\0]/.test(id)) throw new ProviderConfigError('invalid_models', '模型 ID 为空或包含不支持的字符');
    if (!Array.isArray(candidate.capabilities)) throw new ProviderConfigError('invalid_models', `模型 ${id} 的能力列表无效`);
    const capabilities = [...new Set(candidate.capabilities)];
    for (const cap of capabilities) {
      if (!CAP_IDS.includes(cap as CapId)) throw new ProviderConfigError('invalid_models', `模型 ${id} 包含未知能力`);
      if (!providerSupportsCapability({ protocol }, cap as CapId)) throw new ProviderConfigError('unsupported_capability', `该协议不支持模型 ${id} 的所选能力「${CAP_SLOTS[cap as CapId].label}」`);
    }
    const existing = byId.get(id);
    if (existing) existing.capabilities = [...new Set([...existing.capabilities, ...(capabilities as CapId[])])];
    else byId.set(id, { id, label: typeof candidate.label === 'string' ? candidate.label.slice(0, 120) : undefined, capabilities: capabilities as CapId[] });
  }
  return [...byId.values()];
}

function loadProviderCatalog(raw: unknown): Record<string, ProviderRecord> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const catalog: Record<string, ProviderRecord> = {};
  for (const [id, value] of Object.entries(raw as Record<string, any>)) {
    try {
      if (!id.startsWith('custom-') || !value || value.id !== id || value.builtin !== false || value.keyId !== `provider:${id}`) continue;
      if (!['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(value.protocol)) continue;
      if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 80) continue;
      catalog[id] = {
        id,
        label: value.label.trim(),
        keyId: `provider:${id}`,
        baseURL: validateProviderBaseURL(value.baseURL),
        protocol: value.protocol,
        models: normalizeProviderModels(value.models, value.protocol),
        builtin: false,
        revision: Number.isInteger(value.revision) && value.revision > 0 ? value.revision : 1,
        scopeCap: CAP_IDS.includes(value.scopeCap) ? value.scopeCap : undefined,
      };
    } catch { /* Ignore malformed custom provider records; built-in presets remain available. */ }
  }
  return catalog;
}

function loadCapabilityConfigs(raw: unknown): Partial<Record<CapId, { providerId: string; model: string }[]>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Partial<Record<CapId, { providerId: string; model: string }[]>> = {};
  for (const cap of CAP_IDS) {
    const value = (raw as Record<string, unknown>)[cap];
    if (!Array.isArray(value)) continue;
    const refs = value.flatMap((item) => {
      const ref = item as Record<string, unknown> | null;
      if (!ref || typeof ref.providerId !== 'string' || typeof ref.model !== 'string') return [];
      if (!ref.providerId.trim() || !ref.model.trim()) return [];
      return [{ providerId: ref.providerId, model: ref.model }];
    });
    result[cap] = refs;
  }
  return result;
}

const DEFAULT_SETTINGS: StoredSettings = {
  keys: {},
  verified: {},
  providerCatalog: {},
  keyVersions: {},
  suppliers: Object.fromEntries(
    (Object.keys(CAP_SLOTS) as CapId[]).map((c) => [c, CAP_SLOTS[c].defaultModel]),
  ),
  providers: Object.fromEntries(
    (Object.keys(CAP_SLOTS) as CapId[]).map((c) => [c, CAP_SLOTS[c].defaultProvider ?? CAP_SLOTS[c].keyId]),
  ),
};

class SettingsStore {
  private file: string;
  private enc: Encryptor;
  private data: StoredSettings;

  constructor() {
    const dir = dataDir();
    this.file = path.join(dir, 'settings.json');
    this.enc = loadSafeStorage() ?? aesEncryptor(dir);
    this.data = this.load();
  }

  private load(): StoredSettings {
    if (!fs.existsSync(this.file)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const providerCatalog = loadProviderCatalog(raw.providerCatalog);
      const loaded = {
        keys: raw.keys ?? {},
        suppliers: { ...DEFAULT_SETTINGS.suppliers, ...(raw.suppliers ?? {}) },
        providers: { ...DEFAULT_SETTINGS.providers, ...(raw.providers ?? {}) },
        verified: raw.verified ?? {},
        providerCatalog,
        capabilityConfigs: loadCapabilityConfigs(raw.capabilityConfigs),
        keyVersions: raw.keyVersions ?? {},
        rootDir: raw.rootDir,
        xhsDownloadDir: raw.xhsDownloadDir,
      };
      // 旧版本的 image 槽位被固定为 gpt-image-1；将这一历史默认值迁移为新版默认。
      // 同时清理旧版本遗留的 Tunnel 配置，避免本机继续保留无用凭据。
      if (loaded.suppliers.image === 'gpt-image-1' || raw.tunnel) {
        if (loaded.suppliers.image === 'gpt-image-1') {
          loaded.suppliers.image = 'gpt-image-2';
          delete loaded.verified.image;
        }
        // 旧配置不再参与运行；写回已知设置字段，移除遗留凭据。
        fs.writeFileSync(this.file, JSON.stringify(loaded, null, 2), { mode: 0o600 });
      }
      return loaded;
    } catch {
      // 损坏则回退默认，不阻塞启动（T21）
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  private persist(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  // ---- provider/key registry ----
  providers(): ProviderRecord[] {
    return [...getBuiltinProviders(), ...Object.values(this.data.providerCatalog)];
  }

  providerById(id: string): ProviderRecord | undefined {
    return this.providers().find((provider) => provider.id === id);
  }

  private keyIdForProvider(id: string): string {
    return this.providerById(id)?.keyId ?? `provider:${id}`;
  }

  private slotsUsingProvider(id: string): CapId[] {
    return CAP_IDS.filter((cap) => this.data.providers[cap] === id);
  }

  private clearProviderVerification(id: string): void {
    for (const cap of this.slotsUsingProvider(id)) delete this.data.verified[cap];
  }

  private writeKey(keyId: string, rawKey: string): string | null {
    const trimmed = rawKey.trim();
    if (!trimmed) return 'Key 不能为空';
    if (/[\r\n\0]/.test(trimmed)) return 'Key 包含不支持的控制字符';
    if (!keyId.startsWith('provider:')) {
      const err = validateKeyFormat(keyId, trimmed);
      if (err) return err;
    }
    this.data.keys[keyId] = this.enc.encrypt(trimmed);
    this.data.keyVersions[keyId] = (this.data.keyVersions[keyId] ?? 0) + 1;
    for (const cap of CAP_IDS) {
      if (this.providerFor(cap).keyId === keyId) delete this.data.verified[cap];
    }
    return null;
  }

  /** 校验 + 加密存入。返回错误信息（null 表示成功）。 */
  setKey(keyId: string, rawKey: string): string | null {
    const err = this.writeKey(keyId, rawKey);
    if (!err) this.persist();
    return err;
  }

  /** 取明文 Key（仅后端请求生命周期内存在，不落日志/不进前端响应）。 */
  getKey(keyId: string): string | null {
    const cipher = this.data.keys[keyId];
    if (!cipher) return null;
    try { return this.enc.decrypt(cipher); } catch { return null; }
  }

  providerId(cap: CapId): string {
    return this.data.providers[cap] ?? CAP_SLOTS[cap].defaultProvider ?? CAP_SLOTS[cap].keyId;
  }

  providerFor(cap: CapId): ProviderRecord {
    const provider = this.providerById(this.providerId(cap));
    if (provider) return provider;
    const fallback = getBuiltinProviders().find((item) => item.id === (CAP_SLOTS[cap].defaultProvider ?? CAP_SLOTS[cap].keyId));
    if (!fallback) throw new ProviderConfigError('provider_missing', '默认 AI 提供商配置不可用', 500);
    return fallback;
  }

  modelFor(cap: CapId, modelId = this.data.suppliers[cap] ?? ''): ProviderModel | undefined {
    const provider = this.providerFor(cap);
    if (provider.scopeCap && provider.scopeCap !== cap) return undefined;
    return provider.models.find((model) => model.id === modelId
      && model.capabilities.includes(cap)
      && providerSupportsCapability(provider, cap));
  }

  modelsForCapability(cap: CapId): { provider: ProviderRecord; model: ProviderModel }[] {
    return this.providers().flatMap((provider) => providerSupportsCapability(provider, cap)
      && (!provider.scopeCap || provider.scopeCap === cap)
      ? provider.models.filter((model) => model.capabilities.includes(cap)).map((model) => ({ provider, model }))
      : []);
  }

  private capabilityConfigRefs(cap: CapId): { providerId: string; model: string }[] {
    const saved = this.data.capabilityConfigs?.[cap];
    const refs = Array.isArray(saved)
      ? saved
      : this.modelsForCapability(cap).map(({ provider, model }) => ({ providerId: provider.id, model: model.id }));
    const unique = new Map<string, { providerId: string; model: string }>();
    for (const ref of refs) {
      const key = `${ref.providerId}\u0000${ref.model}`;
      const provider = this.providerById(ref.providerId);
      if (provider && providerSupportsCapability(provider, cap)
        && (!provider.scopeCap || provider.scopeCap === cap)
        && provider.models.some((model) => model.id === ref.model && model.capabilities.includes(cap))) unique.set(key, ref);
    }
    const activeProvider = this.providerFor(cap);
    const activeModel = this.currentModel(cap);
    if (!unique.has(`${activeProvider.id}\u0000${activeModel}`)) {
      unique.set(`${activeProvider.id}\u0000${activeModel}`, { providerId: activeProvider.id, model: activeModel });
    }
    return [...unique.values()];
  }

  private writeCapabilityConfigRefs(cap: CapId, refs: { providerId: string; model: string }[]): void {
    this.data.capabilityConfigs ??= {};
    this.data.capabilityConfigs[cap] = refs;
  }

  capabilityConfigOptions(cap: CapId) {
    return this.capabilityConfigRefs(cap).flatMap(({ providerId, model }) => {
      const provider = this.providerById(providerId);
      const entry = provider?.models.find((item) => item.id === model && item.capabilities.includes(cap));
      if (!provider || !entry) return [];
      const active = providerId === this.providerId(cap) && model === this.currentModel(cap);
      return [{
        providerId,
        providerLabel: provider.label,
        model,
        modelLabel: entry.label ?? model,
        baseURL: provider.baseURL,
        protocol: provider.protocol,
        builtin: provider.builtin,
        scopeCap: provider.scopeCap ?? null,
        configured: !!this.getKey(provider.keyId),
        active,
        verified: active && this.isVerified(cap),
      }];
    });
  }

  deleteCapabilityConfig(cap: CapId, providerId: string, model: string): void {
    if (this.providerId(cap) === providerId && this.currentModel(cap) === model) {
      throw new ProviderConfigError('provider_in_use', `「${CAP_SLOTS[cap].label}」当前正在使用此配置，请先切换到其他配置`, 409, [cap]);
    }
    const refs = this.capabilityConfigRefs(cap);
    const nextRefs = refs.filter((ref) => !(ref.providerId === providerId && ref.model === model));
    if (nextRefs.length === refs.length) throw new ProviderConfigError('provider_not_found', '配置已不存在', 404);
    this.writeCapabilityConfigRefs(cap, nextRefs);
    const provider = this.providerById(providerId);
    const referenced = CAP_IDS.some((slot) => this.capabilityConfigRefs(slot).some((ref) => ref.providerId === providerId));
    const active = this.slotsUsingProvider(providerId).length > 0;
    if (provider && !provider.builtin && !referenced && !active) {
      delete this.data.providerCatalog[providerId];
      delete this.data.keys[provider.keyId];
      delete this.data.keyVersions[provider.keyId];
    }
    this.persist();
  }

  currentModel(cap: CapId): string {
    const chosen = this.data.suppliers[cap];
    if (chosen && this.modelFor(cap, chosen)) return chosen;
    return this.modelsForCapability(cap).find(({ provider }) => provider.id === this.providerId(cap))?.model.id
      ?? this.modelsForCapability(cap)[0]?.model.id
      ?? '';
  }

  setKeyForCap(cap: CapId, rawKey: string): string | null {
    return this.setKey(this.providerFor(cap).keyId, rawKey);
  }

  setProviderKey(providerId: string, rawKey: string): string | null {
    const provider = this.providerById(providerId);
    if (!provider) return '提供商已不存在';
    const error = this.writeKey(provider.keyId, rawKey);
    if (!error) this.persist();
    return error;
  }

  isConfigured(cap: CapId): boolean {
    return !!this.getKey(this.providerFor(cap).keyId);
  }

  resolveRequest(cap: CapId, requestedModel?: string): ProviderRequestSnapshot {
    const provider = this.providerFor(cap);
    const model = requestedModel ?? this.currentModel(cap);
    if (!this.modelFor(cap, model)) throw new ProviderConfigError('unsupported_capability', `所选模型未配置「${CAP_SLOTS[cap].label}」能力`, 400);
    const apiKey = this.getKey(provider.keyId);
    if (!apiKey) throw new ProviderConfigError('key_missing', `「${CAP_SLOTS[cap].label}」尚未配置 API Key`, 400);
    return {
      cap,
      provider: structuredClone(provider),
      model,
      keyId: provider.keyId,
      keyVersion: this.data.keyVersions[provider.keyId] ?? (this.data.keys[provider.keyId] ? 1 : 0),
      apiKey,
    };
  }

  requestSnapshotIsCurrent(snapshot: ProviderRequestSnapshot): boolean {
    const provider = this.providerFor(snapshot.cap);
    const keyVersion = this.data.keyVersions[provider.keyId] ?? (this.data.keys[provider.keyId] ? 1 : 0);
    return provider.id === snapshot.provider.id
      && provider.revision === snapshot.provider.revision
      && provider.keyId === snapshot.keyId
      && keyVersion === snapshot.keyVersion
      && this.currentModel(snapshot.cap) === snapshot.model;
  }

  markVerifiedIfCurrent(snapshot: ProviderRequestSnapshot): boolean {
    if (!this.requestSnapshotIsCurrent(snapshot)) return false;
    this.data.verified[snapshot.cap] = JSON.stringify({
      providerId: snapshot.provider.id,
      model: snapshot.model,
      providerRevision: snapshot.provider.revision,
      keyVersion: snapshot.keyVersion,
    } satisfies VerificationStamp);
    this.persist();
    return true;
  }

  clearVerified(cap: CapId): void {
    if (this.data.verified[cap]) {
      delete this.data.verified[cap];
      this.persist();
    }
  }

  clearVerifiedIfCurrent(snapshot: ProviderRequestSnapshot): void {
    if (this.requestSnapshotIsCurrent(snapshot) && this.data.verified[snapshot.cap]) this.clearVerified(snapshot.cap);
  }

  isVerified(cap: CapId): boolean {
    if (!this.isConfigured(cap)) return false;
    const stored = this.data.verified[cap];
    if (typeof stored === 'string' && stored.startsWith('{')) {
      try {
        const stamp = JSON.parse(stored) as VerificationStamp;
        const provider = this.providerFor(cap);
        return stamp.providerId === provider.id
          && stamp.model === this.currentModel(cap)
          && stamp.providerRevision === provider.revision
          && stamp.keyVersion === (this.data.keyVersions[provider.keyId] ?? (this.data.keys[provider.keyId] ? 1 : 0));
      } catch { return false; }
    }
    // Legacy verification is preserved only for unchanged built-in defaults.
    const provider = this.providerFor(cap);
    const oldExpected = `${provider.id}:${this.currentModel(cap)}`;
    const defaultProvider = CAP_SLOTS[cap].defaultProvider ?? CAP_SLOTS[cap].keyId;
    return provider.builtin && provider.id === defaultProvider
      && (stored === oldExpected || stored === this.currentModel(cap));
  }

  saveProvider(draft: ProviderDraft): ProviderRecord {
    if (draft.cap) return this.saveCapabilityProvider(draft);
    const label = typeof draft.label === 'string' ? draft.label.trim() : '';
    if (!label || label.length > 80) throw new ProviderConfigError('invalid_provider', '请填写不超过 80 个字符的提供商名称');
    if (!['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(draft.protocol)) {
      throw new ProviderConfigError('invalid_protocol', '请选择支持的协议');
    }
    const baseURL = validateProviderBaseURL(draft.baseURL);
    const id = draft.id || `custom-${crypto.randomUUID()}`;
    const existing = this.data.providerCatalog[id];
    if (draft.id && !existing) {
      if (this.providerById(id)?.builtin) throw new ProviderConfigError('builtin_readonly', '内置提供商不可修改；可添加自定义提供商覆盖接口设置');
      throw new ProviderConfigError('provider_missing', '提供商已不存在', 404);
    }
    if (existing?.scopeCap) {
      throw new ProviderConfigError('capability_scope_required', '此配置已限定模型类型，请在所属类型的配置列表中编辑', 409, [existing.scopeCap]);
    }
    const models = normalizeProviderModels(draft.models, draft.protocol);
    const apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
    if (apiKey && /[\r\n\0]/.test(apiKey)) throw new ProviderConfigError('invalid_key', 'Key 包含不支持的控制字符');
    const next: ProviderRecord = {
      id,
      label,
      keyId: `provider:${id}`,
      baseURL,
      protocol: draft.protocol,
      models,
      builtin: false,
      revision: existing?.revision ?? 1,
    };
    const inUse = this.slotsUsingProvider(id).filter((cap) => {
      const currentId = this.data.suppliers[cap] ?? '';
      return !models.some((model) => model.id === currentId && model.capabilities.includes(cap))
        || !providerSupportsCapability(next, cap);
    });
    if (inUse.length) throw new ProviderConfigError('provider_in_use', `当前配置仍被以下能力槽使用：${inUse.map((cap) => CAP_SLOTS[cap].label).join('、')}`, 409, inUse);
    const changed = !!existing && (existing.label !== next.label || existing.baseURL !== next.baseURL
      || existing.protocol !== next.protocol || JSON.stringify(existing.models) !== JSON.stringify(next.models));
    if (changed) next.revision = existing.revision + 1;
    this.data.providerCatalog[id] = next;
    if (changed) this.clearProviderVerification(id);
    if (apiKey) {
      const error = this.writeKey(next.keyId, apiKey);
      if (error) {
        // The preflight above should make this unreachable; retain atomic behavior if key validation changes.
        if (existing) this.data.providerCatalog[id] = existing;
        else delete this.data.providerCatalog[id];
        throw new ProviderConfigError('invalid_key', error);
      }
    }
    this.persist();
    return structuredClone(next);
  }

  private saveCapabilityProvider(draft: ProviderDraft): ProviderRecord {
    const cap = draft.cap as CapId;
    const mode = draft.mode === 'edit' ? 'edit' : 'create';
    if (!CAP_IDS.includes(cap)) throw new ProviderConfigError('invalid_capability', '模型类型无效');
    const label = typeof draft.label === 'string' ? draft.label.trim() : '';
    if (!label || label.length > 80) throw new ProviderConfigError('invalid_provider', '请填写不超过 80 个字符的配置名称');
    if (!['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(draft.protocol)) {
      throw new ProviderConfigError('invalid_protocol', '请选择支持的协议');
    }
    if (!providerSupportsCapability({ protocol: draft.protocol }, cap)) {
      throw new ProviderConfigError('unsupported_capability', `该协议不支持「${CAP_SLOTS[cap].label}」`);
    }
    const baseURL = validateProviderBaseURL(draft.baseURL);
    const models = normalizeProviderModels(draft.models, draft.protocol);
    if (models.length !== 1 || models[0].capabilities.length !== 1 || models[0].capabilities[0] !== cap) {
      throw new ProviderConfigError('invalid_models', '每条配置请选择一个属于当前类型的模型');
    }
    const sourceId = draft.sourceProviderId || draft.id;
    const source = sourceId ? this.providerById(sourceId) : undefined;
    if (sourceId && !source) throw new ProviderConfigError('provider_missing', '所选配置来源已不存在', 404);
    if (mode === 'edit' && (!sourceId || !draft.sourceModel)) {
      throw new ProviderConfigError('invalid_edit_source', '编辑配置需要明确的原配置来源', 400);
    }
    if (mode === 'edit' && source && draft.sourceModel
      && !source.models.some((model) => model.id === draft.sourceModel && model.capabilities.includes(cap))) {
      throw new ProviderConfigError('provider_config_missing', '要编辑的模型配置已不存在', 404);
    }
    const requestedExisting = draft.id ? this.data.providerCatalog[draft.id] : undefined;
    const canUpdate = mode === 'edit' && !!requestedExisting && requestedExisting.scopeCap === cap;
    if (draft.id && !requestedExisting && !source?.builtin) {
      throw new ProviderConfigError('provider_missing', '提供商已不存在', 404);
    }
    const id = canUpdate ? requestedExisting!.id : `custom-${crypto.randomUUID()}`;
    const keyId = `provider:${id}`;
    const apiKey = typeof draft.apiKey === 'string' ? draft.apiKey.trim() : '';
    if (apiKey && /[\r\n\0]/.test(apiKey)) throw new ProviderConfigError('invalid_key', 'Key 包含不支持的控制字符');
    const current = canUpdate ? requestedExisting : undefined;
    const previousModel = mode === 'edit' ? draft.sourceModel : undefined;
    const next: ProviderRecord = {
      id,
      label,
      keyId,
      baseURL,
      protocol: draft.protocol,
      models,
      builtin: false,
      revision: current?.revision ?? 1,
      scopeCap: cap,
    };
    const changed = !!current && (current.label !== next.label || current.baseURL !== next.baseURL
      || current.protocol !== next.protocol || JSON.stringify(current.models) !== JSON.stringify(next.models));
    if (changed) next.revision = current!.revision + 1;
    this.data.providerCatalog[id] = next;

    if (apiKey) {
      const error = this.writeKey(keyId, apiKey);
      if (error) throw new ProviderConfigError('invalid_key', error);
    } else if (!current && source) {
      const sourceKey = this.getKey(source.keyId);
      if (sourceKey) this.writeKey(keyId, sourceKey);
    }

    const refs = this.capabilityConfigRefs(cap);
    if (mode === 'edit' && draft.sourceModel && sourceId) {
      const index = refs.findIndex((ref) => ref.providerId === sourceId && ref.model === draft.sourceModel);
      if (index >= 0) refs.splice(index, 1, { providerId: id, model: models[0].id });
      else if (!refs.some((ref) => ref.providerId === id && ref.model === models[0].id)) refs.push({ providerId: id, model: models[0].id });
    } else if (!refs.some((ref) => ref.providerId === id && ref.model === models[0].id)) {
      refs.push({ providerId: id, model: models[0].id });
    }
    this.writeCapabilityConfigRefs(cap, refs);

    const wasActive = mode === 'edit' && !!previousModel && this.providerId(cap) === sourceId && this.currentModel(cap) === previousModel;
    const updatingActive = mode === 'edit' && !!current && this.providerId(cap) === id;
    if (wasActive || updatingActive) {
      this.data.providers[cap] = id;
      this.data.suppliers[cap] = models[0].id;
      delete this.data.verified[cap];
    } else if (changed && this.providerId(cap) === id) {
      delete this.data.verified[cap];
    }
    this.persist();
    return structuredClone(next);
  }

  deleteProvider(id: string): void {
    const provider = this.data.providerCatalog[id];
    if (!provider) throw new ProviderConfigError('provider_not_deletable', '只能删除自定义提供商', 400);
    const slots = this.slotsUsingProvider(id);
    if (slots.length) throw new ProviderConfigError('provider_in_use', `该提供商正在用于：${slots.map((cap) => CAP_SLOTS[cap].label).join('、')}`, 409, slots);
    delete this.data.providerCatalog[id];
    delete this.data.keys[provider.keyId];
    delete this.data.keyVersions[provider.keyId];
    this.persist();
  }

  setCapability(cap: CapId, providerId: string, modelId: string): string | null {
    const provider = this.providerById(providerId);
    if (!provider || (provider.scopeCap && provider.scopeCap !== cap) || !providerSupportsCapability(provider, cap)) return `该提供商配置不属于「${CAP_SLOTS[cap].label}」或协议不支持该类型`;
    const model = provider.models.find((item) => item.id === modelId && item.capabilities.includes(cap));
    if (!model) return `该模型未勾选「${CAP_SLOTS[cap].label}」能力`;
    this.data.providers[cap] = providerId;
    this.data.suppliers[cap] = modelId;
    delete this.data.verified[cap];
    this.persist();
    return null;
  }

  /** Compatibility endpoint used by older frontend copies. */
  setProvider(cap: CapId, providerId: string): string | null {
    const provider = this.providerById(providerId);
    const current = this.data.suppliers[cap];
    const model = provider?.models.find((item) => item.id === current && item.capabilities.includes(cap))
      ?? provider?.models.find((item) => item.capabilities.includes(cap));
    if (!provider || !model) return `该提供商没有配置「${CAP_SLOTS[cap].label}」模型`;
    return this.setCapability(cap, providerId, model.id);
  }

  setSupplier(cap: CapId, model: string): string | null {
    return this.setCapability(cap, this.providerId(cap), model);
  }

  // ---- 导出根目录（方案 C） ----
  get rootDir(): string | undefined {
    return this.data.rootDir;
  }

  setRootDir(dir: string): void {
    this.data.rootDir = dir;
    this.persist();
  }

  get xhsDownloadDir(): string | undefined {
    const value = this.data.xhsDownloadDir?.trim();
    return value || undefined;
  }

  setXhsDownloadDir(dir: string): void {
    const value = dir.trim();
    if (value) this.data.xhsDownloadDir = value;
    else delete this.data.xhsDownloadDir;
    this.persist();
  }

  // ---- 对外只读摘要（不含明文 Key） ----
  summary() {
    return {
      rootDir: this.data.rootDir ?? null,
      xhsDownloadDir: this.xhsDownloadDir ?? null,
      suppliers: this.data.suppliers,
      providers: this.providers().map((provider) => ({
        id: provider.id,
        label: provider.label,
        portal: provider.portal,
        baseURL: provider.baseURL,
        protocol: provider.protocol,
        models: provider.models,
        builtin: provider.builtin,
        configured: !!this.getKey(provider.keyId),
        keyConfigured: !!this.getKey(provider.keyId),
        revision: provider.revision,
        scopeCap: provider.scopeCap ?? null,
      })),
      caps: CAP_IDS.map((cap) => {
        const selectedProvider = this.providerFor(cap);
        const compatible = this.modelsForCapability(cap);
        const models = compatible.filter(({ provider }) => provider.id === selectedProvider.id).map(({ model }) => model.id);
        const model = this.currentModel(cap);
        return {
        provider: selectedProvider.id,
        providerLabel: selectedProvider.label,
        providerPortal: selectedProvider.portal ?? null,
        providerOptions: this.providers()
          .filter((provider) => providerSupportsCapability(provider, cap) && provider.models.some((item) => item.capabilities.includes(cap)))
          .map((provider) => ({
            id: provider.id,
            label: provider.label,
            portal: provider.portal,
            protocol: provider.protocol,
            models: provider.models.filter((item) => item.capabilities.includes(cap)).map((item) => item.id),
            configured: !!this.getKey(provider.keyId),
          })),
        cap,
        label: CAP_SLOTS[cap].label,
        locked: CAP_SLOTS[cap].locked,
        model,
        alternatives: models.filter((item) => item !== model),
        models,
        modelLabels: Object.fromEntries(selectedProvider.models.filter((item) => item.label).map((item) => [item.id, item.label])),
        configured: this.isConfigured(cap),
        verified: this.isVerified(cap),
        configurations: this.capabilityConfigOptions(cap),
      };
      }),
    };
  }
}

// 单例：后端进程内唯一设置源
export const settings = new SettingsStore();
export type { SettingsStore };
