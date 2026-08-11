// 单一事实源：BACKEND-PATH §6.8（调用实现策略）
//  - §6.8.1 统一 openai SDK，按能力切 baseURL + apiKey（四家全 OpenAI 兼容）
//  - §6.8.2 v1 一次性返回（非流式）
//  - §6.8.3 aiProxy 职责：路由 / 拼请求体 / 失败重试 / 限频 / 错误码归一
//
// image 能力经 AIHubMix 中转（base_url=https://aihubmix.com/v1），仅出图走中转；
// text / vision 走各原生供应商。Key 从加密 settings 取，前端永不持有。

import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CAP_SLOTS, CapId } from './caps.js';
import { settings } from './settings.js';
import { recordAiAudit } from './aiAudit.js';

const execFileAsync = promisify(execFile);

/** 归一化错误码，供前端按 code 分支提示（对应 §2.5 / §6.2） */
export type ApiErrorCode =
  | 'key_missing'
  | 'invalid_base'
  | 'rate_limited'
  | 'moderation_blocked'
  | 'upstream_error'
  | 'unknown';

export class AiProxyError extends Error {
  code: ApiErrorCode;
  status?: number;
  constructor(code: ApiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiProxyError';
    this.code = code;
    this.status = status;
  }
}

/** 归一化上游错误为 AiProxyError */
function normalizeError(err: unknown, cap?: CapId): AiProxyError {
  if (err instanceof AiProxyError) return err;
  const e = err as { status?: number; code?: string; message?: string };
  const status = e?.status;
  if (status === 401 || status === 403) {
    const label = cap ? CAP_SLOTS[cap].label : '上游服务';
    return new AiProxyError(
      'invalid_base',
      `${label}返回 HTTP ${status}，当前 Key 被上游拒绝；这不是生图失败。请在设置页重新验证该能力的 Key。`,
      status,
    );
  }
  if (status === 429) return new AiProxyError('rate_limited', '上游限频，请稍后重试', status);
  const msg = e?.message ?? String(err);
  if (/moderation|content_policy|policy_violation/i.test(msg)) {
    return new AiProxyError('moderation_blocked', '内容被上游审核拦截（避免具名艺术家/敏感内容，见 T5-b）', status);
  }
  return new AiProxyError('upstream_error', msg, status);
}

/** 审计保留上游错误摘要以便定位网关/余额/参数问题；任何 sk- Key 均脱敏。 */
function auditErrorSummary(err: unknown): string {
  const raw = String((err as { message?: unknown })?.message || err || '未知错误');
  return raw.replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]').slice(0, 500);
}

