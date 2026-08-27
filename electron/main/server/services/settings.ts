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
import { CAP_SLOTS, CapId, getProviderDef, getProviderOptions, validateKeyFormat } from './caps.js';

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
  // 只有后端真实验证成功后才写入；前端切页不会再丢失“已验证”状态。
  verified: Partial<Record<CapId, string>>;
  rootDir?: string; // 导出根目录（方案 C，加密存，见 §5.1）
  xhsDownloadDir?: string; // 小红书图文下载/洗稿解析目录
}

const DEFAULT_SETTINGS: StoredSettings = {
  keys: {},
  verified: {},
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
      const loaded = {
        keys: raw.keys ?? {},
        suppliers: { ...DEFAULT_SETTINGS.suppliers, ...(raw.suppliers ?? {}) },
        providers: { ...DEFAULT_SETTINGS.providers, ...(raw.providers ?? {}) },
        verified: raw.verified ?? {},
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

  // ---- Key ----
  /** 校验 + 加密存入。返回错误信息（null 表示成功） */
  setKey(keyId: string, rawKey: string): string | null {
    const err = validateKeyFormat(keyId, rawKey);
    if (err) return err;
    this.data.keys[keyId] = this.enc.encrypt(rawKey.trim());
    this.persist();
    return null;
  }

  /** 取明文 Key（仅后端请求生命周期内存在，不落日志/不进前端响应） */
  getKey(keyId: string): string | null {
    const cipher = this.data.keys[keyId];
    if (!cipher) return null;
    try {
      return this.enc.decrypt(cipher);
    } catch {
      // 解密失败（机器迁移/密钥丢失）→ 引导重配，不抛异常阻塞
      return null;
    }
  }

  providerId(cap: CapId): string {
    return getProviderDef(cap, this.data.providers[cap]).id;
  }

  providerFor(cap: CapId) {
    return getProviderDef(cap, this.data.providers[cap]);
  }

  currentModel(cap: CapId): string {
    const provider = this.providerFor(cap);
    const chosen = this.data.suppliers[cap];
    const allowed = [provider.defaultModel, ...provider.alternatives];
    return chosen && allowed.includes(chosen) ? chosen : provider.defaultModel;
  }

  /** 按当前供应商写入 Key；同一供应商可被多个能力槽位复用。 */
  setKeyForCap(cap: CapId, rawKey: string): string | null {
    return this.setKey(this.providerFor(cap).keyId, rawKey);
  }

  isConfigured(cap: CapId): boolean {
    return !!this.getKey(this.providerFor(cap).keyId);
  }

  markVerified(cap: CapId): void {
    this.data.verified[cap] = `${this.providerId(cap)}:${this.currentModel(cap)}`;
    this.persist();
  }

  clearVerified(cap: CapId): void {
    if (this.data.verified[cap]) {
      delete this.data.verified[cap];
      this.persist();
    }
  }

  isVerified(cap: CapId): boolean {
    if (!this.isConfigured(cap)) return false;
    const expected = `${this.providerId(cap)}:${this.currentModel(cap)}`;
    if (this.data.verified[cap] === expected) return true;
    // 兼容旧版本只保存模型 ID 的验证记录；仅对默认供应商放行，切换供应商后必须重新验证。
    const defaultProvider = CAP_SLOTS[cap].defaultProvider ?? CAP_SLOTS[cap].keyId;
    return this.providerId(cap) === defaultProvider && this.data.verified[cap] === this.currentModel(cap);
  }

  // ---- 供应商切换 ----
  setProvider(cap: CapId, providerId: string): string | null {
    const def = CAP_SLOTS[cap];
    const options = getProviderOptions(cap);
    if (def.locked) return `${def.label} 槽位已锁定，不可切换`;
    if (!options.length) return `${def.label} 暂不支持切换供应商`;
    const provider = options.find((item) => item.id === providerId);
    if (!provider) return `供应商 ${providerId} 不在 ${def.label} 可选范围内`;
    this.data.providers[cap] = provider.id;
    const allowed = [provider.defaultModel, ...provider.alternatives];
    if (!allowed.includes(this.data.suppliers[cap] ?? '')) this.data.suppliers[cap] = provider.defaultModel;
    delete this.data.verified[cap];
    this.persist();
    return null;
  }

  setSupplier(cap: CapId, model: string): string | null {
    const def = CAP_SLOTS[cap];
    if (def.locked) return `${def.label} 槽位已锁定，不可切换`;
    const provider = this.providerFor(cap);
    const allowed = [provider.defaultModel, ...provider.alternatives];
    if (!allowed.includes(model)) return `模型 ${model} 不在 ${def.label} 可选范围内`;
    this.data.suppliers[cap] = model;
    delete this.data.verified[cap];
    this.persist();
    return null;
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
      caps: (Object.keys(CAP_SLOTS) as CapId[]).map((cap) => ({
        provider: this.providerId(cap),
        providerLabel: this.providerFor(cap).label,
        providerPortal: this.providerFor(cap).portal || null,
        providerOptions: getProviderOptions(cap).map((provider) => ({
          id: provider.id,
          label: provider.label,
          portal: provider.portal,
          models: [provider.defaultModel, ...provider.alternatives],
          modelLabels: provider.modelLabels ?? {},
        })),
        cap,
        label: CAP_SLOTS[cap].label,
        locked: CAP_SLOTS[cap].locked,
        model: this.currentModel(cap),
        alternatives: this.providerFor(cap).alternatives,
        models: [this.providerFor(cap).defaultModel, ...this.providerFor(cap).alternatives],
        modelLabels: this.providerFor(cap).modelLabels ?? {},
        configured: this.isConfigured(cap),
        verified: this.isVerified(cap),
      })),
    };
  }
}

// 单例：后端进程内唯一设置源
export const settings = new SettingsStore();
export type { SettingsStore };
