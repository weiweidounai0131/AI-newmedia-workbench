// Electron 主进程入口：启动 Express 后端（同进程）+ 创建渲染窗口
// 单一事实源：BACKEND-PATH §0（后端跑主进程）/ §7（electron-vite）
import { app, BrowserWindow, ipcMain, dialog, shell, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import { createApp } from './server/index.js';
import { startMediaCrawler } from './server/services/mediaCrawler.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let server: http.Server | null = null;
let apiBase = '';
let startingServer: Promise<number> | null = null;
let updateCheckStarted = false;
let updateEventsBound = false;
let updateCheckInFlight: Promise<UpdateCheckResult> | null = null;
let notifyNoUpdate = false;
let updateStatus: UpdateStatus = { phase: 'idle', percent: 0 };
let macUpdateInstallStarted = false;
let activeUpdateSource: ResolvedUpdateSource | null = null;
let fallbackDownloadPending = false;
let fallbackDownloadAttempted = false;

const LEGACY_MAC_UPDATE_JOB_PREFIX = 'com.newmedia.workbench.update.';
const UPDATE_CACHE_DIR_NAME = 'newmedia-workbench-updater';
let updaterConfigPathPrepared = false;

type UpdateSource = { provider?: string; url?: string; fallbackUrl?: string; timeoutMs?: number };
type ResolvedUpdateSource = {
  primaryUrl: string;
  fallbackUrl?: string;
  timeoutMs: number;
  activeUrl: string;
};
type UpdateCheckResult = { ok: boolean; reason?: 'not-packaged' | 'not-configured' | 'checking' | 'failed' };
type UpdateStatus = {
  phase: 'idle' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  percent: number;
  transferred?: number;
  total?: number;
  version?: string;
  message?: string;
};

function publishUpdateStatus(next: UpdateStatus): void {
  updateStatus = next;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-status', updateStatus);
  if (next.phase === 'downloading' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(Math.max(0, Math.min(1, next.percent / 100)));
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setProgressBar(-1);
  }
}

/** 清理 0.1.11/0.1.12 遗留的 launchd 更新任务，避免它持续重开并激活应用。 */
async function cleanupLegacyMacUpdateJobs(): Promise<void> {
  if (process.platform !== 'darwin') return;

  const labels = await new Promise<string[]>((resolve) => {
    const child = spawn('/bin/launchctl', ['list'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { output += chunk; });
    child.once('error', () => resolve([]));
    child.once('exit', () => {
      resolve(output
        .split('\n')
        .map((line) => line.trim().split(/\s+/).at(-1) || '')
        .filter((label) => label.startsWith(LEGACY_MAC_UPDATE_JOB_PREFIX)));
    });
  });

  await Promise.all(labels.map((label) => new Promise<void>((resolve) => {
    const child = spawn('/bin/launchctl', ['remove', label], { stdio: 'ignore' });
    child.once('error', () => resolve());
    child.once('exit', () => resolve());
  })));
  if (labels.length > 0) console.info(`[updater] 已清理 ${labels.length} 个旧版 macOS 更新任务`);
}

/** macOS 在应用退出后以一次性独立脚本回滚式替换 App，避免安装器静默失败。 */
async function installMacUpdate(downloadedFile: string): Promise<void> {
  if (macUpdateInstallStarted) return;
  macUpdateInstallStarted = true;

  // 直接使用 electron-updater 回调提供的实际下载文件，避免缓存目录名称或文件名
  // 变化后安装脚本找不到 update.zip。
  const zipPath = path.resolve(downloadedFile);
  const cacheDir = path.dirname(path.dirname(zipPath));
  const zipStat = await stat(zipPath);
  if (!zipStat.isFile() || zipStat.size <= 0) throw new Error(`更新文件不存在或为空：${zipPath}`);
  const targetApp = path.resolve(process.execPath, '../../..');
  const stagingDir = path.join(cacheDir, `install-${Date.now()}`);
  const scriptPath = path.join(cacheDir, `apply-update-${Date.now()}.sh`);
  const logPath = path.join(cacheDir, 'apply-update.log');
  await mkdir(cacheDir, { recursive: true });
  const script = `#!/bin/zsh\nset -eu\nzip_path=\"$1\"\ntarget_app=\"$2\"\nstaging_dir=\"$3\"\nlog_path=\"$4\"\nbackup_app=\"${targetApp}.previous\"\nexec > \"$log_path\" 2>&1\necho \"[$(/bin/date)] Start macOS app update\"\necho \"Target: $target_app\"\n/bin/sleep 5\n/bin/rm -rf \"$staging_dir\" \"$backup_app\"\n/bin/mkdir -p \"$staging_dir\"\n/usr/bin/ditto -x -k \"$zip_path\" \"$staging_dir\"\nnew_app=$(/usr/bin/find \"$staging_dir\" -maxdepth 2 -type d -name '*.app' -print -quit)\nif [ -z \"$new_app\" ]; then echo \"No app bundle found\"; exit 1; fi\n/bin/mv \"$target_app\" \"$backup_app\"\nif /bin/mv \"$new_app\" \"$target_app\"; then\n  /usr/bin/xattr -cr \"$target_app\"\n  /usr/bin/codesign --force --deep --sign - \"$target_app\"\n  /bin/rm -rf \"$backup_app\" \"$staging_dir\"\n  echo \"[$(/bin/date)] Update installed; reopening app\"\n  /usr/bin/open \"$target_app\"\nelse\n  echo \"Move failed; restoring previous app\"\n  /bin/mv \"$backup_app\" \"$target_app\"\n  exit 1\nfi\n`;
  await writeFile(scriptPath, script, { mode: 0o700 });
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/bin/zsh', [scriptPath, zipPath, targetApp, stagingDir, logPath], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
  // 一次性安装进程已与当前进程分离，强制退出以释放 App 文件。
  app.exit(0);
}

/**
 * 更新包地址是公开读取地址，不是上传密钥。Cloudflare 为优先节点，国内 OSS 为
 * 自动兜底节点；两端必须发布同一批 latest*.yml、安装包和 blockmap。
 */
async function readUpdateSource(): Promise<ResolvedUpdateSource | null> {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'resources', 'update-source.json')]
    : [path.join(process.cwd(), 'resources', 'update-source.json')];

  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      const source = JSON.parse(raw) as UpdateSource;
      if (source.provider && source.provider !== 'generic') continue;
      if (typeof source.url !== 'string' || !/^https:\/\//i.test(source.url)) continue;
      if (!updaterConfigPathPrepared) {
        const updaterConfigPath = path.join(app.getPath('userData'), 'app-update.yml');
        await writeFile(
          updaterConfigPath,
          `provider: generic\nurl: ${source.url.replace(/\s/g, '')}\nupdaterCacheDirName: ${UPDATE_CACHE_DIR_NAME}\n`,
          'utf8',
        );
        autoUpdater.updateConfigPath = updaterConfigPath;
        updaterConfigPathPrepared = true;
      }
      const fallbackUrl = typeof source.fallbackUrl === 'string' && /^https:\/\//i.test(source.fallbackUrl)
        ? source.fallbackUrl.replace(/\/+$/, '')
        : undefined;
      return {
        primaryUrl: source.url.replace(/\/+$/, ''),
        fallbackUrl,
        timeoutMs: Math.min(15_000, Math.max(3_000, Number(source.timeoutMs) || 6_000)),
        activeUrl: source.url.replace(/\/+$/, ''),
      };
    } catch {
      // 首次发布前或开发环境未配置更新源时，自动更新安静跳过。
    }
  }
  return null;
}

