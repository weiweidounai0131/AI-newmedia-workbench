// AI 路由：对应模块③提示词 / 模块②洗稿 / 模块④出图
// 单一事实源：BACKEND-PATH §3.3 / §2.5 / §4.2
// 全部经 aiProxy 统一调用（Key 仅后端持有），v1 一次性返回。
import { Router, type Request, type Response } from 'express';
import { generateText, recognize, generateImage, generateCodexSubscriptionImage, getCodexImageStatus, AiProxyError } from '../services/aiProxy.js';
import { recognizeLink, recognizeSource, importDouyinVideo, importXhsNote, ScrapeError } from '../services/scrape.js';
import { startDouyinDownload, getDouyinDownloadTask, startXhsDownload, getXhsDownloadTask } from '../services/wechatMpTools.js';
import { parsePromptOutput } from '../services/promptParse.js';
import { listAiAudit } from '../services/aiAudit.js';

export const aiRouter = Router();

// 抖音解析：实际下载委托给本机 wechat-mp-tools。
aiRouter.post('/xigao/douyin-download/start', (req: Request, res: Response) => {
  const { link } = req.body ?? {};
  if (!link) return res.status(400).json({ error: 'link 不能为空', code: 'bad_request' });
  try {
    res.json(startDouyinDownload(String(link)));
  } catch (err) {
    fail(res, err);
  }
});

aiRouter.get('/xigao/douyin-download/status/:taskId', (req: Request, res: Response) => {
  const task = getDouyinDownloadTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: '下载任务不存在或已过期', code: 'task_not_found' });
  res.json(task);
});

aiRouter.post('/xigao/douyin-source', (req: Request, res: Response) => {
  const { path: filePath, title } = req.body ?? {};
  if (!filePath) return res.status(400).json({ error: '下载文件路径不能为空', code: 'bad_request' });
  try {
    res.json(importDouyinVideo(String(filePath), title ? String(title) : undefined));
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    fail(res, err);
  }
});

// 小红书图文解析：实际下载委托给本机 wechat-mp-tools，视频不纳入该链路。
aiRouter.post('/xigao/xhs-download/start', (req: Request, res: Response) => {
  const { link } = req.body ?? {};
  if (!link) return res.status(400).json({ error: 'link 不能为空', code: 'bad_request' });
  try {
    res.json(startXhsDownload(String(link)));
  } catch (err) {
    fail(res, err);
  }
});

aiRouter.get('/xigao/xhs-download/status/:taskId', (req: Request, res: Response) => {
  const task = getXhsDownloadTask(req.params.taskId);
  if (!task) return res.status(404).json({ error: '下载任务不存在或已过期', code: 'task_not_found' });
  res.json(task);
});

aiRouter.post('/xigao/xhs-source', (req: Request, res: Response) => {
  const { path: noteDir, title } = req.body ?? {};
  if (!noteDir) return res.status(400).json({ error: '下载目录不能为空', code: 'bad_request' });
  try {
    res.json(importXhsNote(String(noteDir), title ? String(title) : undefined));
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    fail(res, err);
  }
});

// 本地审计查询：仅返回模型调用元信息，不暴露 Key 或内容。
aiRouter.get('/audit', (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ items: listAiAudit(limit) });
});

// 统一错误响应
function fail(res: Response, err: unknown) {
  if (err instanceof AiProxyError) {
    return res.status(err.status === 401 || err.status === 403 ? 400 : 502).json({
      error: err.message,
      code: err.code,
    });
  }
  return res.status(502).json({ error: String(err), code: 'unknown' });
}

