import fs from 'node:fs';
import path from 'node:path';

type Entry = { expiresAt: number; reason: 'normal' | 'risk_control' };
type Store = Record<string, Entry>;
export type CooldownScope = 'topic' | 'rewrite';

const NORMAL_MS: Record<string, number> = { 抖音: 15 * 60_000, 小红书: 10 * 60_000 };
const RISK_CONTROL_MS = 60 * 60_000;

function filePath(): string {
  const root = process.env.NEWMEDIA_DATA_DIR || path.join(process.cwd(), '.data');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'platform-cooldowns.json');
}

function read(): Store {
  try { return JSON.parse(fs.readFileSync(filePath(), 'utf8')); } catch { return {}; }
}

function write(value: Store): void {
  fs.writeFileSync(filePath(), JSON.stringify(value, null, 2), 'utf8');
}

function entryKey(scope: CooldownScope, platform: string): string {
  return `${scope}:${platform}`;
}

export function cooldownStatus(scope: CooldownScope, platform?: string) {
  const now = Date.now();
  const stored = read();
  const platforms = Object.fromEntries(Object.entries(stored)
    .filter(([name]) => name.startsWith(`${scope}:`))
    .map(([name, entry]) => {
    const remainingSec = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
    return [name.slice(scope.length + 1), { expiresAt: entry.expiresAt, remainingSec, reason: entry.reason }];
  }));
  return platform ? { platform, ...(platforms[platform] || { expiresAt: 0, remainingSec: 0, reason: null }) } : { platforms };
}

export function acquirePlatformAction(scope: CooldownScope, platform: string) {
  const now = Date.now();
  const stored = read();
  const key = entryKey(scope, platform);
  const current = stored[key];
  if (current && current.expiresAt > now) {
    return { ok: false as const, expiresAt: current.expiresAt, remainingSec: Math.ceil((current.expiresAt - now) / 1000), reason: current.reason };
  }
  const expiresAt = now + (NORMAL_MS[platform] || 10 * 60_000);
  stored[key] = { expiresAt, reason: 'normal' };
  write(stored);
  return { ok: true as const, expiresAt, remainingSec: Math.ceil((expiresAt - now) / 1000), reason: 'normal' as const };
}

export function markRiskControl(scope: CooldownScope, platform: string): void {
  const stored = read();
  const expiresAt = Date.now() + RISK_CONTROL_MS;
  const key = entryKey(scope, platform);
  const current = stored[key];
  if (!current || current.expiresAt < expiresAt) {
    stored[key] = { expiresAt, reason: 'risk_control' };
    write(stored);
  }
}

// 仅在请求尚未真正触达平台时撤销冷却，例如本地浏览器服务未能启动。
// 这样不会把工作台自身的故障误算成一次平台访问。
export function releasePlatformAction(scope: CooldownScope, platform: string): void {
  const stored = read();
  const key = entryKey(scope, platform);
  if (stored[key]?.reason === 'normal') {
    delete stored[key];
    write(stored);
  }
}
