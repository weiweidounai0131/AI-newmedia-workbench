// 内容数据源路由（M3→M4）：热榜 / 搜索
//
// 重点：不再静默返回「策展样本」假装搜索成功。真实抓取失败 / 未登录 / 风控时，
// 返回 live:false + 明确的 reason/message + 空 items，让前端提示用户处理。
import { Router, type Request, type Response } from 'express';
import { fetchSearch } from '../services/scrape.js';
import { fetchAllHotRanks, fetchHotRank, HOT_RANK_PLATFORMS, type HotRankPlatform } from '../services/hotRank.js';
import { acquirePlatformAction, releasePlatformAction } from '../services/cooldown.js';

export const contentRouter = Router();
const SEARCH_PLATFORMS = ['抖音', '小红书'] as const;

// GET /api/hot?platform=抖音 → 该平台热榜；无 platform → 四平台全量
// 热榜使用 vikiboss/60s 的公开 API，本地适配后最多返回 20 条/平台。
contentRouter.get('/hot', async (req: Request, res: Response) => {
  const platform = String(req.query.platform || '');
  if (platform) {
    if (!HOT_RANK_PLATFORMS.includes(platform as HotRankPlatform)) {
      return res.status(400).json({ platform, items: [], live: false, reason: 'unsupported_platform', message: `暂不支持「${platform}」热榜` });
    }
    try {
      const items = await fetchHotRank(platform as HotRankPlatform);
      return res.json({ platform, items, live: true, source: 'vikiboss/60s', limit: 20 });
    } catch (error: any) {
      return res.status(503).json({ platform, items: [], live: false, reason: 'upstream_unavailable', message: `热榜加载失败：${error?.message || '上游不可用'}` });
    }
  }

  const { items, failed } = await fetchAllHotRanks();
  const live = Object.keys(items).length > 0;
  return res.status(live ? 200 : 503).json({
    items,
    live,
    source: 'vikiboss/60s',
    limit: 20,
    ...(failed.length ? { failed, message: `未能加载：${failed.join('、')}` } : {}),
  });
});

// GET /api/search?kw=...&platform=... → 搜索结果（MediaCrawler 代理）
contentRouter.get('/search', async (req: Request, res: Response) => {
  const kw = String(req.query.kw || '').trim();
  const platform = String(req.query.platform || '');

  if (!kw) {
    return res.json({ kw, platform, items: [], live: false, reason: 'empty_keyword', message: '关键词为空' });
  }
  if (!SEARCH_PLATFORMS.includes(platform as (typeof SEARCH_PLATFORMS)[number])) {
    return res.status(400).json({
      kw,
      platform,
      items: [],
      live: false,
      reason: 'unsupported_platform',
      message: '主动搜索当前仅支持抖音、小红书',
    });
  }
  const permit = acquirePlatformAction('topic', platform);
  if (!permit.ok) {
    return res.status(429).json({
      kw, platform, items: [], live: false, code: 'cooldown', remainingSec: permit.remainingSec,
      message: `为降低风控风险，「${platform}」请在 ${permit.remainingSec} 秒后再进行主动搜索`,
    });
  }

  const r = await fetchSearch(platform, kw);
  if (r.live) {
    return res.json({ kw, platform, items: r.items, live: true });
  }

  // 本地服务没有启动时，尚未向平台发起任何动作，不应消耗用户的搜索冷却。
  if (r.reason === 'proxy_unavailable') releasePlatformAction('topic', platform);

  return res.json({
    kw,
    platform,
    items: [],
    live: false,
    reason: r.reason ?? 'unknown',
    message: r.message ?? '未获取到真实搜索结果',
  });
});
