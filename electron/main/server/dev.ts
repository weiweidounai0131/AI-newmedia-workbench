// 独立运行入口：不依赖 Electron，直接在 Node 起 Express 后端，
// 并自动拉起 MediaCrawler Python 代理（8091），用于「浏览器本地端口」测试整条链路。
// 运行：npm run dev:server  （可加 PORT=8787 / MC_HEADLESS=0）
import { createApp } from './index.js';
import { startMediaCrawler, stopMediaCrawler } from './services/mediaCrawler.js';

const PORT = Number(process.env.PORT || 8787);
const app = createApp();

app.listen(PORT, () => {
  console.log('────────────────────────────────────────────');
  console.log(`[M1] aiProxy 后端已启动：http://127.0.0.1:${PORT}`);
  console.log('  健康检查：  GET  /api/health');
  console.log('  抓取状态：  GET  /api/scrape/status');
  console.log('  二维码登录：POST /api/scrape/login/qr');
  console.log('  搜索：      GET  /api/content/search?kw=&platform=');
  console.log('────────────────────────────────────────────');

  // 自动拉起 MediaCrawler 代理（best-effort，失败不阻断后端）
  startMediaCrawler()
    .then(() => console.log('[mc] MediaCrawler 代理已就绪（端口 8091）'))
    .catch((e) => console.warn('[mc] 代理启动失败，抓取功能将不可用：', e?.message || e));
});

// 关闭时停掉代理子进程
process.on('SIGINT', () => {
  stopMediaCrawler().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  stopMediaCrawler().finally(() => process.exit(0));
});