/** 构造某能力的 openai 客户端（每次新建，避免跨请求串 Key） */
function proxyAgent(): HttpsProxyAgent<string> | undefined {
  // Node 不会自动沿用系统 HTTP(S)_PROXY；本机使用代理时，模型调用也必须走同一出口。
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

function buildClient(cap: CapId, injectFetch?: typeof globalThis.fetch, timeout = 120_000, maxRetries = 2): OpenAI {
  const def = CAP_SLOTS[cap];
  const apiKey = settings.getKey(def.keyId);
  if (!apiKey) {
    throw new AiProxyError('key_missing', `「${def.label}」能力未配置 Key，请到设置页填写`);
  }
  return new OpenAI({
    apiKey,
    baseURL: def.baseURL,
    timeout,
    maxRetries,
    httpAgent: proxyAgent(),
    // 测试/校验时注入 stub fetch，不触网、不耗 Key
    fetch: injectFetch as unknown as typeof globalThis.fetch | undefined,
  });
}

function currentModel(cap: CapId): string {
  const def = CAP_SLOTS[cap];
  const chosen = settings.summary().suppliers[cap];
  return chosen ?? def.defaultModel;
}

// ---------------------------------------------------------------------------
// 文字能力（text）：洗稿改写 / 提示词生成
// ---------------------------------------------------------------------------
export interface TextOpts {
  system?: string;
  user: string;
  model?: string;
  temperature?: number;
}

export interface TextResult {
  text: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export async function generateText(opts: TextOpts, injectFetch?: typeof globalThis.fetch): Promise<TextResult> {
  const cap: CapId = 'text';
  const client = buildClient(cap, injectFetch);
  const model = opts.model ?? currentModel(cap);
  const started = Date.now();
  try {
    const resp = await client.chat.completions.create({
      model,
      temperature: opts.temperature ?? 0.7,
      messages: [
        ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
        { role: 'user', content: opts.user },
      ],
    });
    const choice = resp.choices?.[0];
    if (!choice?.message?.content) throw new AiProxyError('upstream_error', '上游返回空内容');
    const result = {
      text: choice.message.content,
      model,
      usage: resp.usage as TextResult['usage'],
    };
    recordAiAudit({ at: new Date().toISOString(), capability: cap, model, ok: true, durationMs: Date.now() - started, usage: result.usage });
    return result;
  } catch (err) {
    const normalized = normalizeError(err, cap);
    // 审计保留脱敏后的上游原始摘要，不能只保存统一文案，否则无法判断是 Key、余额还是网关问题。
    recordAiAudit({ at: new Date().toISOString(), capability: cap, model, ok: false, durationMs: Date.now() - started, error: auditErrorSummary(err) });
    throw normalized;
  }
}

// ---------------------------------------------------------------------------
// 视觉能力（visionImg / visionVideo）：多模态识别
// ---------------------------------------------------------------------------
export interface VisionPart {
  type: 'image' | 'video';
  data: string; // base64（不含 data: 前缀）
  mime: string; // 如 image/jpeg, video/mp4
}

export interface RecognizeOpts {
  cap: Extract<CapId, 'visionImg' | 'visionVideo'>;
  parts: VisionPart[];
  system?: string;
  user?: string;
  model?: string;
}

export async function recognize(opts: RecognizeOpts, injectFetch?: typeof globalThis.fetch): Promise<TextResult> {
  const client = buildClient(opts.cap, injectFetch);
  const def = CAP_SLOTS[opts.cap];
  const model = opts.model ?? currentModel(opts.cap);
  const started = Date.now();
  // 结构化稿件 schema 指令（系统层固定，见 §2.6）
  const defaultSystem =
    '你是内容识别助手。请严格按如下结构输出：\n标题：\n正文：\n要点：\n画面说明：';
  const content: any[] = [
    { type: 'text', text: opts.system ?? defaultSystem },
  ];
  for (const p of opts.parts) {
    const dataUri = `data:${p.mime};base64,${p.data}`;
    if (p.type === 'image') {
      content.push({ type: 'image_url', image_url: { url: dataUri } });
    } else {
      // 通义 Qwen-VL 扩展：video_url part（OpenAI 兼容模式透传）
      content.push({ type: 'video_url', video_url: { url: dataUri } });
    }
  }
  content.push({ type: 'text', text: opts.user ?? '请识别以上素材并结构化输出。' });
  try {
    const resp = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content }],
    });
    const text = resp.choices?.[0]?.message?.content;
    if (!text) throw new AiProxyError('upstream_error', '识别返回空内容');
    const result = { text, model, usage: resp.usage as TextResult['usage'] };
    recordAiAudit({ at: new Date().toISOString(), capability: opts.cap, model, ok: true, durationMs: Date.now() - started, mediaCount: opts.parts.length, usage: result.usage });
    return result;
  } catch (err) {
    const normalized = normalizeError(err, opts.cap);
    recordAiAudit({ at: new Date().toISOString(), capability: opts.cap, model, ok: false, durationMs: Date.now() - started, mediaCount: opts.parts.length, error: normalized.message });
    throw normalized;
  }
}

// ---------------------------------------------------------------------------
// 出图能力（image）：经 AIHubMix 中转，默认 gpt-image-2，固定 1 张
// ---------------------------------------------------------------------------
export interface ImageOpts {
  prompt: string;
  refImgs?: VisionPart[]; // 参考图（≤14，有则走 /images/edits）
  size?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
}

export interface ImageResult {
  images: { b64: string }[];
  model: string;
  usedEdit: boolean;
}

export interface CodexImageStatus {
  available: boolean;
  message: string;
  version?: string;
}

/**
 * Finder / DMG 启动的 macOS 应用不会继承终端的 PATH。
 * 因此除了 PATH，也显式识别 ChatGPT.app 内置的 Codex CLI 与常见安装位置。
 */
