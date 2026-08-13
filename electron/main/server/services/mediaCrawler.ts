/**
 * MediaCrawler 代理客户端 + 生命周期管理（electron-agnostic）。
 *
 * 设计要点：
 *  - 不论在 Electron 主进程还是纯 Node（npm run dev:server）下都能加载本模块，
 *    因此**不能**在顶部静态 `import { app } from 'electron'`（纯 Node 下会直接崩）。
 *    electron 改为运行时动态 import + try-catch 缓存，取不到就当「非 Electron 环境」。
 *  - Electron 主进程负责：启动独立 Python FastAPI 进程（端口 8091，仅本机）、
 *    轮询 /health 直到就绪、把所有抓取操作代理给它（登录态/二维码/搜索）。
 *  - 纯 Node（dev:server）下同样会拉起代理，只是数据目录回退到 MC_DATA_DIR 或临时目录，
 *    方便用「浏览器本地端口」直接测试整条链路，无需封装。
 *
 * 为什么不用内联 BrowserWindow 做原生抓取？
 *   小红书/抖音对 Electron 内嵌 Chromium 风控极强（error_code=300012 等），
 *   而独立 Playwright Chromium 有头上下文可复用真实登录态、绕过风控。
 *   这条路径经过验证是你（用户）一路修过来的决策，这里忠实执行。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { bundledRuntimeRoot, playwrightBrowsersPath, pythonExecutable, userRuntimeDataDir } from './runtimePaths.js';

const PROXY_PORT = 8091;
const PROXY_HOST = '127.0.0.1';
const PROXY_BASE = `http://${PROXY_HOST}:${PROXY_PORT}`;

let proc: ChildProcess | null = null;
let procStarted = false;

function systemBrowserPath(): string | undefined {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    : process.platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
      : [];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

// ----------------------------------------------------------------
// electron 运行时探测（仅为可选增强；非 Electron 环境下全部走回退逻辑）
// ----------------------------------------------------------------
let _app: any = null;
let _appResolved = false;
async function getApp(): Promise<any | null> {
  if (_appResolved) return _app;
  _appResolved = true;
  try {
    // 纯 Node（tsx/Node）下此处会抛错，被 catch 吞掉 → 返回 null
    const mod = await import('electron');
    _app = (mod as any).app || null;
  } catch {
    _app = null;
  }
  return _app;
}

/** 代理数据目录：优先 MC_DATA_DIR，其次 Electron userData，最后项目内 .mc-data */
function dataDir(): string {
  if (process.env.MC_DATA_DIR) {
    fs.mkdirSync(process.env.MC_DATA_DIR, { recursive: true });
    return process.env.MC_DATA_DIR;
  }
  // 在 Electron 内则复用 userData，否则落到项目本地目录（便于浏览器测试复用登录态）
  if (_app) {
    try {
      const d = _app.getPath('userData');
      fs.mkdirSync(d, { recursive: true });
      return d;
    } catch {
      /* fallthrough */
    }
  }
  const d = path.join(process.cwd(), '.mc-data');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 返回 venv python 可执行文件绝对路径 */
async function venvPython(): Promise<string> {
  const bundled = await bundledRuntimeRoot();
  if (bundled) return pythonExecutable(path.join(bundled, 'media-crawler', 'venv'));
  return path.join(
    process.env.HOME || process.env.USERPROFILE || os.homedir(),
    '.workbuddy',
    'binaries',
    'python',
    'envs',
    'media-crawler',
    'bin',
    process.platform === 'win32' ? 'python.exe' : 'python',
  );
}

/** 找到 server.py：开发时直接用项目 tools 目录，打包后用 extraResources 复制出的资源 */
async function serverScript(app: any): Promise<string> {
  const candidates: string[] = [];
  const bundled = await bundledRuntimeRoot();
  if (bundled) candidates.push(path.join(bundled, 'media-crawler', 'proxy', 'server.py'));
  // 开发态：项目根 tools 目录（npm run dev:server 时 cwd 即项目根）
  if (process.env.NODE_ENV === 'development' || !app || !app.isPackaged) {
    candidates.push(path.join(process.cwd(), 'tools', 'media-crawler', 'server.py'));
  }
  if (app) {
    candidates.push(path.join(app.getAppPath(), '..', 'tools', 'media-crawler', 'server.py'));
    candidates.push(path.join(app.getPath('exe'), '..', '..', 'Resources', 'tools', 'media-crawler', 'server.py'));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // 都没找到就返回第一个候选，让后续 spawn 抛出明确错误
  return candidates[0] || path.join(process.cwd(), 'tools', 'media-crawler', 'server.py');
}

function logFile(name: string): string {
  const d = path.join(dataDir(), 'logs');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, name);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function portReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${PROXY_BASE}/health`, { timeout: 800 }, (res) => {
      resolve(res.statusCode === 200);
      res.resume();
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForReady(deadlineMs = 25000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (await portReady()) return;
    await sleep(600);
  }
  throw new Error('MediaCrawler 代理启动超时（端口 8091 无响应）');
}

export async function startMediaCrawler(): Promise<void> {
  if (procStarted || proc) return;
  // 端口已被占用且健康：直接复用（方便开发时手动起代理）
  if (await portReady()) {
    procStarted = true;
    console.log('[main] MediaCrawler 代理端口 8091 已就绪，直接复用');
    return;
  }
  const app = await getApp();
  const python = await venvPython();
  const script = await serverScript(app);
  if (!fs.existsSync(python)) {
    throw new Error(`MediaCrawler venv 未找到：${python}。请先运行安装脚本或重新创建 venv。`);
  }
  if (!fs.existsSync(script)) {
    throw new Error(`MediaCrawler server.py 未找到：${script}`);
  }

  const out = fs.openSync(logFile('mc-proxy-out.log'), 'a');
  const err = fs.openSync(logFile('mc-proxy-err.log'), 'a');

  const bundled = await bundledRuntimeRoot();
  const runtimeData = await userRuntimeDataDir();
  console.log(`[mc] 启动代理：python=${python} script=${script} headless=${process.env.MC_HEADLESS ?? '0'}`);
  proc = spawn(
    python,
    [script, '--port', String(PROXY_PORT), '--host', PROXY_HOST],
    {
      env: {
        ...process.env,
        MC_DATA_DIR: dataDir(),
        // 与正式上游 MediaCrawler 共用其专用抖音浏览器 profile；这是一个
        // 独立于用户日常 Chrome 的目录，只复用用户已完成的工作台登录。
        MC_DOUYIN_PROFILE_DIR: path.join(runtimeData, 'douyin-profile'),
        MC_HEADLESS: process.env.MC_HEADLESS ?? '0',
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
        ...(systemBrowserPath() ? { MC_BROWSER_EXECUTABLE_PATH: systemBrowserPath() } : {}),
      },
      detached: false,
      stdio: ['ignore', out, err],
    },
  );
  procStarted = true;

  proc.on('exit', (code) => {
    console.log(`[mc] proxy exited ${code}`);
    proc = null;
    procStarted = false;
  });

  await waitForReady();
}

export async function stopMediaCrawler(): Promise<void> {
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    await sleep(800);
    if (proc && !proc.killed) proc.kill('SIGKILL');
  }
  proc = null;
  procStarted = false;
}

async function proxyFetch<T>(pathname: string, init?: RequestInit, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
  } catch (error: any) {
    if (error?.name === 'AbortError') throw new Error('MediaCrawler 视频读取超时，请稍后重试');
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as any)?.error || `MediaCrawler 代理错误 ${res.status}`;
    throw new Error(err);
  }
  return data as T;
}

// ---------------- 代理 API ----------------

export interface McStatus {
  ok: boolean;
  headless: boolean;
  dataDir: string;
  platforms: string[];
}

export async function mcHealth(): Promise<McStatus> {
  return proxyFetch('/health');
}

export async function mcLoginStatus(): Promise<{ platforms: Record<string, boolean> }> {
  return proxyFetch('/login/status');
}

export interface McQrResult {
  connected: boolean;
  qr: string | null;
  headful: boolean;
  error?: string | null;
}

export async function mcLoginQr(platform: string): Promise<McQrResult> {
  return proxyFetch('/login/qr', { method: 'POST', body: JSON.stringify({ platform }) });
}

export interface McSessionResult {
  connected: boolean;
  error?: string | null;
}

export async function mcLoginSession(platform: string): Promise<McSessionResult> {
  return proxyFetch(`/login/session?platform=${encodeURIComponent(platform)}`);
}

export async function mcSyncCookies(platform: string, cookies: string): Promise<{ ok: boolean; count?: number; error?: string }> {
  return proxyFetch('/login/cookies', { method: 'POST', body: JSON.stringify({ platform, cookies }) });
}

export async function mcLogout(platform: string): Promise<{ ok: boolean }> {
  return proxyFetch('/logout', { method: 'POST', body: JSON.stringify({ platform }) });
}

export interface McSearchResult {
  items: Array<{ t: string; l: string; c: string; tags: string[]; url?: string; nickname?: string }>;
  live: boolean;
  reason?: string | null;
  message?: string | null;
}

export interface McVideoFramesResult {
  title?: string;
  description?: string;
  frames?: string[];
  error?: string;
  code?: string;
}

export interface McVideoDetailResult {
  title?: string;
  desc?: string;
  cover?: string;
  error?: string;
  code?: 'risk_control' | 'no_result' | 'unsupported';
  mediaFiles?: string[];
}

/**
 * 使用上游 MediaCrawler 的详情模式读取单条视频。
 * 它会复用项目既有的抖音登录配置，避免本地代理与上游浏览器争抢同一 profile 锁。
 */
export async function upstreamVideoDetail(platform: string, link: string): Promise<McVideoDetailResult> {
  const config = platform === '抖音'
    ? { key: 'dy', folder: 'douyin', id: link.match(/\/video\/(\d+)/)?.[1], idField: 'aweme_id' }
    : platform === '小红书'
      ? { key: 'xhs', folder: 'xhs', id: link.match(/\/(?:item|explore)\/([a-zA-Z0-9]+)/)?.[1], idField: 'note_id' }
      : null;
  if (!config) return { error: `暂不支持「${platform}」内容详情采集`, code: 'unsupported' };
  // 抖音短链（v.douyin.com/...）的 aweme_id 由 MediaCrawler 内部解析，
  // 不能在这里要求链接本身已经包含 /video/数字ID。小红书仍需从 URL 提取 note_id。
  if (!config.id && platform !== '抖音') return { error: `未能从${platform}链接中识别内容 ID` };
  const root = await upstreamRoot();
  if (!fs.existsSync(path.join(root, 'main.py'))) return { error: 'MediaCrawler 上游组件未安装' };
  const outputRoot = await upstreamDataRoot(root);
  const file = path.join(outputRoot, config.folder, 'json', `detail_contents_${today()}.json`);
  const previousMtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  try {
    const output = await run(await venvPython(), [
      'main.py',
      '--platform', config.key,
      '--type', 'detail',
      '--specified_id', link,
      '--save_data_option', 'json',
      '--save_data_path', outputRoot,
      '--get_comment', 'false',
      '--headless', 'false',
    ], root, {
      // 抖音下载改由 wechat-mp-tools 负责；MediaCrawler 只为小红书读取图文。
      MC_GET_MEDIA: platform === '小红书' ? '1' : '0',
    });
    if (/account blocked|账号.*(风控|限制)|risk control/i.test(output)) {
      return { code: 'risk_control', error: '抖音账号当前触发风控，暂无法读取视频内容。建议暂停操作并间隔一段时间后再试。' };
    }
    if (!fs.existsSync(file) || fs.statSync(file).mtimeMs <= previousMtime) {
      return { error: '未获得本次链接的视频详情，请确认抖音浏览器登录态后重试', code: 'no_result' };
    }
    const items = JSON.parse(fs.readFileSync(file, 'utf8'));
    const item = (Array.isArray(items) ? items : []).slice().reverse().find((row: any) => !config.id || String(row[config.idField] || row.aweme_id || row.video_id || '') === config.id);
    if (!item) return { error: '视频详情采集未返回对应内容，请稍后重试', code: 'no_result' };
    const itemId = String(item[config.idField] || item.aweme_id || item.video_id || '').trim();
    if (!itemId) return { error: '视频详情缺少内容 ID，请稍后重试', code: 'no_result' };
    return {
      title: String(item.title || '').trim(),
      desc: String(item.desc || item.content || '').trim(),
      cover: String(item.video_cover_url || item.cover_url || ''),
      mediaFiles: (platform === '小红书' ? ['images'] : ['images', 'videos']).flatMap((kind) => {
        const dir = path.join(outputRoot, config.folder, kind, itemId);
        try { return fs.readdirSync(dir).map((name) => path.join(dir, name)); } catch { return []; }
      }),
    };
  } catch (error: any) {
    return { error: error?.message || '视频详情采集失败' };
  }
}

export async function mcVideoFrames(platform: string, link: string): Promise<McVideoFramesResult> {
  return proxyFetch('/video/frames', {
    method: 'POST',
    body: JSON.stringify({ platform, link }),
  }, 35_000);
}

const UPSTREAM_PLATFORM: Record<string, string> = { 抖音: 'dy', 小红书: 'xhs' };

async function upstreamRoot(): Promise<string> {
  const bundled = await bundledRuntimeRoot();
  return bundled ? path.join(bundled, 'media-crawler', 'upstream') : path.join(process.cwd(), 'tools', 'MediaCrawler');
}

async function upstreamDataRoot(sourceRoot: string): Promise<string> {
  const bundled = await bundledRuntimeRoot();
  if (!bundled) return path.join(sourceRoot, 'data');
  const root = path.join(await userRuntimeDataDir(), 'media-crawler-data');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function sharedDouyinCookie(): string {
  const candidates = [
    process.env.WECHAT_MP_TOOLS_SETTINGS,
    path.join(os.homedir(), 'Library', 'Application Support', 'WeChat MP Tools', 'data', 'app_settings.json'),
  ].filter(Boolean) as string[];
  for (const file of candidates) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (typeof settings?.douyin_cookie === 'string' && settings.douyin_cookie.trim()) return settings.douyin_cookie.trim();
    } catch { /* 外部工具尚未安装或尚未完成登录 */ }
  }
  return '';
}

async function syncSharedDouyinCookie(): Promise<void> {
  const cookie = sharedDouyinCookie();
  if (!cookie) return;
  try {
    await mcSyncCookies('抖音', cookie);
    console.log('[mc] 已复用 wechat-mp-tools 的抖音登录态');
  } catch (error: any) {
    console.warn('[mc] 抖音登录态同步失败：', error?.message || error);
  }
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function run(command: string, args: string[], cwd: string, extraEnv?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'pipe', env: { ...process.env, ...extraEnv } });
    let output = '';
    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(output.slice(-1200) || `MediaCrawler exited ${code}`)));
  });
}

function fullCount(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString('en-US') : String(value);
}

/** 调用上游 NanmiCoder/MediaCrawler 的一次关键词任务，并读取其 JSON 输出。 */
export async function upstreamSearch(platform: string, kw: string, limit = 20): Promise<McSearchResult> {
  const key = UPSTREAM_PLATFORM[platform];
  const root = await upstreamRoot();
  if (!key || !fs.existsSync(path.join(root, 'main.py'))) {
    return { items: [], live: false, reason: 'upstream_missing', message: 'MediaCrawler 上游组件未安装' };
  }
  try {
    const dataPlatform = key === 'dy' ? 'douyin' : 'xhs';
    const outputRoot = await upstreamDataRoot(root);
    const file = path.join(outputRoot, dataPlatform, 'json', `search_contents_${today()}.json`);
    // 上游 JSON 默认会按日期追加；一次网页搜索只应读取本次任务结果。
    if (fs.existsSync(file)) fs.unlinkSync(file);
    await run(await venvPython(), [
      'main.py',
      '--platform', key,
      '--type', 'search',
      '--keywords', kw,
      '--save_data_option', 'json',
      '--save_data_path', outputRoot,
      '--crawler_max_notes_count', String(limit),
      '--get_comment', 'false',
      // 抖音/小红书当前会拦截无头浏览器，保持可见浏览器以复用登录态并降低风控。
      '--headless', 'false',
    ], root);
    if (!fs.existsSync(file)) {
      return {
        items: [],
        live: false,
        reason: 'no_result',
        message: `未获取到「${platform}」搜索结果。请确认自动打开的浏览器已完成登录或安全验证后重试。`,
      };
    }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const seen = new Set<string>();
    const items = (Array.isArray(raw) ? raw : []).map((it: any) => ({
      t: String(it.title || it.desc || it.content || '').trim(),
      l: fullCount(it.liked_count),
      c: fullCount(it.comment_count),
      tags: [],
      url: String(it.note_url || it.aweme_url || it.url || ''),
      nickname: String(it.nickname || ''),
    })).filter((it: any) => {
      if (!it.t || seen.has(it.url || it.t)) return false;
      seen.add(it.url || it.t);
      return true;
    }).slice(0, limit);
    return { items, live: items.length > 0, reason: items.length ? null : 'no_result', message: items.length ? null : '未获得搜索内容' };
  } catch (error: any) {
    return { items: [], live: false, reason: 'upstream_error', message: error?.message || 'MediaCrawler 搜索失败' };
  }
}

export async function mcSearch(platform: string, kw: string, limit = 20): Promise<McSearchResult> {
  // 搜索也可以作为工作台启动后的第一个抓取动作，不能依赖用户先进入设置页。
  await startMediaCrawler();
  // 仅在用户明确开始搜索时才把外部工具的抖音 Cookie 注入浏览器。
  // 注入会首次创建可见浏览器窗口；不能在应用启动或本地 AI 识别时触发，
  // 否则用户会看到无内容的 about:blank 窗口。
  await syncSharedDouyinCookie();
  return proxyFetch(
    `/search?platform=${encodeURIComponent(platform)}&kw=${encodeURIComponent(kw)}&limit=${limit}`,
    undefined,
    // 首次搜索可能需要用户在弹出的同一窗口完成一次验证码；不能在 30 秒时
    // 中断请求并误报为失败。浏览器会保持打开，结果完成后会自动返回。
    90_000,
  );
}

// 仅在 Electron 运行时注册退出钩子（纯 Node 下 app 为 null，跳过）
getApp().then((app) => {
  if (app?.on) {
    app.on('before-quit', () => {
      stopMediaCrawler().catch(() => {});
    });
  }
});
