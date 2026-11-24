import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { CapId, LibFile, ProviderProtocol, SettingsSummary } from '../store/appStore';
import { isTauriRuntime, tauriInvoke, tauriListen } from './tauriBridge';

export interface BrowserInfo {
  found: boolean;
  name: string | null;
  path: string | null;
}

export interface LegacyInstallInfo {
  detected: boolean;
  dataDir: string | null;
  hasSettings: boolean;
  runtimeBytes: number;
}

export interface SystemHealth {
  ok: boolean;
  appVersion: string;
  os: string;
  arch: string;
  dataDir: string;
  pythonRequired: boolean;
  browser: BrowserInfo;
  legacy: LegacyInstallInfo;
}

export interface ProviderDraftRequest {
  id?: string;
  mode?: 'create' | 'edit';
  cap?: CapId;
  sourceProviderId?: string;
  sourceModel?: string;
  label: string;
  baseURL: string;
  protocol: ProviderProtocol;
  apiKey?: string;
  models: { id: string; label?: string; capabilities: CapId[] }[];
}

export interface ProviderModelListResponse {
  models: string[];
  fetchedAt: string;
}

export interface QrResp {
  connected: boolean;
  qr: string | null;
  headful: boolean;
  error?: string | null;
}

export interface SessionResp {
  connected: boolean;
  error?: string | null;
}

export interface VerifyResp {
  ok: boolean;
  model?: string;
  error?: string;
  settings?: SettingsSummary;
}

