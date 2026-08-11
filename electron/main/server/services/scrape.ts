// M4 抓取服务：委托 MediaCrawler 代理（有头 Playwright）。
//
// 设计要点：
//  - 之前 Electron 原生 BrowserWindow 方案被平台风控（小红书 error_code=300012 / IP 风险），
//    且弹窗二维码容易被误判为已登录导致窗口秒关。
//  - 现在改为独立的 Playwright 有头浏览器代理（tools/media-crawler/ 的 FastAPI :8091），
//    登录态持久化在代理自己的 Chromium profile 里，Electron 只负责「拉起代理 + 转发请求」。
//  - 登录流程：设置页点击「登录」→ 后端 POST /login/qr 打开有头浏览器、抓取二维码 →
//    前端弹出二维码图片让用户扫描 → 轮询 /login/session 直到登录入口消失、关键 cookie 存在。
//  - 搜索：后端通过 /search 委托代理，代理优先拦截平台自己的搜索 API JSON（无需逆向签名），
//    API 失败再 DOM 兜底。未登录或风控时返回明确错误，不再静默返回假内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  mcHealth,
  mcLoginStatus,
  mcLoginQr,
  mcLoginSession,
  mcSearch,
  mcVideoFrames,
  upstreamVideoDetail,
  startMediaCrawler,
  type McQrResult,
  type McSessionResult,
  type McSearchResult,
} from './mediaCrawler.js';
import { recognize, type VisionPart } from './aiProxy.js';
import { acquirePlatformAction, markRiskControl } from './cooldown.js';
import { localMediaToVisionParts } from './localMedia.js';
import { extractHttpUrl } from './link.js';

// ---- 平台配置（与代理 / 前端用中文名契约） ----
export const SCRAPE_PLATFORMS = ['抖音', '小红书', '微博', '知乎'] as const;
export type ScrapePlatform = (typeof SCRAPE_PLATFORMS)[number];

const HOSTS: Record<string, string> = {
  抖音: 'douyin.com',
  小红书: 'xiaohongshu.com',
  微博: 'weibo.com',
  知乎: 'zhihu.com',
};
// 视频型平台（链接模式按视频走多模态识别）
const VIDEO_HOSTS = ['douyin.com', 'bilibili.com', 'kuaishou.com'];

export class ScrapeError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = 'ScrapeError';
    this.code = code;
    this.status = status;
  }
}

// ---- 数据目录（与 settings/library 同根） ----
function dataDir(): string {
  const base = process.env.NEWMEDIA_DATA_DIR || path.join(process.cwd(), '.data');
  fs.mkdirSync(base, { recursive: true });
  return base;
}
function cookieFile(): string {
  return path.join(dataDir(), 'scrape.json');
}
type CookieJar = Record<string, any[]>;

function loadCookies(): CookieJar {
  try {
    return JSON.parse(fs.readFileSync(cookieFile(), 'utf8'));
  } catch {
    return {};
  }
}

/** 该平台是否已持有旧版原生 cookie（保留兼容，MediaCrawler 代理独立维护 profile） */
export function hasSession(platform: string): boolean {
  const jar = loadCookies();
  return Array.isArray(jar[platform]) && jar[platform].length > 0;
}

/** 各平台登录态 + MediaCrawler 代理是否就绪 */
export async function status(): Promise<{ electron: boolean; platforms: Record<string, boolean> }> {
  try {
    const st = await mcLoginStatus();
    return { electron: true, platforms: st.platforms };
  } catch {
    // 代理未启动/不可用
    return { electron: false, platforms: Object.fromEntries(SCRAPE_PLATFORMS.map((p) => [p, false])) };
  }
}

// ---- MediaCrawler 代理登录 ----

export async function loginQr(platform: string): Promise<McQrResult> {
  if (!SCRAPE_PLATFORMS.includes(platform as any)) {
    throw new ScrapeError('unsupported', `暂不支持「${platform}」登录`);
  }
  // 标准安装包可能在首次引导后才装好运行环境；此处按需拉起代理。
  await startMediaCrawler();
  return mcLoginQr(platform);
}

