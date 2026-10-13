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
import { CAP_SLOTS, type CapId } from './caps.js';
import { settings, type ProviderDraft, type ProviderRequestSnapshot, ProviderConfigError, validateProviderBaseURL } from './settings.js';
import { recordAiAudit } from './aiAudit.js';

const execFileAsync = promisify(execFile);

/** 归一化错误码，供前端按 code 分支提示（对应 §2.5 / §6.2） */
export type ApiErrorCode =
  | 'key_missing'
  | 'invalid_base'
  | 'rate_limited'
  | 'moderation_blocked'
  | 'unsupported_protocol'
  | 'configuration_changed'
  | 'timeout'
  | 'empty_model_list'
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
  if (err instanceof ProviderConfigError) {
    const code: ApiErrorCode = err.code === 'key_missing' ? 'key_missing'
      : err.code === 'unsupported_capability' ? 'unsupported_protocol' : 'invalid_base';
    return new AiProxyError(code, err.message, err.status);
  }
  const e = err as { status?: number; code?: string; name?: string };
  const status = e?.status;
  if (status === 401 || status === 403) {
    const label = cap ? CAP_SLOTS[cap].label : '上游服务';
    return new AiProxyError(
      'invalid_base',
      `${label}鉴权失败（HTTP ${status}）；请检查提供商 API Key。`,
      status,
    );
  }
  if (status === 404) return new AiProxyError('invalid_base', '接口未找到（HTTP 404）；请检查 API 根地址与所选协议。', status);
  if (status === 429) return new AiProxyError('rate_limited', '上游限频，请稍后重试', status);
  if (e?.code === 'content_policy_violation' || e?.code === 'moderation_blocked') return new AiProxyError('moderation_blocked', '内容被上游审核拦截', status);
  if (err instanceof OpenAI.APIUserAbortError || e?.name === 'AbortError' || e?.name === 'APIConnectionTimeoutError' || e?.code === 'ETIMEDOUT') return new AiProxyError('timeout', 'AI 请求已取消或超时，请检查网络或代理设置', status);
  if (status) return new AiProxyError('upstream_error', `AI 上游请求失败（HTTP ${status}）`, status);
  return new AiProxyError('upstream_error', 'AI 请求失败，请检查网络或代理设置');
}

/** Audit records only safe categories/status. Never persist upstream message/body/headers. */
function auditErrorSummary(err: unknown): string {
  if (err instanceof AiProxyError) return err.code;
  const error = err as { status?: number; name?: string; code?: string };
  if (error?.status) return `http_${error.status}`;
  if (err instanceof OpenAI.APIUserAbortError || error?.name === 'AbortError' || error?.name === 'APIConnectionTimeoutError' || error?.code === 'ETIMEDOUT') return 'timeout';
  return 'network_or_protocol_error';
}

/** The SDK transport owns proxy routing for all OpenAI and Anthropic requests. */
export function proxyAgent(proxyOverride?: string): HttpsProxyAgent<string> | undefined {
  // Node 不会自动沿用系统 HTTP(S)_PROXY；本机使用代理时，模型调用也必须走同一出口。
  const proxy = proxyOverride ?? process.env.HTTPS_PROXY ?? process.env.https_proxy ?? process.env.ALL_PROXY ?? process.env.all_proxy;
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

// The OpenAI SDK's opt-in DEBUG logger includes request headers and upstream error bodies.
// Suppress only SDK-tagged debug lines while a request is active, including Anthropic x-api-key.
let sdkDebugSuppressionCount = 0;
let originalConsoleLog: typeof console.log | undefined;
async function withoutSdkDebugLogs<T>(operation: () => Promise<T>): Promise<T> {
  if (sdkDebugSuppressionCount++ === 0) {
    originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('OpenAI:DEBUG:')) return;
      originalConsoleLog?.apply(console, args as Parameters<typeof console.log>);
    };
  }
  try { return await operation(); }
  finally {
    sdkDebugSuppressionCount--;
    if (sdkDebugSuppressionCount === 0 && originalConsoleLog) {
      console.log = originalConsoleLog;
      originalConsoleLog = undefined;
    }
  }
}

