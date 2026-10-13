import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { bundledRuntimeRoot, playwrightBrowsersPath, pythonExecutable, userRuntimeDataDir } from './runtimePaths.js';
import { rememberXhsDownloadDir, resolveXhsDownloadDir } from './downloadPaths.js';
import { settings } from './settings.js';

const BASE_URL = process.env.WECHAT_MP_TOOLS_URL || 'http://127.0.0.1:5200';
let startupPromise: Promise<void> | null = null;

async function toolRoot(): Promise<string> {
  if (process.env.WECHAT_MP_TOOLS_ROOT) return process.env.WECHAT_MP_TOOLS_ROOT;
  const bundled = await bundledRuntimeRoot();
  return bundled ? path.join(bundled, 'wechat-mp-tools') : path.resolve(process.cwd(), 'tools', 'wechat-mp-tools');
}

async function xhsDownloadRoots(): Promise<string[]> {
  const runtimeData = await userRuntimeDataDir();
  const bundled = await bundledRuntimeRoot();
  const root = await toolRoot();
  const configuredDataRoot = process.env.WECHAT_MP_TOOLS_DATA_DIR;
  return [
    process.env.WECHAT_MP_TOOLS_XHS_DOWNLOAD_DIR,
    settings.xhsDownloadDir,
    configuredDataRoot && path.join(configuredDataRoot, 'xhs_downloads'),
    configuredDataRoot && path.join(configuredDataRoot, 'data', 'xhs_downloads'),
    path.join(runtimeData, 'wechat-mp-tools', 'xhs_downloads'),
    path.join(runtimeData, 'wechat-mp-tools', 'data', 'xhs_downloads'),
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'WeChat MP Tools', 'data', 'xhs_downloads')
      : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'WeChat MP Tools', 'data', 'xhs_downloads'),
    path.join(root, 'data', 'xhs_downloads'),
    bundled && path.join(bundled, 'wechat-mp-tools', 'data', 'xhs_downloads'),
  ].filter((value): value is string => Boolean(value));
}

export interface DouyinDownloadTask {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  link: string;
  message?: string;
  error?: string;
  result?: { path: string; title?: string; sizeBytes?: number };
}

const tasks = new Map<string, DouyinDownloadTask>();

export interface XhsDownloadTask {
  id: string;
  status: 'starting' | 'running' | 'completed' | 'failed';
  link: string;
  message?: string;
  error?: string;
  result?: { path: string; title?: string };
}

const xhsTasks = new Map<string, XhsDownloadTask>();