export async function loginSession(platform: string): Promise<McSessionResult> {
  if (!SCRAPE_PLATFORMS.includes(platform as any)) {
    throw new ScrapeError('unsupported', `暂不支持「${platform}」登录`);
  }
  return mcLoginSession(platform);
}

/** 兼容旧契约：POST /api/scrape/login 直接触发登录流程，
 *  但现在只返回「是否已登录」；真正二维码由 /api/scrape/login/qr 提供。 */
export async function login(platform: string): Promise<{ ok: boolean; connected: boolean }> {
  const r = await loginSession(platform);
  if (r.connected) return { ok: true, connected: true };
  // 未登录：不直接弹窗（避免旧版秒关 bug），由前端调用 /login/qr 展示二维码
  return { ok: true, connected: false };
}

// ---- 链接抓取（公开内容；登录态由 MediaCrawler 代理自行维护，这里不再读本地 jar） ----
interface FetchResult {
  status: number;
  contentType: string;
  body: Buffer;
}

async function fetchUrl(url: string, _platform?: string): Promise<FetchResult> {
  const headers: Record<string, string> = { 'user-agent': 'Mozilla/5.0 (compatible; NewMediaWorkbench/1.0)' };
  const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  const buf = Buffer.from(await resp.arrayBuffer());
  return { status: resp.status, contentType: resp.headers.get('content-type') || '', body: buf };
}

export type MediaType = 'image' | 'video' | 'article';

/** 依链接推断媒体类型（初版启发式） */
export function detectMediaType(link: string): MediaType {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return 'article';
  }
  const pathname = u.pathname.toLowerCase();
  const host = u.hostname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(pathname)) return 'image';
  if (/\.(mp4|mov|webm|m4v)$/i.test(pathname)) return 'video';
  if (VIDEO_HOSTS.some((h) => host.includes(h))) return 'video';
  return 'article';
}

/** 手动粘贴链接时从域名推断平台，导入选题表的来源仅作为备用。 */
export function detectPlatform(link: string): ScrapePlatform | undefined {
  try {
    const host = new URL(link).hostname.toLowerCase();
    if (host.includes('douyin.com')) return '抖音';
    if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) return '小红书';
    if (host.includes('weibo.com')) return '微博';
    if (host.includes('zhihu.com')) return '知乎';
  } catch { /* invalid link is handled by caller */ }
  return undefined;
}

interface RecognizeLinkResult {
  mediaType: MediaType;
  recog: string;
  title?: string;
  model?: string;
  needLogin?: boolean;
  message?: string;
  sourceId?: string;
  feedback?: SourceFeedback;
}

export interface SourceFeedback {
  tone: 'success' | 'warning' | 'danger';
  title: string;
  items: string[];
}

interface AcquiredSource {
  id: string;
  mediaType: MediaType;
  platform?: string;
  title?: string;
  desc?: string;
  text?: string;
  files: string[];
  parts?: VisionPart[];
  feedback: SourceFeedback;
}

const sourceCache = new Map<string, AcquiredSource>();

function rememberSource(source: Omit<AcquiredSource, 'id'>): AcquiredSource {
  const saved = { ...source, id: randomUUID() };
  sourceCache.set(saved.id, saved);
  while (sourceCache.size > 20) sourceCache.delete(sourceCache.keys().next().value as string);
  return saved;
}