async function codexCliPath(): Promise<string | null> {
  const home = os.homedir();
  const candidates = [
    process.env.NEWMEDIA_CODEX_CLI,
    process.platform === 'darwin' ? '/Applications/ChatGPT.app/Contents/Resources/codex' : undefined,
    process.platform === 'darwin' ? '/opt/homebrew/bin/codex' : undefined,
    process.platform === 'darwin' ? '/usr/local/bin/codex' : undefined,
    path.join(home, '.local', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
    path.join(home, '.codex', 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'),
  ].filter((item): item is string => Boolean(item));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch { /* 尝试下一个安装位置 */ }
  }
  try {
    await execFileAsync('codex', ['--version'], { timeout: 8_000 });
    return 'codex';
  } catch {
    return null;
  }
}

/**
 * 检查本机 Codex 的 ChatGPT 登录态。仅读取登录状态，不返回 Token / Key。
 * Open Design 使用同一条本地 Codex CLI 出图路径。
 */
export async function getCodexImageStatus(): Promise<CodexImageStatus> {
  try {
    const authPath = path.join(os.homedir(), '.codex', 'auth.json');
    const auth = JSON.parse(await fs.readFile(authPath, 'utf8')) as { auth_mode?: unknown; tokens?: { access_token?: unknown } };
    const loggedIn = auth.auth_mode === 'chatgpt' || typeof auth.tokens?.access_token === 'string';
    if (!loggedIn) return { available: false, message: '未检测到 Codex 订阅登录，请先在终端完成 Codex 登录' };
    const cli = await codexCliPath();
    if (!cli) return { available: false, message: '未检测到可用的 Codex CLI 或订阅登录' };
    const { stdout } = await execFileAsync(cli, ['--version'], { timeout: 8_000 });
    return { available: true, message: '已检测到本机 Codex 订阅，可直接出图', version: stdout.trim() || undefined };
  } catch {
    return { available: false, message: '未检测到可用的 Codex CLI 或订阅登录' };
  }
}

function codexThreadId(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as { type?: unknown; thread_id?: unknown };
      if (event.type === 'thread.started' && typeof event.thread_id === 'string') return event.thread_id;
    } catch { /* 忽略非 JSON 进度行 */ }
  }
  return null;
}

function codexAspect(size?: ImageOpts['size']): string {
  if (size === '1024x1024') return '1:1';
  if (size === '1536x1024') return '3:2 横版';
  return '2:3 竖版';
}

async function runCodexImage(cli: string, args: string[], prompt: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new AiProxyError('upstream_error', 'Codex 订阅出图超时（5 分钟）'));
    }, 300_000);
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) return reject(new AiProxyError('upstream_error', `Codex 订阅出图失败：${(err || out).slice(0, 500)}`));
      resolve(out);
    });
    child.stdin.end(prompt);
  });
}