function buildClient(snapshot: ProviderRequestSnapshot, injectFetch?: typeof globalThis.fetch, timeout = 120_000, maxRetries = 2): OpenAI {
  return new OpenAI({
    apiKey: snapshot.apiKey,
    baseURL: snapshot.provider.baseURL,
    timeout,
    maxRetries,
    httpAgent: proxyAgent(),
    // 测试/校验时注入 stub fetch，不触网、不耗 Key
    fetch: injectFetch as unknown as typeof globalThis.fetch | undefined,
  });
}

function usageFrom(value: any): TextResult['usage'] {
  if (!value) return undefined;
  return {
    prompt_tokens: value.prompt_tokens ?? value.input_tokens,
    completion_tokens: value.completion_tokens ?? value.output_tokens,
    total_tokens: value.total_tokens,
  };
}

function chatText(value: any): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
  return '';
}

function responsesText(response: any): string {
  if (typeof response?.output_text === 'string' && response.output_text) return response.output_text;
  return (response?.output ?? []).flatMap((item: any) => item?.type === 'message' ? item.content ?? [] : [])
    .filter((part: any) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part: any) => part.text).join('\n');
}

function anthropicText(response: any): string {
  return (response?.content ?? []).filter((part: any) => part?.type === 'text' && typeof part.text === 'string').map((part: any) => part.text).join('\n');
}

