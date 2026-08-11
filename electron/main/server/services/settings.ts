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
import { CAP_SLOTS, CapId, validateKeyFormat } from './caps.js';

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
  // 只有后端真实验证成功后才写入；前端切页不会再丢失“已验证”状态。
  verified: Partial<Record<CapId, string>>;
  rootDir?: string; // 导出根目录（方案 C，加密存，见 §5.1）
}

const DEFAULT_SETTINGS: StoredSettings = {
  keys: {},
  verified: {},
  suppliers: Object.fromEntries(
    (Object.keys(CAP_SLOTS) as CapId[]).map((c) => [c, CAP_SLOTS[c].defaultModel]),
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
        verified: raw.verified ?? {},
        rootDir: raw.rootDir,
      };
      // 旧版本的 image 槽位被固定为 gpt-image-1；将这一历史默认值迁移为新版默认。
      if (loaded.suppliers.image === 'gpt-image-1') {
        loaded.suppliers.image = 'gpt-image-2';
        delete loaded.verified.image;
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

  isConfigured(cap: CapId): boolean {
    return !!this.getKey(CAP_SLOTS[cap].keyId);
  }

  markVerified(cap: CapId): void {
    this.data.verified[cap] = this.data.suppliers[cap] ?? CAP_SLOTS[cap].defaultModel;
    this.persist();
  }

  clearVerified(cap: CapId): void {
    if (this.data.verified[cap]) {
      delete this.data.verified[cap];
      this.persist();
    }
  }

  isVerified(cap: CapId): boolean {
    const expectedModel = this.data.suppliers[cap] ?? CAP_SLOTS[cap].defaultModel;
    return this.isConfigured(cap) && this.data.verified[cap] === expectedModel;
  }

  // ---- 供应商切换 ----
  setSupplier(cap: CapId, model: string): string | null {
    const def = CAP_SLOTS[cap];
    if (def.locked) return `${def.label} 槽位已锁定，不可切换`;
    const allowed = [def.defaultModel, ...def.alternatives];
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

  // ---- 对外只读摘要（不含明文 Key） ----
  summary() {
    return {
      rootDir: this.data.rootDir ?? null,
      suppliers: this.data.suppliers,
      caps: (Object.keys(CAP_SLOTS) as CapId[]).map((cap) => ({
        cap,
        label: CAP_SLOTS[cap].label,
        locked: CAP_SLOTS[cap].locked,
        model: this.data.suppliers[cap] ?? CAP_SLOTS[cap].defaultModel,
        alternatives: CAP_SLOTS[cap].alternatives,
        configured: this.isConfigured(cap),
        verified: this.isVerified(cap),
      })),
    };
  }
}

// 单例：后端进程内唯一设置源
export const settings = new SettingsStore();
export type { SettingsStore };
