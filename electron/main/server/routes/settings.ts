// 设置路由：BACKEND-PATH §6.6（API 契约）
// 明文 Key 绝不出现在 GET 响应体；写入走加密存储。
import { Router, type Request, type Response } from 'express';
import { settings } from '../services/settings.js';
import { CAP_SLOTS, CAP_IDS, type CapId } from '../services/caps.js';
import { verifyCap } from '../services/aiProxy.js';
import { runtimeSetupStatus, startRuntimeInstall } from '../services/runtimeSetup.js';
import { getTunnelClientStatus, installTunnelClient, startTunnelClient, stopTunnelClient } from '../services/tunnelClient.js';

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
  const err = settings.setKey(CAP_SLOTS[cap as CapId].keyId, key ?? '');
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

// POST /api/settings/rootdir { rootDir } → 方案 C 导出根目录
settingsRouter.post('/rootdir', (req: Request, res: Response) => {
  const { rootDir } = req.body ?? {};
  if (!rootDir || typeof rootDir !== 'string') {
    return res.status(400).json({ error: 'rootDir 非法' });
  }
  settings.setRootDir(rootDir);
  res.json({ ok: true });
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

settingsRouter.get('/tunnel', (_req: Request, res: Response) => {
  res.json(getTunnelClientStatus());
});

settingsRouter.post('/tunnel/config', async (req: Request, res: Response) => {
  const { tunnelId, runtimeApiKey } = req.body ?? {};
  const err = settings.setTunnelConfig(tunnelId, runtimeApiKey);
  if (err) return res.status(400).json({ error: err, code: 'invalid_tunnel_config' });
  res.json({ ok: true, status: getTunnelClientStatus() });
});

settingsRouter.post('/tunnel/install', async (_req: Request, res: Response) => {
  try {
    res.json(await installTunnelClient());
  } catch (error: any) {
    res.status(502).json({ error: error?.message || 'tunnel-client 安装失败', code: 'tunnel_install_failed', status: getTunnelClientStatus() });
  }
});

settingsRouter.post('/tunnel/connect', async (_req: Request, res: Response) => {
  res.json(await startTunnelClient());
});

settingsRouter.post('/tunnel/disconnect', async (_req: Request, res: Response) => {
  res.json(await stopTunnelClient());
});