function anthropicHeaders(apiKey: string): Record<string, string | null> {
  return { Authorization: null, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
}

export async function fetchProviderModels(
  draft: Pick<ProviderDraft, 'id' | 'baseURL' | 'protocol' | 'apiKey'>,
  signal?: AbortSignal,
  injectFetch?: typeof globalThis.fetch,
): Promise<{ models: string[]; fetchedAt: string }> {
  const saved = draft.id ? settings.providerById(draft.id) : undefined;
  const rawBaseURL = draft.baseURL?.trim() || saved?.baseURL;
  const protocol = draft.protocol || saved?.protocol;
  const apiKey = draft.apiKey?.trim() || (saved ? settings.getKey(saved.keyId) : null);
  if (!rawBaseURL || !protocol) throw new AiProxyError('invalid_base', '请先填写 API 根地址并选择协议');
  if (!['openai-chat-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) {
    throw new AiProxyError('unsupported_protocol', '请选择支持的 API 协议');
  }
  let baseURL: string;
  try { baseURL = validateProviderBaseURL(rawBaseURL); }
  catch (error) { throw normalizeError(error); }
  if (!apiKey) throw new AiProxyError('key_missing', '请先填写 API Key；验证失败时也可手工添加模型 ID');
  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: 20_000,
    maxRetries: 0,
    httpAgent: proxyAgent(),
    fetch: injectFetch as unknown as typeof globalThis.fetch | undefined,
  });
  try {
    let data: any;
    if (protocol === 'anthropic-messages') {
      data = await withoutSdkDebugLogs(() => client.get<any, any>('/models', {
        headers: anthropicHeaders(apiKey),
        timeout: 20_000,
        maxRetries: 0,
        signal,
      }));
    } else {
      data = await withoutSdkDebugLogs(() => client.models.list({ timeout: 20_000, maxRetries: 0, signal }));
    }
    const modelIds: string[] = (data?.data ?? []).map((item: any) => typeof item?.id === 'string' ? item.id.trim() : '').filter((id: string) => Boolean(id));
    const models = [...new Set<string>(modelIds)];
    if (!models.length) throw new AiProxyError('empty_model_list', '接口连接成功，但模型列表为空；可以手工添加模型 ID');
    return { models, fetchedAt: new Date().toISOString() };
  } catch (error) {
    const normalized = normalizeError(error);
    throw normalized;
  }
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
  const snapshot = settings.resolveRequest(cap, opts.model);
  const client = buildClient(snapshot, injectFetch);
  const model = snapshot.model;
  const started = Date.now();
  try {
    let text = '';
    let usage: TextResult['usage'];
    if (snapshot.provider.protocol === 'openai-chat-completions') {
      const resp = await withoutSdkDebugLogs(() => client.chat.completions.create({
        model,
        temperature: opts.temperature ?? 0.7,
        messages: [
          ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
          { role: 'user', content: opts.user },
        ],
      }));
      text = chatText(resp.choices?.[0]?.message?.content);
      usage = usageFrom(resp.usage);
    } else if (snapshot.provider.protocol === 'openai-responses') {
      const resp = await withoutSdkDebugLogs(() => client.responses.create({
        model,
        instructions: opts.system,
        input: opts.user,
        temperature: opts.temperature ?? 0.7,
      }));
      text = responsesText(resp);
      usage = usageFrom(resp.usage);
    } else {
      const resp = await withoutSdkDebugLogs(() => client.post<any, any>('/messages', {
        body: {
          model,
          max_tokens: 4096,
          ...(opts.system ? { system: opts.system } : {}),
          messages: [{ role: 'user', content: opts.user }],
          temperature: opts.temperature ?? 0.7,
        },
        headers: anthropicHeaders(snapshot.apiKey),
      }));
      text = anthropicText(resp);
      usage = usageFrom(resp.usage);
    }
    if (!text) throw new AiProxyError('upstream_error', '上游返回空内容');
    const result = {
      text,
      model,
      usage,
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
  const snapshot = settings.resolveRequest(opts.cap, opts.model);
  const client = buildClient(snapshot, injectFetch);
  const model = snapshot.model;
  const started = Date.now();
  // 结构化稿件 schema 指令（系统层固定，见 §2.6）
  const defaultSystem =
    '你是内容识别助手。请严格按如下结构输出：\n标题：\n正文：\n要点：\n画面说明：';
  const system = opts.system ?? defaultSystem;
  const user = opts.user ?? '请识别以上素材并结构化输出。';
  if (opts.parts.some((part) => part.type === 'video') && snapshot.provider.protocol !== 'openai-chat-completions') {
    throw new AiProxyError('unsupported_protocol', '视频输入当前仅支持 OpenAI Chat Completions 兼容协议');
  }
  try {
    let text = '';
    let usage: TextResult['usage'];
    if (snapshot.provider.protocol === 'openai-chat-completions') {
      const content: any[] = [{ type: 'text', text: system }];
      for (const part of opts.parts) {
        const dataUri = `data:${part.mime};base64,${part.data}`;
        if (part.type === 'image') content.push({ type: 'image_url', image_url: { url: dataUri } });
        else content.push({ type: 'video_url', video_url: { url: dataUri } }); // Existing Qwen-compatible video_url body.
      }
      content.push({ type: 'text', text: user });
      const resp = await withoutSdkDebugLogs(() => client.chat.completions.create({ model, messages: [{ role: 'user', content }] }));
      text = chatText(resp.choices?.[0]?.message?.content);
      usage = usageFrom(resp.usage);
    } else if (snapshot.provider.protocol === 'openai-responses') {
      const content: any[] = [{ type: 'input_text', text: user }];
      for (const part of opts.parts) {
        if (part.type !== 'image') throw new AiProxyError('unsupported_protocol', 'Responses 当前不支持本工作台的视频输入格式');
        content.push({ type: 'input_image', image_url: `data:${part.mime};base64,${part.data}` });
      }
      const resp = await withoutSdkDebugLogs(() => client.responses.create({ model, instructions: system, input: [{ role: 'user', content }] }));
      text = responsesText(resp);
      usage = usageFrom(resp.usage);
    } else {
      const content: any[] = [{ type: 'text', text: user }];
      for (const part of opts.parts) {
        if (part.type !== 'image') throw new AiProxyError('unsupported_protocol', 'Anthropic Messages 当前不支持本工作台的视频输入格式');
        content.push({ type: 'image', source: { type: 'base64', media_type: part.mime, data: part.data } });
      }
      const resp = await withoutSdkDebugLogs(() => client.post<any, any>('/messages', {
        body: { model, max_tokens: 4096, system, messages: [{ role: 'user', content }] },
        headers: anthropicHeaders(snapshot.apiKey),
      }));
      text = anthropicText(resp);
      usage = usageFrom(resp.usage);
    }
    if (!text) throw new AiProxyError('upstream_error', '识别返回空内容');
    const result = { text, model, usage };
    recordAiAudit({ at: new Date().toISOString(), capability: opts.cap, model, ok: true, durationMs: Date.now() - started, mediaCount: opts.parts.length, usage: result.usage });
    return result;
  } catch (err) {
    const normalized = normalizeError(err, opts.cap);
    recordAiAudit({ at: new Date().toISOString(), capability: opts.cap, model, ok: false, durationMs: Date.now() - started, mediaCount: opts.parts.length, error: normalized.message });
    throw normalized;
  }
}

// ---------------------------------------------------------------------------
// 出图能力（image）：按设置页选择的 AIHubMix / SudoCode 供应商调用，固定 1 张
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
  const snapshot = settings.resolveRequest(cap);
  const model = snapshot.model;
  const size = opts.size ?? '1024x1536'; // 默认竖版海报向
  const quality = opts.quality ?? 'auto';

  try {
    // 图像供应商的 gpt-image-2 请求可能较慢；出图禁用自动重试，防止重复扣费。
    const client = buildClient(snapshot, injectFetch, 600_000, 0);
    if (opts.refImgs && opts.refImgs.length > 0) {
      // 参考图 → /v1/images/edits
      // 关键：传 Buffer 而非 data URI，否则 SDK 会反向 fetch 该 URI 导致 Connection error
      const images = opts.refImgs.map((p) => Buffer.from(p.data, 'base64'));
      const resp = await withoutSdkDebugLogs(() => client.images.edit({
        model,
        image: images as any,
        prompt: opts.prompt,
        n: 1,
        // 部分图像网关支持平台扩展的 2K / 4K 尺寸；SDK 类型仅覆盖 OpenAI 原生枚举。
        size: size as any,
        quality,
      }));
      const result = { images: normImages(resp), model, usedEdit: true };
      if (!injectFetch) recordAiAudit({ at: new Date().toISOString(), capability: 'image', model, ok: true, durationMs: Date.now() - started, mediaCount: opts.refImgs.length });
      return result;
    }
    const resp = await withoutSdkDebugLogs(() => client.images.generate({
      model,
      prompt: opts.prompt,
      n: 1,
      // 同上：透传网关支持的扩展尺寸。
      size: size as any,
      quality,
    }));
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
  let snapshot: ProviderRequestSnapshot;
  try { snapshot = settings.resolveRequest(cap); }
  catch (error) { return { ok: false, error: normalizeError(error, cap).message }; }
  try {
    const client = buildClient(snapshot, injectFetch, cap === 'image' ? 20_000 : 120_000, 0);
    if (cap === 'image') {
      // Image verification is model-list/auth only; never call a generation endpoint.
      await withoutSdkDebugLogs(() => client.models.list({ timeout: 20_000, maxRetries: 0 }));
    } else if (snapshot.provider.protocol === 'openai-chat-completions') {
      await withoutSdkDebugLogs(() => client.chat.completions.create({ model: snapshot.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }));
    } else if (snapshot.provider.protocol === 'openai-responses') {
      // The Responses API requires max_output_tokens >= 16; keep the ping minimal and protocol-valid.
      await withoutSdkDebugLogs(() => client.responses.create({ model: snapshot.model, input: 'ping', max_output_tokens: 16 }));
    } else {
      await withoutSdkDebugLogs(() => client.post<any, any>('/messages', {
        body: { model: snapshot.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
        headers: anthropicHeaders(snapshot.apiKey),
      }));
    }
    if (!settings.markVerifiedIfCurrent(snapshot)) {
      return { ok: false, error: '验证期间配置已改变，本次结果未应用；请重新验证当前配置。' };
    }
    return { ok: true, model: snapshot.model };
  } catch (error) {
    const normalized = normalizeError(error, cap);
    settings.clearVerifiedIfCurrent(snapshot);
    return { ok: false, error: cap === 'image' && normalized.code === 'timeout'
      ? '验证请求超时（未发起出图、不会扣图像额度），请稍后重试'
      : normalized.message };
  }
}
