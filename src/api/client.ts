// 前端 → 本地后端（loopback）调用封装。Key 永不经过此处（仅 configured 布尔）。
// 单一事实源：BACKEND-PATH §6.6 / §3.3 / §2.5 / §4.2
import type { CapId } from '../../electron/main/server/services/caps';
import type { CapSummary, LibFile } from '../store/appStore';

declare global {
  interface Window {
    api?: {
      getApiBase: () => Promise<string>;
      getAppVersion?: () => Promise<string>;
      chooseLibraryRoot?: () => Promise<string | null>;
      chooseXhsDownloadDir?: () => Promise<string | null>;
      checkForUpdates?: () => Promise<{ ok: boolean; reason?: string }>;
      getUpdateStatus?: () => Promise<UpdateStatus>;
      onUpdateStatus?: (callback: (status: UpdateStatus) => void) => () => void;
    };
  }
}

async function base(): Promise<string> {
  if (typeof window !== 'undefined' && (window as any).api?.getApiBase) {
    return await (window as any).api.getApiBase();
  }
  return 'http://127.0.0.1:8787';
}

export async function getApiBase(): Promise<string> { return base(); }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const b = await base();
  const r = await fetch(`${b}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    // 后端错误为 { error, code }；转为 Error 后，页面才能稳定展示真实原因。
    throw new Error(err?.error || r.statusText || '请求失败');
  }
  return r.json() as Promise<T>;
}

interface SettingsResp {
  rootDir: string | null;
  xhsDownloadDir: string | null;
  suppliers: Record<string, string>;
  caps: CapSummary[];
}
interface BasicResp {
  error?: string;
}
interface QrResp {
  connected: boolean;
  qr: string | null;
  headful: boolean;
  error?: string | null;
}
interface SessionResp {
  connected: boolean;
  error?: string | null;
}
interface VerifyResp {
  ok: boolean;
  model?: string;
  error?: string;
}
interface RuntimeSetupResp {
  packaged: boolean;
  ready: boolean;
  installing: boolean;
  phase: string;
  message: string;
  components: { id: string; label: string; ready: boolean; detail: string }[];
}
export interface UpdateStatus {
  phase: 'idle' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  percent: number;
  transferred?: number;
  total?: number;
  version?: string;
  message?: string;
}
interface ChutuResp {
  images?: { b64: string }[];
  model?: string;
  usedEdit?: boolean;
  provider?: 'api' | 'codex';
  error?: string;
}
interface TishiciResp {
  ok?: boolean;
  outText?: string;
  outImg?: string;
  outImgs?: string[];
  parseMode?: string;
  text?: string;
  img?: string;
  imgs?: string[]; // 兼容旧响应字段
  mode?: string;
  model?: string;
  error?: string;
}
interface XigaoResp {
  out?: string;
  model?: string;
  error?: string;
}
interface CreativeDirectionsResp { directions?: string[]; model?: string; error?: string; }
interface CreativeGenerateResp { out?: string; model?: string; error?: string; }
export interface PlatformCooldowns {
  platforms?: Record<string, { expiresAt: number; remainingSec: number; reason: 'normal' | 'risk_control' | null }>;
}

export const api = {
  getSettings: () => req<SettingsResp>('/api/settings'),
  setKey: (cap: CapId, key: string) => req<BasicResp>('/api/settings/key', { method: 'POST', body: JSON.stringify({ cap, key }) }),
  setProvider: (cap: CapId, provider: string) => req<BasicResp>('/api/settings/provider', { method: 'POST', body: JSON.stringify({ cap, provider }) }),
  setSupplier: (cap: CapId, model: string) => req<BasicResp>('/api/settings/supplier', { method: 'POST', body: JSON.stringify({ cap, model }) }),
  setRootDir: (rootDir: string) => req<BasicResp>('/api/settings/rootdir', { method: 'POST', body: JSON.stringify({ rootDir }) }),
  setXhsDownloadDir: (xhsDownloadDir: string) => req<{ ok: boolean; xhsDownloadDir: string | null; synced?: boolean }>('/api/settings/xhs-download-dir', { method: 'POST', body: JSON.stringify({ xhsDownloadDir }) }),
  verifyCap: (cap: CapId) => req<VerifyResp>('/api/settings/verify', { method: 'POST', body: JSON.stringify({ cap }) }),
  runtimeStatus: () => req<RuntimeSetupResp>('/api/settings/runtime'),
  installRuntime: () => req<RuntimeSetupResp>('/api/settings/runtime/install', { method: 'POST' }),
  genTishici: (body: any) => req<TishiciResp>('/api/ai/tishici', { method: 'POST', body: JSON.stringify(body) }),
  xigaoRecognize: (body: any) => req<XigaoResp>('/api/ai/xigao/recognize', { method: 'POST', body: JSON.stringify(body) }),
  xigaoRewrite: (body: any) => req<XigaoResp>('/api/ai/xigao/rewrite', { method: 'POST', body: JSON.stringify(body) }),
  creativeDirections: (body: { link: string; title: string; integration: string }) => req<CreativeDirectionsResp>('/api/ai/creative/directions', { method: 'POST', body: JSON.stringify(body) }),
  creativeGenerate: (body: { link: string; title: string; integration: string; direction: string; requirement?: string }) => req<CreativeGenerateResp>('/api/ai/creative/generate', { method: 'POST', body: JSON.stringify(body) }),
  creativeOptimize: (body: { content: string; hint: string }) => req<CreativeGenerateResp>('/api/ai/creative/optimize', { method: 'POST', body: JSON.stringify(body) }),
  chutu: (body: any) => req<ChutuResp>('/api/ai/chutu', { method: 'POST', body: JSON.stringify(body) }),
  chutuProviders: () => req<{ codex: { available: boolean; message: string; version?: string }; api: { available: boolean; message: string } }>('/api/ai/chutu/providers'),
  // M3 素材库本地直写
  listLibrary: () => req<{ rootDir: string | null; missingFolders: ('选题' | '创意' | '洗稿' | '图片')[]; ready: boolean; files: LibFile[] }>('/api/library'),
  setLibraryRoot: (rootDir: string) => req<{ rootDir: string | null; missingFolders: ('选题' | '创意' | '洗稿' | '图片')[]; ready: boolean; files: LibFile[] }>('/api/library/root', { method: 'POST', body: JSON.stringify({ rootDir }) }),
  initializeLibrary: () => req<{ rootDir: string | null; missingFolders: ('选题' | '创意' | '洗稿' | '图片')[]; ready: boolean; files: LibFile[] }>('/api/library/initialize', { method: 'POST' }),
  openLibraryFile: (folder: string, name: string, reveal = false) => req<{ ok: boolean }>('/api/library/open', { method: 'POST', body: JSON.stringify({ folder, name, reveal }) }),
  chooseLibraryRoot: () => window.api?.chooseLibraryRoot ? window.api.chooseLibraryRoot() : Promise.resolve(null),
  chooseXhsDownloadDir: () => window.api?.chooseXhsDownloadDir ? window.api.chooseXhsDownloadDir() : Promise.resolve(null),
  getAppVersion: () => window.api?.getAppVersion ? window.api.getAppVersion() : Promise.resolve('开发版'),
  checkForUpdates: () => window.api?.checkForUpdates
    ? window.api.checkForUpdates()
    : Promise.resolve({ ok: false, reason: 'not-packaged' }),
  getUpdateStatus: () => window.api?.getUpdateStatus
    ? window.api.getUpdateStatus()
    : Promise.resolve({ phase: 'idle', percent: 0 } as UpdateStatus),
  onUpdateStatus: (callback: (status: UpdateStatus) => void) => window.api?.onUpdateStatus?.(callback) || (() => {}),
  exportLib: (body: { folder: string; name: string; kind: string; content?: string; data?: string; topics?: any[] }) =>
    req<{ ok: boolean; files: LibFile[]; error?: string }>('/api/library/export', { method: 'POST', body: JSON.stringify(body) }),
  downloadWord: async (body: { name: string; content: string }) => {
    const b = await base();
    const r = await fetch(`${b}/api/library/word-download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: r.statusText }));
      throw new Error(err?.error || r.statusText || 'Word 导出失败');
    }
    return r.blob();
  },
  parseWord: (body: { name: string; data: string }) =>
    req<{ text?: string; error?: string }>('/api/library/parse-word', { method: 'POST', body: JSON.stringify(body) }),
  readLibraryWord: (folder: string, name: string) =>
    req<{ text?: string; error?: string }>(`/api/library/read-word?folder=${encodeURIComponent(folder)}&name=${encodeURIComponent(name)}`),
  // M3 内容数据源（真实抓取见 M4；response 带 live 标记）
  getHot: (platform?: string) =>
    req<any>(`/api/content/hot${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`),
  getSearch: (kw: string, platform: string) =>
    req<any>(`/api/content/search?kw=${encodeURIComponent(kw)}&platform=${encodeURIComponent(platform)}`),
  // M4 抓取：链接模式识别 + 登录态
  xigaoRecognizeLink: (body: { link: string; platform?: string }) =>
    req<any>('/api/ai/xigao/recognize-link', { method: 'POST', body: JSON.stringify(body) }),
  xigaoDouyinStart: (link: string) =>
    req<any>('/api/ai/xigao/douyin-download/start', { method: 'POST', body: JSON.stringify({ link }) }),
  xigaoDouyinStatus: (taskId: string) => req<any>(`/api/ai/xigao/douyin-download/status/${encodeURIComponent(taskId)}`),
  xigaoDouyinSource: (body: { path: string; title?: string }) =>
    req<any>('/api/ai/xigao/douyin-source', { method: 'POST', body: JSON.stringify(body) }),
  xigaoXhsStart: (link: string) =>
    req<any>('/api/ai/xigao/xhs-download/start', { method: 'POST', body: JSON.stringify({ link }) }),
  xigaoXhsStatus: (taskId: string) => req<any>(`/api/ai/xigao/xhs-download/status/${encodeURIComponent(taskId)}`),
  xigaoXhsSource: (body: { path: string; title?: string }) =>
    req<any>('/api/ai/xigao/xhs-source', { method: 'POST', body: JSON.stringify(body) }),
  xigaoRecognizeSource: (sourceId: string) =>
    req<any>('/api/ai/xigao/recognize-source', { method: 'POST', body: JSON.stringify({ sourceId }) }),
  scrapeStatus: () => req<{ electron: boolean; platforms: Record<string, boolean> }>('/api/scrape/status'),
  scrapeCooldowns: (scope: 'topic' | 'rewrite') => req<PlatformCooldowns>(`/api/scrape/cooldowns?scope=${scope}`),
  scrapeLogin: (platform: string) =>
    req<{ ok: boolean; connected: boolean; platforms: Record<string, boolean>; error?: string }>('/api/scrape/login', {
      method: 'POST',
      body: JSON.stringify({ platform }),
    }),
  // MediaCrawler 二维码弹窗登录
  scrapeLoginQr: (platform: string) =>
    req<QrResp>('/api/scrape/login/qr', { method: 'POST', body: JSON.stringify({ platform }) }),
  scrapeLoginSession: (platform: string) =>
    req<SessionResp>(`/api/scrape/login/session?platform=${encodeURIComponent(platform)}`),
};
