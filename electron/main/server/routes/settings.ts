// 设置路由：BACKEND-PATH §6.6（API 契约）
// 明文 Key 绝不出现在 GET 响应体；写入走加密存储。
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { settings } from '../services/settings.js';
import { CAP_SLOTS, CAP_IDS, type CapId } from '../services/caps.js';
import { fetchProviderModels, AiProxyError, verifyCap } from '../services/aiProxy.js';
import { ProviderConfigError } from '../services/settings.js';
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

// POST /api/settings/capability { cap, providerId, model } → assign a compatible provider/model pair.
settingsRouter.post('/capability', (req: Request, res: Response) => {
  const { cap, providerId, model } = req.body ?? {};
  if (!cap || !CAP_IDS.includes(cap as CapId) || typeof providerId !== 'string' || typeof model !== 'string') {
    return res.status(400).json({ error: '能力、提供商或模型无效', code: 'bad_request' });
  }
  const error = settings.setCapability(cap as CapId, providerId, model);
  if (error) return res.status(400).json({ error, code: 'incompatible_capability' });
  return res.json({ ok: true });
});

// POST /api/settings/providers/save; API key is accepted for this local request only and persisted encrypted.
settingsRouter.post('/providers/save', (req: Request, res: Response) => {
  try {
    const provider = settings.saveProvider(req.body ?? {});
    return res.json({ ok: true, providerId: provider.id, settings: settings.summary() });
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return res.status(error.status).json({ error: error.message, code: error.code, slots: error.slots });
    }
    return res.status(400).json({ error: '提供商配置未能保存', code: 'invalid_provider' });
  }
});

settingsRouter.post('/providers/key', (req: Request, res: Response) => {
  const { providerId, key } = req.body ?? {};
  if (typeof providerId !== 'string' || typeof key !== 'string') {
    return res.status(400).json({ error: '提供商或 Key 无效', code: 'bad_request' });
  }
  const error = settings.setProviderKey(providerId, key);
  if (error) return res.status(400).json({ error, code: 'invalid_key' });
  return res.json({ ok: true, settings: settings.summary() });
});

settingsRouter.delete('/providers/:id', (req: Request, res: Response) => {
  try {
    settings.deleteProvider(req.params.id);
    return res.json({ ok: true, settings: settings.summary() });
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return res.status(error.status).json({ error: error.message, code: error.code, slots: error.slots });
    }
    return res.status(400).json({ error: '提供商未能删除', code: 'provider_delete_failed' });
  }
});

settingsRouter.delete('/providers/:id/config', (req: Request, res: Response) => {
  const cap = req.query.cap as string;
  const model = req.query.model as string;
  if (!CAP_IDS.includes(cap as CapId) || typeof model !== 'string' || !model) {
    return res.status(400).json({ error: '能力类型或模型无效', code: 'bad_request' });
  }
  try {
    settings.deleteCapabilityConfig(cap as CapId, req.params.id, model);
    return res.json({ ok: true, settings: settings.summary() });
  } catch (error) {
    if (error instanceof ProviderConfigError) {
      return res.status(error.status).json({ error: error.message, code: error.code, slots: error.slots });
    }
    return res.status(400).json({ error: '配置未能删除', code: 'provider_config_delete_failed' });
  }
});

// POST /api/settings/providers/models; this discovers IDs only and never marks a capability verified.
settingsRouter.post('/providers/models', async (req: Request, res: Response) => {
  const controller = new AbortController();
  const abortIfClientLeft = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', abortIfClientLeft);
  try {
    const result = await fetchProviderModels(req.body ?? {}, controller.signal);
    return res.json(result);
  } catch (error) {
    const safe = error instanceof AiProxyError
      ? error
      : new AiProxyError('upstream_error', '模型列表请求失败，请检查网络或代理设置');
    return res.status(safe.status ?? 502).json({ error: safe.message, code: safe.code });
  } finally {
    res.off('close', abortIfClientLeft);
  }
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
  res.json(result);
});

settingsRouter.get('/runtime', async (_req: Request, res: Response) => {
  res.json(await runtimeSetupStatus());
});

settingsRouter.post('/runtime/install', async (_req: Request, res: Response) => {
  res.json(await startRuntimeInstall());
});
