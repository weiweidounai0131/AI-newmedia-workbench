// M4 抓取路由：登录态 + 状态查询（MediaCrawler 代理版）
// 单一事实源：BACKEND-PATH §5（抓取账号）
import { Router, type Request, type Response } from 'express';
import { login, loginQr, loginSession, status, SCRAPE_PLATFORMS, ScrapeError } from '../services/scrape.js';
import { cooldownStatus } from '../services/cooldown.js';

export const scrapeRouter = Router();

// GET /api/scrape/cooldowns → 前端倒计时展示；真正拦截仍由调用接口执行。
scrapeRouter.get('/cooldowns', (req: Request, res: Response) => {
  const scope = req.query.scope === 'rewrite' ? 'rewrite' : 'topic';
  res.json(cooldownStatus(scope, String(req.query.platform || '') || undefined));
});

// GET /api/scrape/status → { electron, platforms: {抖音:bool,...} }
scrapeRouter.get('/status', async (_req: Request, res: Response) => {
  try {
    const st = await status();
    res.json(st);
  } catch (err) {
    res.status(502).json({ error: String(err), code: 'proxy_error' });
  }
});

// POST /api/scrape/login { platform } → 兼容旧契约，仅返回登录态（不再直接弹窗）
scrapeRouter.post('/login', async (req: Request, res: Response) => {
  const { platform } = req.body ?? {};
  if (!SCRAPE_PLATFORMS.includes(platform as any)) {
    return res.status(400).json({ error: 'platform 非法', code: 'bad_request' });
  }
  try {
    const r = await login(platform);
    res.json({ ...r, platforms: (await status()).platforms });
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(502).json({ error: String(err), code: 'unknown' });
  }
});

// POST /api/scrape/login/qr { platform } → 打开有头浏览器并返回二维码
scrapeRouter.post('/login/qr', async (req: Request, res: Response) => {
  const { platform } = req.body ?? {};
  if (!SCRAPE_PLATFORMS.includes(platform as any)) {
    return res.status(400).json({ error: 'platform 非法', code: 'bad_request' });
  }
  try {
    const r = await loginQr(platform);
    res.json(r);
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(502).json({ error: String(err), code: 'unknown' });
  }
});

// GET /api/scrape/login/session?platform=xxx → 轮询登录结果
scrapeRouter.get('/login/session', async (req: Request, res: Response) => {
  const platform = String(req.query.platform || '');
  if (!SCRAPE_PLATFORMS.includes(platform as any)) {
    return res.status(400).json({ error: 'platform 非法', code: 'bad_request' });
  }
  try {
    const r = await loginSession(platform);
    res.json(r);
  } catch (err) {
    if (err instanceof ScrapeError) return res.status(err.status).json({ error: err.message, code: err.code });
    return res.status(502).json({ error: String(err), code: 'unknown' });
  }
});
