// 设置路由：BACKEND-PATH §6.6（API 契约）
// 明文 Key 绝不出现在 GET 响应体；写入走加密存储。
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../services/settings.js';
import { CAP_SLOTS, CAP_IDS, type CapId } from '../services/caps.js';
import { verifyCap } from '../services/aiProxy.js';
import { runtimeSetupStatus, startRuntimeInstall } from '../services/runtimeSetup.js';
import { syncXhsDownloadDir } from '../services/wechatMpTools.js';

export const settingsRouter = Router();

// GET /api/settings → 只读摘要（不含明文 Key）
settingsRouter.get('/', (_req: Request, res: Response) => {
  res.json(settings.summary());
});

// POST /api/settings/key { cap, key } → 加密存 Key
settingsRouter.post('/key', (req: Request, res: Response) => {
  const { cap, key } = req.body ?? {};
  if (!cap || !CAP_SLOTS[cap as CapId]) {
    return res.status(400).json({ error: 'cap 非法', code: 'bad_request' });
  }
  const err = settings.setKeyForCap(cap as CapId, key ?? '');
  if (err) return res.status(400).json({ error: err, code: 'invalid_key' });
  settings.clearVerified(cap as CapId);
  res.json({ ok: true, configured: true });
});

// POST /api/settings/supplier { cap, model } → 切换供应商模型
settingsRouter.post('/supplier', (req: Request, res: Response) => {
  const { cap, model } = req.body ?? {};
  const err = settings.setSupplier(cap as CapId, model);
  if (err) return res.status(400).json({ error: err, code: 'invalid_supplier' });
  res.json({ ok: true });
});

// POST /api/settings/provider { cap, provider } → 切换能力供应商
settingsRouter.post('/provider', (req: Request, res: Response) => {
  const { cap, provider } = req.body ?? {};
  if (!cap || !CAP_SLOTS[cap as CapId] || typeof provider !== 'string') {
    return res.status(400).json({ error: 'cap 或 provider 非法', code: 'bad_request' });
  }
  const err = settings.setProvider(cap as CapId, provider);
  if (err) return res.status(400).json({ error: err, code: 'invalid_provider' });
  res.json({ ok: true, provider: settings.providerId(cap as CapId) });
});

// POST /api/settings/rootdir { rootDir } → 方案 C 导出根目录
settingsRouter.post('/rootdir', (req: Request, res: Response) => {
  const { rootDir } = req.body ?? {};
  if (!rootDir || typeof rootDir !== 'string') {
    return res.status(400).json({ error: 'rootDir 非法' });
  }
  settings.setRootDir(rootDir);
  res.json({ ok: true });
});

// POST /api/settings/xhs-download-dir { xhsDownloadDir } → 固定小红书图文下载/解析目录
settingsRouter.post('/xhs-download-dir', async (req: Request, res: Response) => {
  const raw = typeof req.body?.xhsDownloadDir === 'string' ? req.body.xhsDownloadDir.trim() : '';
  if (!raw) {
    settings.setXhsDownloadDir('');
    const synced = await syncXhsDownloadDir();
    return res.json({ ok: true, xhsDownloadDir: null, synced });
  }
  const expanded = raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw;
  const normalized = path.resolve(expanded);
  if (normalized === path.parse(normalized).root) return res.status(400).json({ error: '解析目录不能设置为磁盘根目录', code: 'invalid_path' });
  try {
    fs.mkdirSync(normalized, { recursive: true });
    if (!fs.statSync(normalized).isDirectory()) throw new Error('目标不是文件夹');
  } catch (error: any) {
    return res.status(400).json({ error: `解析目录不可用：${error?.message || '无法创建或访问文件夹'}`, code: 'invalid_path' });
  }
  settings.setXhsDownloadDir(normalized);
  const synced = await syncXhsDownloadDir();
  return res.json({ ok: true, xhsDownloadDir: normalized, synced });
});

// POST /api/settings/verify { cap } → dry-run 探测 Key 是否可用
settingsRouter.post('/verify', async (req: Request, res: Response) => {
  const { cap } = req.body ?? {};
  if (!cap || !CAP_IDS.includes(cap as CapId)) {
    return res.status(400).json({ error: 'cap 非法' });
  }
  const result = await verifyCap(cap as CapId);
  if (result.ok) settings.markVerified(cap as CapId);
  else settings.clearVerified(cap as CapId);
  res.json(result);
});

settingsRouter.get('/runtime', async (_req: Request, res: Response) => {
  res.json(await runtimeSetupStatus());
});

settingsRouter.post('/runtime/install', async (_req: Request, res: Response) => {
  res.json(await startRuntimeInstall());
});