function updateManifestName(): string {
  return process.platform === 'darwin' ? 'latest-mac.yml' : 'latest.yml';
}

/** 在真正交给 electron-updater 前快速探测更新清单，避免国内网络长时间卡在 Cloudflare。 */
async function sourceReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}/${updateManifestName()}`, {
      method: 'HEAD', signal: controller.signal, redirect: 'follow', cache: 'no-store',
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function selectUpdateSource(source: ResolvedUpdateSource): Promise<ResolvedUpdateSource> {
  if (await sourceReachable(source.primaryUrl, source.timeoutMs)) return source;
  if (source.fallbackUrl && await sourceReachable(source.fallbackUrl, source.timeoutMs)) {
    console.info('[updater] Cloudflare 更新节点不可用，已自动切换国内更新节点');
    return { ...source, activeUrl: source.fallbackUrl };
  }
  // 两端探测都异常时仍交给优先节点尝试，electron-updater 会保留具体错误日志。
  return source;
}

function useUpdateSource(source: ResolvedUpdateSource, url = source.activeUrl): void {
  activeUpdateSource = { ...source, activeUrl: url };
  autoUpdater.setFeedURL({ provider: 'generic', url });
}

function bindUpdateEvents(): void {
  if (updateEventsBound) return;
  updateEventsBound = true;

  autoUpdater.on('update-available', async (info) => {
    notifyNoUpdate = false;
    publishUpdateStatus({ phase: 'available', percent: 0, version: info.version });
    if (fallbackDownloadPending) {
      fallbackDownloadPending = false;
      publishUpdateStatus({ phase: 'downloading', percent: 0, version: info.version, message: '已切换国内节点，继续下载更新…' });
      void autoUpdater.downloadUpdate().catch((error) => {
        publishUpdateStatus({ phase: 'error', percent: 0, version: info.version, message: '更新下载失败，请稍后重试。' });
        console.warn('[updater] 国内节点下载更新失败：', error);
      });
      return;
    }
    const options: MessageBoxOptions = {
      type: 'info',
      title: '发现新版本',
      message: `发现 AI新媒体工作台 ${info.version}，建议更新。`,
      detail: '更新包将从已配置的更新源下载；当前数据、素材库和本机登录状态不会被清除。',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      publishUpdateStatus({ phase: 'downloading', percent: 0, version: info.version, message: '正在下载更新…' });
      void autoUpdater.downloadUpdate().catch((error) => {
        publishUpdateStatus({ phase: 'error', percent: 0, version: info.version, message: '更新下载失败，请稍后重试。' });
        console.warn('[updater] 下载更新失败：', error);
      });
    }
  });

  autoUpdater.on('download-progress', (progress) => {
    publishUpdateStatus({
      phase: 'downloading', percent: Math.round(progress.percent), transferred: progress.transferred,
      total: progress.total, message: '正在下载更新…',
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    publishUpdateStatus({ phase: 'downloaded', percent: 100, version: info.version, message: '更新已下载完成，等待安装。' });
    const options: MessageBoxOptions = {
      type: 'info',
      title: '更新已准备就绪',
      message: `AI新媒体工作台 ${info.version} 已下载完成。`,
      detail: '选择“立即重启更新”会关闭工作台并安装新版；选择“稍后”将在下次退出应用时安装。',
      buttons: ['立即重启更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, options)
      : await dialog.showMessageBox(options);
    if (result.response === 0) {
      publishUpdateStatus({ phase: 'installing', percent: 100, version: info.version, message: '正在安装更新并重启…' });
      if (process.platform === 'darwin') {
        const downloadedFile = typeof info.downloadedFile === 'string' ? info.downloadedFile : '';
        void installMacUpdate(downloadedFile).catch((error) => {
          macUpdateInstallStarted = false;
          publishUpdateStatus({ phase: 'error', percent: 100, version: info.version, message: '安装更新失败，请重新下载完整安装包。' });
          console.warn('[updater] macOS 安装更新失败：', error);
        });
      } else {
        autoUpdater.quitAndInstall();
      }
    }
  });

  autoUpdater.on('update-not-available', async (info) => {
    if (!notifyNoUpdate) return;
    notifyNoUpdate = false;
    const options: MessageBoxOptions = {
      type: 'info',
      title: '已是最新版本',
      message: `当前已是最新版本（${info.version}）。`,
      buttons: ['知道了'],
      defaultId: 0,
    };
    if (mainWindow) await dialog.showMessageBox(mainWindow, options);
    else await dialog.showMessageBox(options);
  });

  autoUpdater.on('error', (error) => {
    notifyNoUpdate = false;
    // 更新服务不可用不能影响主流程；详细原因仅写入主进程日志，避免打扰用户。
    console.warn('[updater] 自动更新检查失败：', error);
    if (updateStatus.phase === 'downloading' && activeUpdateSource?.fallbackUrl &&
      activeUpdateSource.activeUrl !== activeUpdateSource.fallbackUrl && !fallbackDownloadAttempted) {
      fallbackDownloadAttempted = true;
      fallbackDownloadPending = true;
      publishUpdateStatus({ phase: 'downloading', percent: 0, message: 'Cloudflare 下载异常，正在切换国内节点…' });
      useUpdateSource(activeUpdateSource, activeUpdateSource.fallbackUrl);
      void autoUpdater.checkForUpdates().catch((retryError) => {
        fallbackDownloadPending = false;
        publishUpdateStatus({ phase: 'error', percent: 0, message: '更新下载失败，请稍后重试。' });
        console.warn('[updater] 国内节点重试失败：', retryError);
      });
      return;
    }
    if (updateStatus.phase === 'downloading') publishUpdateStatus({ phase: 'error', percent: 0, message: '更新下载失败，请稍后重试。' });
  });
}

async function checkForUpdates(manual = false): Promise<UpdateCheckResult> {
  if (!app.isPackaged) return { ok: false, reason: 'not-packaged' };
  if (!manual && updateCheckStarted) return { ok: true };
  if (updateCheckInFlight) return { ok: false, reason: 'checking' };
  updateCheckStarted = true;
  const source = await readUpdateSource();
  if (!source) {
    console.info('[updater] 未配置更新源，本次跳过版本检查');
    return { ok: false, reason: 'not-configured' };
  }

  bindUpdateEvents();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  const selectedSource = await selectUpdateSource(source);
  useUpdateSource(selectedSource);
  fallbackDownloadAttempted = false;
  notifyNoUpdate = manual;
  updateCheckInFlight = autoUpdater.checkForUpdates()
    .then(() => ({ ok: true }))
    .catch((error) => {
      notifyNoUpdate = false;
      console.warn('[updater] 检查更新失败：', error);
      return { ok: false, reason: 'failed' as const };
    })
    .finally(() => { updateCheckInFlight = null; });
  return updateCheckInFlight;
}

// 主进程内起 Express（loopback，仅本机可达）
function startServer(): Promise<number> {
  // macOS 点击关闭窗口并不会退出应用。若本地服务仍然存活，直接复用，避免
  // 从 Dock 再次打开时前端已经出现、后端却已断开的“localhost 未连接”。
  if (server?.listening && apiBase) return Promise.resolve(Number(new URL(apiBase).port));
  if (startingServer) return startingServer;

  const expressApp = createApp();
  startingServer = new Promise((resolve, reject) => {
    server = expressApp.listen(0, '127.0.0.1', () => {
      server!.off('error', onError);
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 8787;
      apiBase = `http://127.0.0.1:${port}`;
      console.log(`[main] 后端已启动 ${apiBase}`);
      resolve(port);
    });
    const onError = (error: Error) => {
      server = null;
      apiBase = '';
      reject(error);
    };
    server.once('error', onError);
  });
  return startingServer.finally(() => { startingServer = null; });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    // 打包后 __dirname 为 app.asar/out/main；渲染页面实际位于 app.asar/out/renderer。
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  await cleanupLegacyMacUpdateJobs();
  // Electron 从启动台打开时的 cwd 可能是“/”。统一把非设置服务使用的
  // 本地状态（冷却、审计、旧版抓取兼容文件等）放到 userData，避免回退到
  // 无权限创建的 /.data，避免应用启动后设置文件和运行数据落到磁盘根目录。
  if (app.isPackaged) process.env.NEWMEDIA_DATA_DIR = app.getPath('userData');
  // 本地 API 必须优先可用：即使抓取运行环境首次初始化较慢，设置、素材库、AI 等页面
  // 也不能因此全部出现 Failed to fetch。抓取代理改为窗口创建后后台就绪。
  await startServer();
  ipcMain.handle('api-base', () => apiBase);
  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('check-for-updates', () => checkForUpdates(true));
  ipcMain.handle('get-update-status', () => updateStatus);
  ipcMain.handle('choose-library-root', async () => {
    const options = {
      title: '选择素材库本地目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle('choose-xhs-download-dir', async () => {
    const options = {
      title: '选择小红书洗稿解析目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  createWindow();

  // 每次打开已安装应用都检查一次版本。更新源尚未配置或暂时不可用时不阻断工作台。
  void checkForUpdates();

  // MediaCrawler 仅服务于平台抓取；失败或较慢不应阻断整个工作台。
  void startMediaCrawler()
    .then(() => console.log('[main] MediaCrawler 代理已启动'))
    .catch((e) => console.warn('[main] MediaCrawler 代理启动失败，抓取功能暂不可用:', e));

  app.on('activate', () => {
    // 在 macOS 中，窗口关闭后应用继续常驻；理论上服务不会关闭，但若被系统
    // 意外释放，也在重新激活时先恢复后端，再创建窗口。
    void startServer()
      .catch((error) => console.error('[main] 重新启动本地后端失败：', error))
      .finally(() => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
  });
});

app.on('window-all-closed', () => {
  // macOS 关闭窗口不是退出应用：必须保留 loopback 后端，供 Dock/启动台再次
  // 打开时直接复用。Windows/Linux 则退出应用并在 before-quit 中统一关闭服务。
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  server?.close();
  server = null;
  apiBase = '';
});
