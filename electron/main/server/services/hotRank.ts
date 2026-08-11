// 热榜数据适配层：使用 vikiboss/60s 的公开 API。
// 不复制或嵌入上游项目；仅消费其公开接口，并在本地做统一字段与缓存处理。

export const HOT_RANK_PLATFORMS = ['抖音', '小红书', '微博', '知乎'] as const;
export type HotRankPlatform = (typeof HOT_RANK_PLATFORMS)[number];

export interface HotRankItem {
  t: string;
  heat: string;
  tag?: string;
  link: string;
}

const SOURCE_PATH: Record<HotRankPlatform, string> = {
  抖音: 'douyin',
  小红书: 'rednote',
  微博: 'weibo',
  知乎: 'zhihu',
};

const DISPLAY_LIMIT = 20;
// 热榜在每个整点切换数据版本：同一小时内首页、选题页和多次切页都复用同一份。
const cache = new Map<HotRankPlatform, { hourKey: string; items: HotRankItem[] }>();
const inflight = new Map<HotRankPlatform, Promise<HotRankItem[]>>();

function currentHourKey(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}`;
}

function baseUrl(): string {
  return (process.env.HOT_RANK_API_BASE || 'https://60s.viki.moe').replace(/\/$/, '');
}

function compactHeat(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 1e8) return `${(value / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
    if (value >= 1e4) return `${(value / 1e4).toFixed(1).replace(/\.0$/, '')}w`;
    return String(value);
  }
  return String(value ?? '');
}

function fallbackLink(platform: HotRankPlatform, title: string): string {
  const q = encodeURIComponent(title);
  const fallbacks: Record<HotRankPlatform, string> = {
    抖音: `https://www.douyin.com/search/${q}`,
    小红书: `https://www.xiaohongshu.com/search_result?keyword=${q}&type=51`,
    微博: `https://s.weibo.com/weibo?q=${q}`,
    知乎: `https://www.zhihu.com/search?type=content&q=${q}`,
  };
  return fallbacks[platform];
}

function normalizeItem(platform: HotRankPlatform, raw: Record<string, unknown>): HotRankItem | null {
  const title = String(raw.title || '').trim();
  if (!title) return null;
  const tag = String(raw.word_type || raw.tag || '').trim();
  return {
    t: title,
    heat: compactHeat(raw.score ?? raw.hot_value_desc ?? raw.hot_value ?? raw.heat),
    ...(tag && tag !== '无' ? { tag } : {}),
    link: String(raw.link || fallbackLink(platform, title)),
  };
}

export async function fetchHotRank(platform: HotRankPlatform): Promise<HotRankItem[]> {
  const cached = cache.get(platform);
  const hourKey = currentHourKey();
  if (cached?.hourKey === hourKey) return cached.items;
  const pending = inflight.get(platform);
  if (pending) return pending;

  const request = (async () => {
    try {
    const response = await fetch(`${baseUrl()}/v2/${SOURCE_PATH[platform]}`, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`上游返回 ${response.status}`);

    const body = (await response.json()) as { code?: number; data?: unknown };
    if (body.code && body.code !== 200) throw new Error(`上游请求失败（${body.code}）`);
    if (!Array.isArray(body.data)) throw new Error('上游未返回热榜列表');

    const items = body.data
      .map((item) => normalizeItem(platform, (item || {}) as Record<string, unknown>))
      .filter((item): item is HotRankItem => item !== null)
      .slice(0, DISPLAY_LIMIT);

      cache.set(platform, { items, hourKey, });
    return items;
    } catch (error) {
    // 网络短暂波动时仍优先展示上次成功结果，避免首页与选题页突然清空。
      if (cached) return cached.items;
      throw error;
    } finally {
      inflight.delete(platform);
    }
  })();
  inflight.set(platform, request);
  return request;
}

export async function fetchAllHotRanks(): Promise<{ items: Record<HotRankPlatform, HotRankItem[]>; failed: HotRankPlatform[] }> {
  const results = await Promise.allSettled(HOT_RANK_PLATFORMS.map((platform) => fetchHotRank(platform)));
  const items = {} as Record<HotRankPlatform, HotRankItem[]>;
  const failed: HotRankPlatform[] = [];
  results.forEach((result, index) => {
    const platform = HOT_RANK_PLATFORMS[index];
    if (result.status === 'fulfilled') items[platform] = result.value;
    else failed.push(platform);
  });
  return { items, failed };
}