async function serviceIsReady(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/settings`, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * 开发阶段从项目内的 wechat-mp-tools 源码拉起本地服务。
 * 下载工具被用户关闭后，下一次解析会自动恢复，不要求手工打开原桌面 App。
 */
async function ensureService(): Promise<void> {
  if (await serviceIsReady()) {
    await syncXhsDownloadDir();
    return;
  }
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    const root = await toolRoot();
    const bundled = await bundledRuntimeRoot();
    const sharedPython = bundled ? pythonExecutable(path.join(bundled, 'python')) : '';
    const legacyVenv = path.join(root, 'venv');
    const pythonCandidates = [
      sharedPython,
      pythonExecutable(fs.existsSync(legacyVenv) ? legacyVenv : path.join(root, 'venv312')),
    ].filter(Boolean);
    const python = pythonCandidates.find((candidate) => fs.existsSync(candidate)) || pythonCandidates[0];
    const entryCandidates = [path.join(root, 'workbench_app.py'), path.join(root, 'app.py')];
    const entry = entryCandidates.find((candidate) => fs.existsSync(candidate)) || entryCandidates[0];
    if (!python || !fs.existsSync(python) || !fs.existsSync(entry)) {
      throw new Error('本地下载服务未安装完成：缺少精简下载运行环境');
    }
    const dataRoot = path.join(await userRuntimeDataDir(), 'wechat-mp-tools');
    const child = spawn(python, [path.basename(entry), '--no-browser', '--port', '5200'], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        WECHAT_MP_TOOLS_DATA_DIR: dataRoot,
        WECHAT_MP_TOOLS_XHS_DOWNLOAD_DIR: settings.xhsDownloadDir || path.join(dataRoot, 'data', 'xhs_downloads'),
        WECHAT_MP_TOOLS_RESOURCES_DIR: root,
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
      },
    });
    child.unref();

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await delay(500);
      if (await serviceIsReady()) {
        await syncXhsDownloadDir();
        return;
      }
    }
    throw new Error('本地下载服务启动超时，请稍后重试');
  })().finally(() => { startupPromise = null; });
  return startupPromise;
}

/** 将工作台设置的固定目录同步到正在运行的 wechat-mp-tools；服务未启动时由下一次拉起时的环境变量接管。 */
export async function syncXhsDownloadDir(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ xhs_download_dir: settings.xhsDownloadDir || null }),
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function recordTimeMs(value: unknown): number {
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  if (typeof value !== 'string') return 0;
  // wechat-mp-tools 的历史时间是“2026-08-10 13:50:00”字符串，不能用 Number() 解析。
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function remoteJson(pathname: string, init?: RequestInit): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(5 * 60_000),
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    });
  } catch (error: any) {
    const message = String(error?.message || '');
    if (/fetch failed|ECONNREFUSED|network/i.test(message)) {
      throw new Error('本地下载服务连接失败，已尝试自动启动；请稍后重新解析');
    }
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.error) throw new Error(data?.error || `wechat-mp-tools 返回 HTTP ${response.status}`);
  return data;
}

async function resolveDownloadedFile(title: string | undefined, notBefore: number): Promise<{ path: string; title?: string; sizeBytes?: number }> {
  const history = await remoteJson('/api/douyin/history');
  const rows = Array.isArray(history) ? history : [];
  // 原软件的历史会保留旧任务。只允许导入本次任务开始后新写入的记录，
  // 防止下载失败时意外把上一次视频带入当前洗稿。
  const fresh = rows
    .filter((row: any) => row?.type === '视频' && row?.path && recordTimeMs(row?.time) >= notBefore - 5_000)
    .sort((a: any, b: any) => recordTimeMs(b.time) - recordTimeMs(a.time));
  const item = fresh.find((row: any) => !title || row.title === title) || fresh[0];
  if (!item?.path || !fs.existsSync(item.path)) throw new Error('原下载软件已返回成功，但未找到落盘的视频文件');
  const stat = fs.statSync(item.path);
  if (!stat.isFile() || stat.size <= 0) throw new Error('原下载软件返回的视频文件为空');
  return { path: item.path, title: item.title || title, sizeBytes: stat.size };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRemoteTask(task: DouyinDownloadTask): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const progress = await remoteJson('/api/douyin/progress');
    task.message = String(progress?.current || progress?.message || '原软件正在下载抖音视频');
    if (progress?.status === 'completed') return;
    if (progress?.status === 'failed' || progress?.status === 'cancelled') {
      throw new Error(String(progress?.error || progress?.message || '原软件下载未完成'));
    }
    await delay(1_000);
  }
  throw new Error('原软件下载等待超时，请在弹窗中确认下载状态后重试');
}

async function runTask(task: DouyinDownloadTask): Promise<void> {
  task.status = 'running';
  const startedAt = Date.now();
  try {
    await ensureService();
    const data = await remoteJson('/api/douyin/download-single', {
      method: 'POST',
      body: JSON.stringify({ url: task.link }),
    });
    if (data?.task_started) await waitForRemoteTask(task);
    const result = await resolveDownloadedFile(data?.title, startedAt);
    task.status = 'completed';
    task.message = data?.message || '抖音视频下载成功';
    task.result = { ...result, title: data?.title || result.title, sizeBytes: data?.data?.size_bytes || result.sizeBytes };
  } catch (error: any) {
    task.status = 'failed';
    task.error = error?.message || 'wechat-mp-tools 抖音下载失败';
  }
}

export function startDouyinDownload(link: string): { taskId: string; serviceUrl: string } {
  const id = randomUUID();
  const task: DouyinDownloadTask = { id, status: 'starting', link };
  tasks.set(id, task);
  void runTask(task);
  return { taskId: id, serviceUrl: BASE_URL };
}

export function getDouyinDownloadTask(taskId: string): DouyinDownloadTask | null {
  return tasks.get(taskId) || null;
}

async function waitForXhsTask(task: XhsDownloadTask): Promise<{ path: string; title?: string }> {
  const data = await remoteJson('/api/xhs/download', {
    method: 'POST',
    body: JSON.stringify({ urls: [task.link] }),
  });
  const remoteTaskId = data?.task_id;
  if (!remoteTaskId) throw new Error('原下载软件未返回小红书任务编号');
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const progress = await remoteJson(`/api/xhs/download-status/${encodeURIComponent(remoteTaskId)}`);
    task.message = String(progress?.current || '原软件正在下载小红书图文');
    if (progress?.status === 'completed') {
      let item = Array.isArray(progress?.results) ? progress.results.find((row: any) => row?.success && row?.path) : undefined;
      const noteId = task.link.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9]+)/)?.[1];
      // 原软件发现同一笔记已经下载时会返回 skipped，任务结果不再带 path；
      // 此时按同一 note_id 从它自己的历史记录取回既有本地目录即可，不需要重复访问平台。
      if (!item) {
        const history = await remoteJson('/api/xhs/history?limit=100');
        const historyRows = Array.isArray(history?.history) ? history.history : [];
        item = historyRows.find((row: any) => row?.success && row?.path && (!noteId || row?.note_id === noteId));
      }
      const resolvedPath = resolveXhsDownloadDir(item?.path, await xhsDownloadRoots(), {
        noteId,
        title: item?.title || task.link,
      });
      if (!resolvedPath) {
        // 目录已被移动/清理时，不要把旧历史记录继续当成成功结果，给出可操作的提示。
        throw new Error('原下载软件已完成，但实际图文目录不存在；请重新下载该链接');
      }
      rememberXhsDownloadDir(resolvedPath);
      return { path: resolvedPath, title: item?.title };
    }
    if (progress?.status === 'failed' || progress?.status === 'cancelled') {
      const detail = Array.isArray(progress?.results) ? progress.results.find((row: any) => row?.error)?.error : '';
      throw new Error(String(detail || progress?.current || '原软件下载未完成'));
    }
    await delay(1_000);
  }
  throw new Error('原软件下载等待超时，请在弹窗中确认下载状态后重试');
}

async function runXhsTask(task: XhsDownloadTask): Promise<void> {
  task.status = 'running';
  try {
    await ensureService();
    task.result = await waitForXhsTask(task);
    task.status = 'completed';
    task.message = '小红书图文下载成功';
  } catch (error: any) {
    task.status = 'failed';
    task.error = error?.message || 'wechat-mp-tools 小红书下载失败';
  }
}

/** 小红书仅处理图文：由原工具下载图片序列与文案.txt，再交给本地 AI 链路。 */
export function startXhsDownload(link: string): { taskId: string; serviceUrl: string } {
  const id = randomUUID();
  const task: XhsDownloadTask = { id, status: 'starting', link };
  xhsTasks.set(id, task);
  void runXhsTask(task);
  return { taskId: id, serviceUrl: BASE_URL };
}

export function getXhsDownloadTask(taskId: string): XhsDownloadTask | null {
  return xhsTasks.get(taskId) || null;
}

/** 每日清理时避开仍在下载中的解析任务。 */
export function hasActiveDownloadTask(): boolean {
  return [...tasks.values(), ...xhsTasks.values()].some((task) => task.status === 'starting' || task.status === 'running');
}