function parseCreativeDirections(text: string): string[] {
  const marks = [...text.matchAll(/^#\s*方向\s*([一二三四1234])\s*$/gim)];
  const result = marks.map((mark, index) => text.slice((mark.index || 0) + mark[0].length, marks[index + 1]?.index).trim()).filter(Boolean);
  return result.slice(0, 4);
}

// ---- 模块② 创意：热榜借势方向与内容生成（统一使用 DeepSeek） ----
aiRouter.post('/creative/directions', async (req: Request, res: Response) => {
  const { link, title, integration } = req.body ?? {};
  if (!link || !integration) return res.status(400).json({ error: '热榜链接和结合信息不能为空', code: 'bad_request' });
  try {
    const r = await generateText({
      system: [
        '你是资深新媒体创意策划，擅长借势热榜为企业产品设计传播创意。',
        '基于热榜标题、热榜链接及用户提供的结合信息，提出 4 个差异明显、可执行、合规的借势宣传方向。',
        '每个方向写清核心切入点、适合表达形式和可融入的产品信息，避免空泛口号、避免直接照搬热榜原文。',
        '必须严格只按以下格式输出，不要添加前言、结语或其他标题：',
        '#方向一\n内容\n#方向二\n内容\n#方向三\n内容\n#方向四\n内容',
      ].join('\n'),
      user: `热榜标题：${title || '未提供'}\n热榜链接：${link}\n\n需结合的信息：${integration}`,
    });
    const directions = parseCreativeDirections(r.text);
    if (directions.length !== 4) return res.status(422).json({ error: 'AI 未按要求生成完整的 4 个创意方向，请重试', code: 'parse_failed' });
    res.json({ directions, model: r.model, usage: r.usage });
  } catch (err) { fail(res, err); }
});

aiRouter.post('/creative/generate', async (req: Request, res: Response) => {
  const { link, title, integration, direction, requirement } = req.body ?? {};
  if (!link || !integration || !direction) return res.status(400).json({ error: '热榜链接、结合信息和创作方向不能为空', code: 'bad_request' });
  try {
    const r = await generateText({
      system: '你是新媒体内容创作助手。根据选定的借势创意方向，产出可直接用于运营制作的完整内容。严格执行用户对内容形式、长度和语气的要求；避免虚假承诺、夸大宣传与生硬蹭热点。直接输出最终内容，不要解释创作过程。',
      user: `热榜标题：${title || '未提供'}\n热榜链接：${link}\n\n需结合的信息：${integration}\n\n选定创意方向：${direction}\n\n本次创作要求：${requirement || '生成一版完整、可直接使用的新媒体传播文案。'}`,
    });
    res.json({ out: r.text, model: r.model, usage: r.usage });
  } catch (err) { fail(res, err); }
});

// 创意内容的继续优化：始终复用 DeepSeek 文字能力，不重新生成方向。
aiRouter.post('/creative/optimize', async (req: Request, res: Response) => {
  const { content, hint } = req.body ?? {};
  if (!content || !hint) return res.status(400).json({ error: '创意内容和优化意见不能为空', code: 'bad_request' });
  try {
    const r = await generateText({
      system: '你是新媒体创意文案编辑。仅根据用户的优化意见润色现有创意内容，保留有效信息与内容结构，直接输出优化后的完整最终内容，不要解释修改过程。',
      user: `现有创意内容：\n${content}\n\n优化意见：${hint}`,
    });
    res.json({ out: r.text, model: r.model, usage: r.usage });
  } catch (err) { fail(res, err); }
});

// ---- 模块③ 提示词生成 ----
// POST /api/ai/tishici { source, desc, type, optimizeHint? }
//  type='tp' → 一次输出「#文字 + 分隔线 + #图片提示词」，后端确定性拆分
//  type='img' → 整段图片提示词
function buildTishiciSystem(type: 'tp' | 'img', imageCount: number): string {
  if (type === 'img') {
    return [
      '你是新媒体视觉提示词写手。请根据用户给出的稿件内容、图需求与约束，直接输出一段用于 AI 生图的中文图片提示词。',
      '提示词应包含主体、核心信息、视觉风格、构图、色调与画面文字处理要求。',
      `本次需要 ${imageCount} 张配图。必须严格只按以下格式输出，不要额外解释、不要使用其他标题：`,
      '#图片提示词1',
      '这里写第 1 张图片的中文提示词',
      imageCount > 1 ? '#图片提示词2\n这里写第 2 张图片的中文提示词' : '',
      imageCount > 2 ? `依此类推，直到 #图片提示词${imageCount}` : '',
      `#图片提示词1 至 #图片提示词${imageCount} 都必须各自单独占一行；不得漏掉任何一张图片提示词。`,
    ].join('\n');
  }
  return [
    '你是新媒体内容助手。请根据用户给出的稿件内容、图需求与约束，一次性生成可直接发布的小红书或微信朋友圈图文内容。',
    '第一部分「文字」要自然口语、有发布感；第二部分「图片提示词」要用于 AI 生图，包含主体、风格、构图、色调与文字处理要求。',
    `本次需要 ${imageCount} 张配图。必须严格只按以下格式输出，不要额外解释、不要使用其他标题：`,
    '#文字',
    '这里写可发布的图文文案',
    '------',
    '#图片提示词1',
    '这里写第 1 张图片的中文提示词',
    imageCount > 1 ? '#图片提示词2\n这里写第 2 张图片的中文提示词' : '',
    imageCount > 2 ? `依此类推，直到 #图片提示词${imageCount}` : '',
    `其中 #文字、------、#图片提示词1 至 #图片提示词${imageCount} 都必须各自单独占一行；不得漏掉任何一张图片提示词。`,
  ].join('\n');
}

aiRouter.post('/tishici', async (req: Request, res: Response) => {
  const { source, desc, type = 'tp', imageCount: rawImageCount, optimizeHint, previousText, previousImg, previousImgs } = req.body ?? {};
  if (type !== 'tp' && type !== 'img') {
    return res.status(400).json({ error: 'type 必须为 tp 或 img', code: 'bad_request' });
  }
  const imageCount = Math.min(9, Math.max(1, Number(rawImageCount) || 1));
  const oldImages = Array.isArray(previousImgs) ? previousImgs.filter((item) => typeof item === 'string' && item.trim()) : [];
  const user = [
    desc ? `要求：${desc}` : '',
    source ? `参考素材：\n${source}` : '',
    previousText ? `当前文字文案：\n${previousText}` : '',
    oldImages.length ? `当前图片提示词：\n${oldImages.map((item, index) => `#图片提示词${index + 1}\n${item}`).join('\n\n')}` : previousImg ? `当前图片提示词：\n${previousImg}` : '',
    optimizeHint ? `优化方向：${optimizeHint}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  try {
    const r = await generateText({ system: buildTishiciSystem(type, imageCount), user });
    const parsed = parsePromptOutput(r.text, type, imageCount);
    res.json({ ...parsed, model: r.model, usage: r.usage });
  } catch (err) {
    fail(res, err);
  }
});

// ---- 模块② 洗稿 · 多模态识别 ----
// POST /api/ai/xigao/recognize { mediaType, parts:[{type,data,mime}], system? }
aiRouter.post('/xigao/recognize', async (req: Request, res: Response) => {
  const { mediaType, parts, system } = req.body ?? {};
  if (!['image', 'video'].includes(mediaType) || !Array.isArray(parts) || parts.length === 0) {
    return res.status(400).json({ error: 'mediaType/parts 非法', code: 'bad_request' });
  }
  const cap = mediaType === 'video' ? 'visionVideo' : 'visionImg';
  try {
    const r = await recognize({ cap, parts, system });
    res.json({ recog: r.text, model: r.model, usage: r.usage });
  } catch (err) {
    fail(res, err);
  }
});

// ---- 模块② 洗稿 · 链接模式识别（M4） ----
// POST /api/ai/xigao/recognize-link { link, platform? }
// 后端先抓取链接（带登录态 cookie）→ 按媒体类型识别成「稿件」：
//   image → visionImg(GLM-4V)；article → 抽取正文（无需视觉模型）；video → 需登录态（引导）
aiRouter.post('/xigao/recognize-link', async (req: Request, res: Response) => {
  const { link, platform } = req.body ?? {};
  if (!link) return res.status(400).json({ error: 'link 不能为空', code: 'bad_request' });
  try {
    const r = await recognizeLink(link, platform);
    res.json({ ...r, platform: platform || null });
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    fail(res, err);
  }
});

// 第二阶段：来源检查通过后，用户明确点击继续才调用视觉/文字 AI。
aiRouter.post('/xigao/recognize-source', async (req: Request, res: Response) => {
  const { sourceId } = req.body ?? {};
  if (!sourceId) return res.status(400).json({ error: 'sourceId 不能为空', code: 'bad_request' });
  try {
    const r = await recognizeSource(sourceId);
    res.json(r);
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    fail(res, err);
  }
});

// ---- 模块② 洗稿 · 改写（流A 流B 共用后半段） ----
// POST /api/ai/xigao/rewrite { source, req, optimizeHint? }
aiRouter.post('/xigao/rewrite', async (req: Request, res: Response) => {
  const { source, req: rewriteReq, optimizeHint } = req.body ?? {};
  if (!source) return res.status(400).json({ error: 'source 不能为空', code: 'bad_request' });
  const user = [rewriteReq ? `洗稿要求：${rewriteReq}` : '', `待改写稿件：\n${source}`, optimizeHint ? `优化方向：${optimizeHint}` : '']
    .filter(Boolean)
    .join('\n\n');
  try {
    const r = await generateText({
      system: '你是资深新媒体编辑，负责把素材改写成符合平台调性的原创文案，保留核心信息、去水印话术、自然口语化。',
      user,
    });
    res.json({ out: r.text, model: r.model, usage: r.usage });
  } catch (err) {
    fail(res, err);
  }
});

// ---- 模块④ 出图（本机 Codex 订阅或设置页 API） ----
// GET /api/ai/chutu/providers → 本机 Codex 订阅可用性（不暴露登录令牌）
aiRouter.get('/chutu/providers', async (_req: Request, res: Response) => {
  res.json({ codex: await getCodexImageStatus(), api: { available: true, message: '使用设置页已配置的出图 API Key' } });
});

// POST /api/ai/chutu { prompt, provider: 'codex' | 'api', refImgs?, size?, quality? }
aiRouter.post('/chutu', async (req: Request, res: Response) => {
  const { prompt, refImgs, size, quality, optimizeHint, provider = 'api' } = req.body ?? {};
  if (!prompt) return res.status(400).json({ error: 'prompt 不能为空', code: 'bad_request' });
  if (provider !== 'api' && provider !== 'codex') return res.status(400).json({ error: 'provider 必须为 api 或 codex', code: 'bad_request' });
  try {
    const options = {
      prompt: optimizeHint ? `${prompt}\n\n用户修改意见：${optimizeHint}` : prompt,
      refImgs: Array.isArray(refImgs) ? refImgs.slice(0, 14) : undefined, // T6-a：≤14 张
      size,
      quality,
    };
    const r = provider === 'codex' ? await generateCodexSubscriptionImage(options) : await generateImage(options);
    res.json({ images: r.images, model: r.model, usedEdit: r.usedEdit, provider });
  } catch (err) {
    fail(res, err);
  }
});