/** 通过已登录的本机 Codex CLI 生成图片，不需要 API Key。 */
export async function generateCodexSubscriptionImage(opts: ImageOpts): Promise<ImageResult> {
  const status = await getCodexImageStatus();
  if (!status.available) throw new AiProxyError('key_missing', status.message);
  const cli = await codexCliPath();
  if (!cli) throw new AiProxyError('key_missing', '未检测到可用的 Codex CLI 或订阅登录');
  const started = Date.now();
  const generatedRoot = path.join(os.homedir(), '.codex', 'generated_images');
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'newmedia-codex-image-'));
  let threadDir = '';
  try {
    await fs.mkdir(generatedRoot, { recursive: true });
    const refs: string[] = [];
    for (const [index, ref] of (opts.refImgs || []).entries()) {
      const extension = ref.mime.includes('jpeg') ? 'jpg' : ref.mime.includes('webp') ? 'webp' : 'png';
      const file = path.join(tempDir, `reference-${index + 1}.${extension}`);
      await fs.writeFile(file, Buffer.from(ref.data, 'base64'), { mode: 0o600 });
      refs.push(file);
    }
    const model = process.env.NEWMEDIA_CODEX_IMAGEGEN_MODEL?.trim() || 'gpt-5.5';
    const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '-C', tempDir, '--add-dir', generatedRoot, '--model', model];
    for (const ref of refs) args.push('-i', ref);
    const prefix = refs.length ? '$imagegen Edit the attached reference image(s):' : '$imagegen';
    const output = await runCodexImage(cli, args, `${prefix} ${opts.prompt}\nAspect ratio: ${codexAspect(opts.size)}.`, tempDir);
    const threadId = codexThreadId(output);
    if (!threadId) throw new AiProxyError('upstream_error', 'Codex 未返回图片任务标识，无法读取生成文件');
    threadDir = path.join(generatedRoot, threadId);
    const files = await fs.readdir(threadDir);
    // 不同 Codex CLI 版本的落盘前缀不同：旧版为 ig_，当前订阅版常为 call_。
    const imageName = files.filter((name) => /^(ig_|call_).*\.(png|jpe?g|webp)$/i.test(name)).sort()[0]
      || files.filter((name) => /\.(png|jpe?g|webp)$/i.test(name)).sort()[0];
    if (!imageName) throw new AiProxyError('upstream_error', 'Codex 已完成，但未在本地写出图片文件');
    const bytes = await fs.readFile(path.join(threadDir, imageName));
    if (bytes.length < 1024) throw new AiProxyError('upstream_error', 'Codex 返回的图片文件异常');
    const result = { images: [{ b64: bytes.toString('base64') }], model: 'gpt-image-2（Codex 订阅）', usedEdit: refs.length > 0 };
    recordAiAudit({ at: new Date().toISOString(), capability: 'image', model: result.model, ok: true, durationMs: Date.now() - started, mediaCount: refs.length });
    return result;
  } catch (error) {
    const normalized = normalizeError(error, 'image');
    recordAiAudit({ at: new Date().toISOString(), capability: 'image', model: 'gpt-image-2（Codex 订阅）', ok: false, durationMs: Date.now() - started, error: normalized.message });
    throw normalized;
  } finally {
    if (threadDir) await fs.rm(threadDir, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function generateImage(opts: ImageOpts, injectFetch?: typeof globalThis.fetch): Promise<ImageResult> {
  const cap: CapId = 'image';
  const started = Date.now();
  const model = currentModel(cap);
  const size = opts.size ?? '1024x1536'; // 默认竖版海报向
  const quality = opts.quality ?? 'auto';

  try {
    // AIHubMix 的 gpt-image-2 官方建议单次等待至少 10 分钟；出图禁用自动重试，防止重复扣费。
    const client = buildClient(cap, injectFetch, 600_000, 0);
    if (opts.refImgs && opts.refImgs.length > 0) {
      // 参考图 → /v1/images/edits
      // 关键：传 Buffer 而非 data URI，否则 SDK 会反向 fetch 该 URI 导致 Connection error
      const images = opts.refImgs.map((p) => Buffer.from(p.data, 'base64'));
      const resp = await client.images.edit({
        model,
        image: images as any,
        prompt: opts.prompt,
        n: 1,
        // AIHubMix 的 gpt-image-2 支持平台扩展的 2K / 4K 尺寸；SDK 类型仅覆盖 OpenAI 原生枚举。
        size: size as any,
        quality,
      });
      const result = { images: normImages(resp), model, usedEdit: true };
      if (!injectFetch) recordAiAudit({ at: new Date().toISOString(), capability: 'image', model, ok: true, durationMs: Date.now() - started, mediaCount: opts.refImgs.length });
      return result;
    }
    const resp = await client.images.generate({
      model,
      prompt: opts.prompt,
      n: 1,
      // 同上：透传 AIHubMix 扩展尺寸。
      size: size as any,
      quality,
    });
    const result = { images: normImages(resp), model, usedEdit: false };
    if (!injectFetch) recordAiAudit({ at: new Date().toISOString(), capability: 'image', model, ok: true, durationMs: Date.now() - started, mediaCount: 0 });
    return result;
  } catch (err) {
    const normalized = normalizeError(err, cap);
    if (!injectFetch) recordAiAudit({ at: new Date().toISOString(), capability: 'image', model, ok: false, durationMs: Date.now() - started, mediaCount: opts.refImgs?.length || 0, error: auditErrorSummary(err) });
    throw normalized;
  }
}

function normImages(resp: any): { b64: string }[] {
  const list = resp?.data ?? [];
  return list.map((d: any) => {
    if (d?.b64_json) return { b64: d.b64_json };
    if (d?.url) throw new AiProxyError('upstream_error', '上游返回图片 URL，当前接口未返回可保存的 Base64 图片');
    throw new AiProxyError('upstream_error', '上游返回结构异常');
  });
}

// ---------------------------------------------------------------------------
// dry-run 验证：校验 Key 是否可用（chat 走 1 token ping；image 仅校验格式+可达）
// ---------------------------------------------------------------------------
export async function verifyCap(cap: CapId, injectFetch?: typeof globalThis.fetch): Promise<{ ok: boolean; model?: string; error?: string }> {
  const def = CAP_SLOTS[cap];
  if (!settings.getKey(def.keyId)) {
    return { ok: false, error: `「${def.label}」未配置 Key` };
  }
  if (def.kind === 'image') {
    // 出图真实调用有成本，dry-run 仅做无生成成本的鉴权请求。
    // 必须复用 OpenAI 客户端：它会带上本机 HTTP(S)_PROXY，不能用 Node 原生 fetch 直连。
    try {
      const client = buildClient(cap, injectFetch, 15_000);
      await client.models.list();
      return { ok: true, model: currentModel(cap) };
    } catch (err) {
      const normalized = normalizeError(err, cap);
      const timedOut = /timeout|timed out|aborted|aborterror/i.test(normalized.message);
      return { ok: false, error: timedOut ? 'AIHubMix 验证请求超时（未发起出图、不会扣图像额度），请稍后重试' : normalized.message };
    }
  }
  try {
    const client = buildClient(cap, injectFetch);
    const model = currentModel(cap);
    await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return { ok: true, model };
  } catch (err) {
    return { ok: false, error: normalizeError(err, cap).message };
  }
}