export interface RuntimeSetupResp {
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

export interface ChutuResp {
  images?: { b64: string }[];
  model?: string;
  usedEdit?: boolean;
  provider?: 'api' | 'codex';
  error?: string;
}

export interface TishiciResp {
  ok?: boolean;
  outText?: string;
  outImg?: string;
  outImgs?: string[];
  parseMode?: string;
  note?: string;
  text?: string;
  img?: string;
  imgs?: string[];
  mode?: string;
  model?: string;
  error?: string;
}

export interface XigaoResp {
  out?: string;
  recog?: string;
  model?: string;
  error?: string;
}

export interface PlatformCooldowns {
  platforms?: Record<string, { expiresAt: number; remainingSec: number; reason: 'normal' | 'risk_control' | null }>;
}

export interface LibraryResp {
  rootDir: string | null;
  missingFolders: ('选题' | '创意' | '洗稿' | '图片')[];
  ready: boolean;
  files: LibFile[];
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function getApiBase(): Promise<string> {
  return '';
}

export const api = {
  isDesktop: isTauriRuntime,
  listen: tauriListen,

  getHealth: async (): Promise<SystemHealth> => {
    if (!isTauriRuntime()) {
      return {
        ok: true,
        appVersion: '1.0.0-alpha.1 (Web 预览)',
        os: 'browser',
        arch: 'web',
        dataDir: '浏览器预览模式',
        pythonRequired: false,
        browser: { found: false, name: null, path: null },
        legacy: { detected: false, dataDir: null, hasSettings: false, runtimeBytes: 0 },
      };
    }
    return tauriInvoke<SystemHealth>('get_system_health');
  },

  openExternalUrl: async (url: string): Promise<void> => {
    const trimmed = (url || '').trim();
    if (!/^https?:\/\//i.test(trimmed)) return;
    if (isTauriRuntime()) {
      try {
        await tauriInvoke('open_external_url', { url: trimmed });
      } catch {
        await openUrl(trimmed);
      }
      return;
    }
    window.open(trimmed, '_blank', 'noopener,noreferrer');
  },

  // ---- 四能力 AI 设置与安全存储 ----
  getSettings: () => tauriInvoke<SettingsSummary>('get_settings'),

  setKey: async (cap: CapId, key: string) => {
    const current = await tauriInvoke<SettingsSummary>('get_settings');
    const slot = current.caps.find((c) => c.cap === cap);
    if (!slot?.provider) throw new Error('未找到当前能力对应的供应商');
    await tauriInvoke('set_provider_key', { providerId: slot.provider, key });
    return {};
  },

  setProvider: async (cap: CapId, provider: string) => {
    const current = await tauriInvoke<SettingsSummary>('get_settings');
    const p = current.providers.find((item) => item.id === provider);
    const firstModel = p?.models.find((m) => m.capabilities.includes(cap))?.id || p?.models[0]?.id || '';
    await tauriInvoke('set_capability', { cap, providerId: provider, model: firstModel });
    return {};
  },

  setSupplier: async (cap: CapId, model: string) => {
    const current = await tauriInvoke<SettingsSummary>('get_settings');
    const slot = current.caps.find((c) => c.cap === cap);
    if (!slot?.provider) throw new Error('未找到当前能力对应的供应商');
    await tauriInvoke('set_capability', { cap, providerId: slot.provider, model });
    return {};
  },

  setCapability: async (cap: CapId, providerId: string, model: string) => {
    await tauriInvoke('set_capability', { cap, providerId, model });
    return {};
  },

  saveProvider: (provider: ProviderDraftRequest) =>
    tauriInvoke<{ ok: boolean; providerId: string; settings: SettingsSummary }>('save_provider', { draft: provider }),

  setProviderKey: (providerId: string, key: string) =>
    tauriInvoke<{ ok: boolean; settings: SettingsSummary }>('set_provider_key', { providerId, key }),

  deleteProvider: async (_providerId: string) => {
    const settings = await tauriInvoke<SettingsSummary>('get_settings');
    return { ok: true, settings };
  },

  deleteCapabilityConfig: (cap: CapId, providerId: string, model: string) =>
    tauriInvoke<{ ok: boolean; settings: SettingsSummary }>('delete_capability_config', { cap, providerId, model }),

  fetchProviderModels: (
    provider: Pick<ProviderDraftRequest, 'id' | 'baseURL' | 'protocol' | 'apiKey'>,
    _signal?: AbortSignal,
  ) => tauriInvoke<ProviderModelListResponse>('fetch_provider_models', { req: provider }),

  setRootDir: async (rootDir: string) => {
    await tauriInvoke('set_root_dir', { rootDir });
    return {};
  },

  setXhsDownloadDir: async (xhsDownloadDir: string) => {
    const res = await tauriInvoke<{ ok: boolean; settings: SettingsSummary }>('set_xhs_download_dir', {
      xhsDownloadDir: xhsDownloadDir || null,
    });
    return { ok: res.ok, xhsDownloadDir: res.settings.xhsDownloadDir, synced: true };
  },

  verifyCap: (cap: CapId) => tauriInvoke<VerifyResp>('verify_capability', { cap }),

  // Rust 原生版零 Python 运行时：直接反映本机浏览器引擎探测状态
  runtimeStatus: async (): Promise<RuntimeSetupResp> => {
    const health = await api.getHealth();
    return {
      packaged: isTauriRuntime(),
      ready: health.browser.found,
      installing: false,
      phase: health.browser.found ? '已就绪' : '需安装浏览器',
      message: health.browser.found
        ? `Rust 原生架构已就绪（零 Python 依赖，自动复用本机 ${health.browser.name}）。`
        : '未检测到本机 Chrome 或 Edge，请安装任一浏览器以启用抖音/小红书采集能力。',
      components: [
        { id: 'rust-core', label: 'Rust 原生内核', ready: true, detail: '已内建（零 Python）' },
        {
          id: 'browser',
          label: '本机浏览器引擎',
          ready: health.browser.found,
          detail: health.browser.found ? `复用 ${health.browser.name}` : '未检测到 Chrome / Edge',
        },
      ],
    };
  },

  installRuntime: async (): Promise<RuntimeSetupResp> => api.runtimeStatus(),

  // ---- AI 业务能力（创意 / 提示词 / 洗稿 / 出图） ----
  genTishici: (body: any) => tauriInvoke<TishiciResp>('gen_tishici', { req: body }),
  xigaoRecognize: (body: any) => tauriInvoke<XigaoResp>('xigao_recognize', { req: body }),
  xigaoRewrite: (body: any) => tauriInvoke<XigaoResp>('xigao_rewrite', { req: body }),
  creativeDirections: (body: { link: string; title: string; integration: string }) =>
    tauriInvoke<{ directions?: string[]; model?: string; error?: string }>('creative_directions', { req: body }),
  creativeGenerate: (body: { link: string; title: string; integration: string; direction: string; requirement?: string }) =>
    tauriInvoke<{ out?: string; model?: string; error?: string }>('creative_generate', { req: body }),
  creativeOptimize: (body: { content: string; hint: string }) =>
    tauriInvoke<{ out?: string; model?: string; error?: string }>('creative_optimize', { req: body }),
  chutu: (body: any) => {
    const rawRefs = Array.isArray(body?.refImgs)
      ? body.refImgs
      : body?.refImg
        ? [{ type: 'image', data: body.refImg, mime: 'image/png' }]
        : [];
    return tauriInvoke<ChutuResp>('chutu_generate', {
      req: {
        prompt: body?.prompt || '',
        provider: body?.provider || 'api',
        size: body?.size,
        quality: body?.quality,
        optimizeHint: body?.optimizeHint,
        refImgs: rawRefs.map((item: any) => ({
          type: item?.type || 'image',
          data: item?.data || '',
          mime: item?.mime || 'image/png',
        })),
      },
    });
  },
  chutuProviders: () =>
    tauriInvoke<{ codex: { available: boolean; message: string; version?: string }; api: { available: boolean; message: string } }>(
      'chutu_providers',
    ),

  // ---- 本地素材库（纯 Rust 磁盘扫描 + docx/xlsx 导出解析） ----
  listLibrary: () => tauriInvoke<LibraryResp>('list_library'),
  setLibraryRoot: (rootDir: string) => tauriInvoke<LibraryResp>('set_library_root', { rootDir }),
  initializeLibrary: () => tauriInvoke<LibraryResp>('initialize_library'),
  openLibraryFile: (folder: string, name: string, reveal = false) =>
    tauriInvoke<{ ok: boolean }>('open_library_file', { folder, name, reveal }),
  readLibraryImageDataUrl: (folder: string, name: string) =>
    tauriInvoke<string>('read_library_image_data_url', { folder, name }),

  chooseLibraryRoot: async (): Promise<string | null> => {
    if (!isTauriRuntime()) return null;
    const selected = await open({ directory: true, multiple: false, title: '选择本地素材库目录' });
    return typeof selected === 'string' ? selected : null;
  },

  chooseXhsDownloadDir: async (): Promise<string | null> => {
    if (!isTauriRuntime()) return null;
    const selected = await open({ directory: true, multiple: false, title: '选择小红书解析下载目录' });
    return typeof selected === 'string' ? selected : null;
  },

  getAppVersion: async (): Promise<string> => {
    const h = await api.getHealth();
    return h.appVersion;
  },

  checkForUpdates: async () => ({ ok: false, reason: 'Phase 6 将接入 Tauri Updater 双源自动更新' }),
  getUpdateStatus: async (): Promise<UpdateStatus> => ({ phase: 'idle', percent: 0 }),
  onUpdateStatus: (_callback: (status: UpdateStatus) => void) => () => {},

  exportLib: async (body: { folder: string; name: string; kind: string; content?: string; data?: string; topics?: any[] }): Promise<{ ok: boolean; files: LibFile[]; error?: string }> => {
    const res = await tauriInvoke<LibraryResp>('export_library_file', { payload: body });
    return { ok: true, files: res.files };
  },

  downloadWord: async (body: { name: string; content: string }) => {
    const res = await tauriInvoke<{ fileName: string; base64: string }>('build_word_download', {
      name: body.name,
      content: body.content,
    });
    return base64ToBlob(
      res.base64,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  },

  /** 系统原生「另存为」导出 Excel（macOS / Windows 双平台可靠落盘） */
  saveTopicsExcel: async (defaultName: string, topics: any[]): Promise<string | null> => {
    const cleanName = defaultName.endsWith('.xlsx') ? defaultName : `${defaultName}.xlsx`;
    const filePath = await save({
      title: '导出选题表 Excel',
      defaultPath: cleanName,
      filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
    });
    if (!filePath) return null;
    await tauriInvoke('save_topics_xlsx', { path: filePath, topics });
    return filePath;
  },

  /** 系统原生「另存为」导出 Word（替代在 WKWebView 中失效的 <a download>） */
  saveWordFile: async (defaultName: string, content: string): Promise<string | null> => {
    const cleanName = defaultName.endsWith('.docx') ? defaultName : `${defaultName}.docx`;
    const filePath = await save({
      title: '导出 Word 文档',
      defaultPath: cleanName,
      filters: [{ name: 'Word 文档', extensions: ['docx'] }],
    });
    if (!filePath) return null;
    await tauriInvoke('save_word_docx', { path: filePath, content });
    return filePath;
  },

  /** 系统原生「另存为」导出图片 */
  saveImageFile: async (defaultName: string, b64OrDataUrl: string): Promise<string | null> => {
    const cleanName = /\.(png|jpe?g|webp)$/i.test(defaultName) ? defaultName : `${defaultName}.png`;
    const filePath = await save({
      title: '保存图片',
      defaultPath: cleanName,
      filters: [{ name: 'PNG 图片', extensions: ['png'] }],
    });
    if (!filePath) return null;
    await tauriInvoke('save_image_base64', { path: filePath, data: b64OrDataUrl });
    return filePath;
  },

  parseWord: (body: { name: string; data: string }) =>
    tauriInvoke<{ text?: string; error?: string }>('parse_word_base64', { name: body.name, data: body.data }),

  readLibraryWord: (folder: string, name: string) =>
    tauriInvoke<{ text?: string; error?: string }>('read_library_word', { folder, name }),

  // ---- 热榜（优先聚焦抖音 + 小红书，Rust 整点缓存） ----
  getHot: async (platform?: string): Promise<any> => {
    if (platform) {
      const items = await tauriInvoke<any[]>('get_hot_rank_by_platform', { platform });
      return { items, live: true };
    }
    const all = await tauriInvoke<{ items: Record<string, any[]>; failed: string[]; hourKey: string }>('get_hot_ranks');
    return { items: all.items, failed: all.failed, live: true, message: all.failed?.length ? `部分平台拉取失败：${all.failed.join('、')}` : undefined };
  },

  // ---- Phase 3 已接通：Rust 原生 CDP 引擎（零 Python / 零 Playwright） ----
  getSearch: (kw: string, platform: string): Promise<any> =>
    tauriInvoke('search_content', { kw, platform }),
  scrapeStatus: (): Promise<{ electron: boolean; platforms: Record<string, boolean> }> =>
    tauriInvoke('scrape_status'),
  scrapeCooldowns: (scope: 'topic' | 'rewrite'): Promise<PlatformCooldowns> =>
    tauriInvoke('scrape_cooldowns', { scope }),
  scrapeLogin: (platform: string): Promise<{ ok: boolean; connected: boolean; platforms: Record<string, boolean>; error?: string }> =>
    tauriInvoke('scrape_login', { platform }),
  scrapeLoginQr: (platform: string): Promise<QrResp> =>
    tauriInvoke('scrape_login_qr', { platform }),
  scrapeLoginSession: (platform: string): Promise<SessionResp> =>
    tauriInvoke('scrape_login_session', { platform }),
  scrapeLogout: (platform: string): Promise<boolean> =>
    tauriInvoke('scrape_logout', { platform }),
  openVerifyWindow: (platform: string, kw?: string): Promise<boolean> =>
    tauriInvoke('open_verify_window', { platform, kw: kw || null }),

  // ---- Phase 4 已接通：Rust 原生抖音/小红书无水印下载器与来源识别（彻底替代 wechat-mp-tools） ----
  xigaoRecognizeLink: (body: { link: string; platform?: string }): Promise<any> =>
    tauriInvoke('xigao_recognize_link', { link: body.link }),
  xigaoDouyinStart: (link: string): Promise<any> =>
    tauriInvoke('xigao_douyin_start', { link }),
  xigaoDouyinStatus: (taskId: string): Promise<any> =>
    tauriInvoke('xigao_douyin_status', { taskId }),
  xigaoDouyinSource: (body: { path: string; title?: string }): Promise<any> =>
    tauriInvoke('xigao_douyin_source', { path: body.path, title: body.title ?? null }),
  xigaoXhsStart: (link: string): Promise<any> =>
    tauriInvoke('xigao_xhs_start', { link }),
  xigaoXhsStatus: (taskId: string): Promise<any> =>
    tauriInvoke('xigao_xhs_status', { taskId }),
  xigaoXhsSource: (body: { path: string; title?: string }): Promise<any> =>
    tauriInvoke('xigao_xhs_source', { path: body.path, title: body.title ?? null }),
  xigaoRecognizeSource: (sourceId: string): Promise<any> =>
    tauriInvoke('xigao_recognize_source', { sourceId }),
};
