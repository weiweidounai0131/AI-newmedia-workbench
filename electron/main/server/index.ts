// Express 后端装配：BACKEND-PATH §0（后端跑主进程）/ §6.2（AI 代理层）
// 既被 Electron 主进程引用，也可被 Node 独立运行（dev.ts）以便 M1 验证 AI 链路。
import express, { type Express } from 'express';
import { settingsRouter } from './routes/settings.js';
import { aiRouter } from './routes/ai.js';
import { libraryRouter } from './routes/library.js';
import { contentRouter } from './routes/content.js';
import { scrapeRouter } from './routes/scrape.js';
import { scheduleDailyDownloadCacheCleanup } from './services/downloadCache.js';
import { hasActiveDownloadTask } from './services/wechatMpTools.js';
import { mcpRouter } from './routes/mcp.js';

export function createApp(): Express {
  // 解析下载仅作为 AI 识别的临时输入；每天 0 点清空，避免长期积累占满磁盘。
  // 若软件当时未运行，下次启动会补清当天尚未清过的旧缓存。
  scheduleDailyDownloadCacheCleanup(hasActiveDownloadTask);
  const app = express();
  // 图片 base64（参考图 ≤14 张）可能较大，放宽 body 上限
  app.use(express.json({ limit: '25mb' }));

  // CORS：后端仅监听 127.0.0.1，外部源无法连入。因此按请求 Origin 回显即可放行本地渲染进程
  // （Electron app:// 或 file:// 源、headless 测试），无 Origin 时退化为 *。不计凭据攻击面。
  app.use((req, res, next) => {
    const origin = req.headers.origin as string | undefined;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  app.use('/api/settings', settingsRouter);
  app.use('/api/ai', aiRouter);
  app.use('/api/library', libraryRouter); // M3 素材库本地直写
  app.use('/api/content', contentRouter); // M3 热榜 / 搜索数据源
  app.use('/api/scrape', scrapeRouter); // M4 抓取：登录态 + 状态
  // 网页 ChatGPT 的 MCP 备用工作流入口；不替换现有 /api 链路。
  app.use('/mcp', mcpRouter);

  return app;
}