function fileStats(files: string[]): { images: string[]; videos: string[]; bytes: number } {
  const images = imageFiles(files);
  const videos = files.filter((file) => VIDEO_FILE.test(file));
  const bytes = [...images, ...videos].reduce((total, file) => {
    try { return total + fs.statSync(file).size; } catch { return total; }
  }, 0);
  return { images, videos, bytes };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function bytesOf(files: string[]): number {
  return files.reduce((total, file) => {
    try { return total + fs.statSync(file).size; } catch { return total; }
  }, 0);
}

const IMAGE_FILE = /\.(jpe?g|png|webp)$/i;
const VIDEO_FILE = /\.(mp4|mov|webm|m4v)$/i;

function imageFiles(files: string[]): string[] {
  return files.filter((file) => IMAGE_FILE.test(file));
}

function hasVideoFile(files: string[]): boolean {
  return files.some((file) => VIDEO_FILE.test(file));
}

/**
 * 链接模式多模态识别：抓取链接 → 按媒体类型识别成「稿件」。
 *  - image：字节 → visionImg(GLM-4V) 识别
 *  - article：HTML → 抽取标题+正文（无需视觉模型，无 Key 也可跑）
 *  - video：需登录态抓取直链/字节，初版返回引导（needLogin）
 */
export async function recognizeLink(input: string, platform?: string): Promise<RecognizeLinkResult> {
  const link = extractHttpUrl(input);
  if (!link) throw new ScrapeError('bad_link', '未找到可识别的 http(s) 链接，请粘贴平台分享文本或完整链接');
  if (!/^https?:\/\//i.test(link)) throw new ScrapeError('bad_link', '链接须以 http(s):// 开头');
  const mediaType = detectMediaType(link);
  const resolvedPlatform = detectPlatform(link) || platform;
  // 平台内容读取（图文、视频均包含）共用同一冷却；普通外部文章不受此限制。
  if (resolvedPlatform) {
    const permit = acquirePlatformAction('rewrite', resolvedPlatform);
    if (!permit.ok) {
      throw new ScrapeError('cooldown', `为降低风控风险，「${resolvedPlatform}」请在 ${permit.remainingSec} 秒后再进行链接识别`, 429);
    }
  }

  if (mediaType === 'image') {
    const { body, contentType } = await fetchUrl(link, platform);
    if (body.length === 0) throw new ScrapeError('empty', '图片抓取为空');
    if (!contentType.startsWith('image/')) {
      throw new ScrapeError('not_image', `链接返回的不是图片（${contentType}）`);
    }
    const mime = contentType.split(';')[0];
    const data = body.toString('base64');
    const source = rememberSource({
      mediaType: 'image',
      files: [],
      parts: [{ type: 'image', data, mime }],
      feedback: { tone: 'success', title: '图片来源读取成功', items: [`图片：1 张`, `数据大小：${formatBytes(body.length)}`, '下一步：确认来源无误后，进入 AI 识别稿件'] },
    });
    return { mediaType: 'image', recog: '', sourceId: source.id, feedback: source.feedback };
  }

  if (mediaType === 'article') {
    // 小红书内容页是客户端渲染，普通 HTTP 抓取只会得到空壳页面；改走详情采集。
    if (resolvedPlatform === '小红书') {
      const detail = await upstreamVideoDetail(resolvedPlatform, link);
      if (detail.desc || detail.title || detail.mediaFiles?.length) {
        const files = detail.mediaFiles || [];
        const stats = fileStats(files);
        const hasText = Boolean(detail.title || detail.desc);
        const source = rememberSource({
          mediaType: 'article',
          platform: resolvedPlatform,
          title: detail.title,
          desc: detail.desc,
          files: stats.images,
          feedback: {
            tone: hasText || stats.images.length ? 'success' : 'danger',
            title: hasText || stats.images.length ? '小红书图文来源读取成功' : '小红书图文来源读取不完整',
            items: [`文字：${hasText ? '已读取' : '未读取'}`, `图片：${stats.images.length} 张，${formatBytes(bytesOf(stats.images))}`, '视频：当前不下载、不识别小红书视频。', '下一步：确认来源无误后，进入 AI 识别稿件'],
          },
        });
        return {
          mediaType: 'article',
          recog: '',
          title: detail.title || undefined,
          sourceId: source.id,
          feedback: source.feedback,
        };
      }
      if (detail.code === 'risk_control') {
        markRiskControl('rewrite', resolvedPlatform);
        throw new ScrapeError('risk_control', detail.error || '小红书账号当前触发风控，请稍后重试', 429);
      }
    }
    const { body, contentType } = await fetchUrl(link, platform);
    if (!contentType.includes('text/html')) throw new ScrapeError('not_html', `链接不是网页（${contentType}）`);
    const html = body.toString('utf-8');
    const title = extractTitle(html) || '';
    const text = extractText(html);
    if (!text.trim()) throw new ScrapeError('empty_text', '未能从网页抽取到正文');
    const source = rememberSource({
      mediaType: 'article',
      text,
      title,
      files: [],
      feedback: { tone: 'success', title: '网页文字读取成功', items: [`文字：已读取 ${text.length} 个字符`, '图片：未读取', '下一步：确认来源无误后，进入 AI 识别稿件'] },
    });
    return { mediaType: 'article', recog: '', title, sourceId: source.id, feedback: source.feedback };
  }

  if (!resolvedPlatform) throw new ScrapeError('platform_required', '未能从链接识别来源平台，请使用抖音或小红书的完整内容链接', 400);
  // 详情模式优先：MediaCrawler 可直接返回视频标题和发布文案，稳定性高于
  // 同一浏览器 profile 下的实时截图；其内容足以进入后续人工校对与改写。
  const detail = await upstreamVideoDetail(resolvedPlatform, link);
  if (detail.desc || detail.title || detail.mediaFiles?.length) {
    const files = detail.mediaFiles || [];
    const stats = fileStats(files);
    const downloaded = stats.videos.length > 0 && stats.bytes > 0;
    const source = rememberSource({
      mediaType: 'video',
      platform: resolvedPlatform,
      title: detail.title,
      desc: detail.desc,
      files: stats.videos,
      feedback: {
        tone: downloaded ? 'success' : 'danger',
        title: downloaded ? '抖音视频下载成功' : '抖音视频未下载成功',
        items: [`视频文件：${stats.videos.length} 个`, `文件大小：${formatBytes(stats.bytes)}`, `文字：${detail.title || detail.desc ? '已读取' : '未读取'}`, '下一步：确认来源无误后，进入 AI 识别稿件'],
      },
    });
    return {
      mediaType: 'video',
      recog: '',
      title: detail.title || undefined,
      sourceId: source.id,
      feedback: source.feedback,
    };
  }
  // 平台已明确风控时停止截图兜底，避免重复访问加重限制。
  if (detail.code === 'risk_control') {
    markRiskControl('rewrite', resolvedPlatform);
    throw new ScrapeError('risk_control', detail.error || '抖音账号当前触发风控，请稍后重试', 429);
  }
  const extracted = await mcVideoFrames(resolvedPlatform, link);
  if (extracted.error || !extracted.frames?.length) {
    throw new ScrapeError(extracted.code || 'video_extract_failed', detail.error || extracted.error || '未能提取视频关键画面', 502);
  }
  const parts = extracted.frames.slice(0, 4).map((data) => ({ type: 'image' as const, data, mime: 'image/jpeg' }));
  const context = [extracted.title && `页面标题：${extracted.title}`, extracted.description && `页面简介：${extracted.description}`]
    .filter(Boolean)
    .join('\n');
  try {
    // GLM-4.6V-Flash 支持多图理解且免费，优先用于四帧整合识别。
    const source = rememberSource({
      mediaType: 'video', platform: resolvedPlatform, title: extracted.title, files: [], parts,
      feedback: { tone: 'warning', title: '已读取视频关键画面，但未保存视频文件', items: ['视频文件：0 个', `关键画面：${parts.length} 帧`, '这不是视频下载成功；确认来源阶段后再进入 AI 识别。'] },
    });
    return { mediaType: 'video', recog: '', title: extracted.title || undefined, sourceId: source.id, feedback: source.feedback };
  } catch {
    // 账号尚未开放新模型时，以已验证的免费单图模型降级，避免转而消耗千问额度。
    const source = rememberSource({
      mediaType: 'video', platform: resolvedPlatform, title: extracted.title, files: [], parts,
      feedback: { tone: 'warning', title: '已读取视频关键画面，但未保存视频文件', items: ['视频文件：0 个', `关键画面：${parts.length} 帧`, '这不是视频下载成功；确认来源阶段后再进入 AI 识别。'] },
    });
    return { mediaType: 'video', recog: '', title: extracted.title || undefined, sourceId: source.id, feedback: source.feedback };
  }
}

/** 第二阶段：只有用户确认来源检查通过后，才进入视觉/文字识别。 */
export async function recognizeSource(sourceId: string): Promise<RecognizeLinkResult> {
  const source = sourceCache.get(sourceId);
  if (!source) throw new ScrapeError('source_expired', '来源检查结果已失效，请重新检查稿件来源');
  if (source.text && source.files.length === 0) {
    return { mediaType: source.mediaType, recog: [`标题：${source.title || '未命名稿件'}`, `正文：${source.text}`].join('\n'), title: source.title, model: '网页文字读取', sourceId, feedback: source.feedback };
  }
  let parts = source.parts || [];
  if (!parts.length && source.files.length) {
    // 小红书图文需逐张描述，保留下载到本地的全部图片；视频仍控制为少量关键帧以节省额度。
    parts = await localMediaToVisionParts(source.files, source.platform === '小红书' ? { maxImages: Number.MAX_SAFE_INTEGER } : undefined);
  }
  if (!parts.length) throw new ScrapeError('source_empty', '来源已检查，但没有可交给 AI 识别的图片或视频画面');
  const isXhsImages = source.platform === '小红书' && source.mediaType === 'image';
  if (isXhsImages) {
    // 图片编号与文案区块由后端固定生成，不能依赖模型输出编号；
    // 单图调用可确保 OCR 不会把相邻图片合并、错位或跳号。
    const outputs: string[] = [];
    let model = '';
    for (let index = 0; index < parts.length; index += 1) {
      const result = await recognize({
        cap: 'visionImg',
        parts: [parts[index]],
        user: [
          '只识别这一张图片，不要添加图片序号、标题、总结或 Markdown 代码块。',
          '先判断是否存在清晰可读的文字：',
          '1. 有文字时，只输出“文字（OCR）：”后接完整可辨认文字；保留标题、正文、数字、链接和标识，不要概括成“图中有一段文字”，也不要追加画面描述。',
          '2. 没有可读文字时，只输出“画面描述：”后接客观画面描述；不要猜测人物身份、品牌或图片外事实。',
        ].join('\n'),
      });
      model = result.model;
      const content = result.text
        .trim()
        .replace(/^#第\d+张图\s*/u, '')
        .replace(/^第\d+张图[：:]?\s*/u, '');
      outputs.push(`#第${index + 1}张图\n${content}`);
    }
    // 文案来自原工具下载的文案.txt，直接保留可避免二次改写、遗漏或模型臆造。
    outputs.push(`#文案\n${source.text || '（未读取到文案文件）'}`);
    return { mediaType: source.mediaType, recog: outputs.join('\n\n'), title: source.title, model, sourceId, feedback: source.feedback };
  }
  const result = await recognize({
    cap: 'visionImg',
    // 跟随设置页的视觉模型；不能在这里硬编码另一型号，否则保存/验证的配置与实际调用不一致。
    parts,
    user: source.mediaType === 'video'
      ? '请结合这些视频关键画面与发布文案，补充人物、场景、步骤、产品和关键信息。不要臆造画面中没有出现的事实。'
      : '请识别这些笔记图片，补充画面信息、关键步骤和产品/人物信息。',
  });
  const prefix = [`标题：${source.title || '未命名稿件'}`, source.desc ? `正文：${source.desc}` : ''].filter(Boolean).join('\n');
  return { mediaType: source.mediaType, recog: `${prefix}${prefix ? '\n' : ''}画面识别：${result.text}`, title: source.title, model: result.model, sourceId, feedback: source.feedback };
}

/** 将 wechat-mp-tools 已下载的抖音视频纳入当前洗稿任务。 */
export function importDouyinVideo(filePath: string, title?: string): RecognizeLinkResult {
  const normalized = path.resolve(filePath || '');
  const roots = [
    process.env.WECHAT_MP_TOOLS_DOWNLOAD_DIR,
    path.join(os.homedir(), 'Library', 'Application Support', 'WeChat MP Tools', 'data', 'douyin_downloads'),
  ].filter(Boolean).map((item) => path.resolve(item as string));
  if (!roots.some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`))) {
    throw new ScrapeError('invalid_download_path', '下载文件不在 wechat-mp-tools 的抖音下载目录中');
  }
  if (!VIDEO_FILE.test(normalized) || !fs.existsSync(normalized)) {
    throw new ScrapeError('download_missing', '未找到 wechat-mp-tools 下载的视频文件');
  }
  const stat = fs.statSync(normalized);
  if (!stat.isFile() || stat.size <= 0) throw new ScrapeError('download_empty', '下载的视频文件为空');
  const source = rememberSource({
    mediaType: 'video',
    platform: '抖音',
    title,
    files: [normalized],
    feedback: {
      tone: 'success',
      title: '抖音解析成功',
      items: ['下载工具：wechat-mp-tools', '视频文件：1 个', `视频大小：${formatBytes(stat.size)}`, '下一步：点击「开始洗稿」进入 AI 识别与改写'],
    },
  });
  return { mediaType: 'video', recog: '', title, sourceId: source.id, feedback: source.feedback };
}

/** 将 wechat-mp-tools 下载的小红书图文目录（图片 + 文案.txt）纳入当前洗稿任务。 */
export function importXhsNote(noteDir: string, title?: string): RecognizeLinkResult {
  const normalized = path.resolve(noteDir || '');
  // 下载工具有两种合法运行形态：用户已安装的桌面版，以及工作台自动拉起的
  // 项目内置服务。两者的数据根目录不同，但均为受控本机目录。
  const toolRoot = path.resolve(process.env.WECHAT_MP_TOOLS_ROOT || path.join(process.cwd(), 'tools', 'wechat-mp-tools'));
  const roots = [
    process.env.WECHAT_MP_TOOLS_XHS_DOWNLOAD_DIR,
    path.join(os.homedir(), 'Library', 'Application Support', 'WeChat MP Tools', 'data', 'xhs_downloads'),
    path.join(toolRoot, 'data', 'xhs_downloads'),
  ].filter(Boolean).map((root) => path.resolve(root as string));
  if (!roots.some((root) => normalized !== root && normalized.startsWith(`${root}${path.sep}`))) {
    throw new ScrapeError('invalid_download_path', '下载目录不在已配置的 wechat-mp-tools 小红书图文目录中');
  }
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new ScrapeError('download_missing', '未找到 wechat-mp-tools 下载的小红书图文目录');
  }
  const files = fs.readdirSync(normalized)
    .map((name) => path.join(normalized, name))
    .filter((file) => {
      try { return fs.statSync(file).isFile() && IMAGE_FILE.test(file); } catch { return false; }
    })
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const textPath = path.join(normalized, '文案.txt');
  const text = fs.existsSync(textPath) ? fs.readFileSync(textPath, 'utf8').trim() : '';
  if (!files.length && !text) throw new ScrapeError('download_empty', '小红书图文目录中未找到图片或文案.txt');
  const source = rememberSource({
    mediaType: 'image',
    platform: '小红书',
    title,
    text,
    files,
    feedback: {
      tone: 'success',
      title: '小红书图文解析成功',
      items: [`图片：${files.length} 张，${formatBytes(bytesOf(files))}`, `文案：${text ? '已读取' : '未读取'}`, '下一步：点击「AI 识别内容」逐图读取图片和文案'],
    },
  });
  return { mediaType: 'image', recog: '', title, sourceId: source.id, feedback: source.feedback };
}

// ---- 轻量 HTML 抽取（不引第三方依赖） ----
function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decodeEntities(og[1]);
  const t = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return t ? decodeEntities(t[1].trim()) : '';
}
function extractText(html: string): string {
  let s = html.replace(/<(script|style|noscript|svg|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  return s.slice(0, 6000);
}
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

// ---- 热榜/搜索：全部委托 MediaCrawler 代理 ----
export async function fetchHot(platform?: string): Promise<any[] | null> {
  // 热榜暂不单独实现；返回 null 让路由回退样本或空结果
  return null;
}

export async function fetchSearch(platform: string, kw: string): Promise<McSearchResult> {
  // 搜索统一由同一套有头浏览器代理处理：它保存设置页登录的 profile，
  // 也能让用户在同一窗口完成验证码。绝不能回退到上游 CLI；两套 Playwright
  // 浏览器内核和 profile 不同，会丢失登录态并显示无关的安装报错。
  try {
    return await mcSearch(platform, kw, 20);
  } catch (error: any) {
    return {
      items: [],
      live: false,
      reason: 'proxy_unavailable',
      message: `搜索浏览器暂未就绪：${error?.message || '请稍后重试'}`,
    };
  }
}
