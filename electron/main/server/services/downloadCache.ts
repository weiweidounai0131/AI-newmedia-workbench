import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userRuntimeDataDir } from './runtimePaths.js';

const DOWNLOAD_FOLDERS = ['douyin_downloads', 'xhs_downloads'] as const;
const MARKER_FILE = '.download-cache-cleanup.json';
let timer: NodeJS.Timeout | null = null;
let started = false;
let cleaning = false;

function localDay(value = new Date()): string {
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function nextMidnightDelay(): number {
  const next = new Date();
  next.setHours(24, 0, 2, 0);
  return Math.max(1_000, next.getTime() - Date.now());
}

async function markerPath(): Promise<string> {
  return path.join(await userRuntimeDataDir(), MARKER_FILE);
}

async function alreadyCleanedToday(): Promise<boolean> {
  try {
    const record = JSON.parse(fs.readFileSync(await markerPath(), 'utf8'));
    return record?.day === localDay();
  } catch {
    return false;
  }
}

async function writeMarker(removed: number): Promise<void> {
  fs.writeFileSync(await markerPath(), JSON.stringify({ day: localDay(), cleanedAt: new Date().toISOString(), removed }), 'utf8');
}

/** 仅返回下载缓存根目录；不包含 Cookie、配置或素材库根目录。 */
async function downloadDataRoots(): Promise<string[]> {
  const runtime = await userRuntimeDataDir();
  const roots = [
    // 工作台自动拉起的 wechat-mp-tools 数据目录（不同版本会在 data 下或直接落盘）。
    path.join(runtime, 'wechat-mp-tools', 'data'),
    path.join(runtime, 'wechat-mp-tools'),
    // 用户已安装的原下载工具数据目录。
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'WeChat MP Tools', 'data')
      : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WeChat MP Tools', 'data'),
  ];
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

/**
 * 清理 AI 识别的临时下载文件。目录本身会重新建立，避免下一次解析因目录不存在失败。
 * 素材库导出文件位于独立目录，不在本方法的目标范围内。
 */
export async function clearDownloadedMediaCache(): Promise<number> {
  const roots = await downloadDataRoots();
  let removed = 0;
  for (const root of roots) {
    for (const name of DOWNLOAD_FOLDERS) {
      const target = path.join(root, name);
      // target 是由受控根目录 + 固定文件夹名组成，避免误删用户任意目录。
      if (fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 });
        removed += 1;
      }
      fs.mkdirSync(target, { recursive: true });
    }
  }
  return removed;
}

async function cleanupIfDue(isBusy: () => boolean): Promise<boolean> {
  if (cleaning || await alreadyCleanedToday()) return false;
  if (isBusy()) {
    console.log('[cache] 有下载任务进行中，延后清理解析缓存');
    return true;
  }
  cleaning = true;
  try {
    const removed = await clearDownloadedMediaCache();
    await writeMarker(removed);
    console.log(`[cache] 已完成每日解析缓存清理（${removed} 个目录）`);
  } catch (error) {
    console.warn('[cache] 每日解析缓存清理失败：', error);
  } finally {
    cleaning = false;
  }
  return false;
}

/** 启动时补清一次旧缓存；之后每个本地 0 点自动执行。 */
export function scheduleDailyDownloadCacheCleanup(isBusy: () => boolean = () => false): void {
  if (started) return;
  started = true;
  void cleanupIfDue(isBusy);

  const scheduleNext = (delay = nextMidnightDelay()) => {
    timer = setTimeout(async () => {
      const retrySoon = await cleanupIfDue(isBusy);
      // 0 点刚好有下载任务时，最多等待一分钟后再检查，避免误删正在识别的媒体。
      scheduleNext(retrySoon ? 60_000 : nextMidnightDelay());
    }, delay);
  };
  scheduleNext();
}

export function stopDailyDownloadCacheCleanup(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  started = false;
}
