// Electron 主进程入口：启动 Express 后端（同进程）+ 创建渲染窗口
// 单一事实源：BACKEND-PATH §0（后端跑主进程）/ §7（electron-vite）
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import { createApp } from './server/index.js';
import { startMediaCrawler } from './server/services/mediaCrawler.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let mainWindow: BrowserWindow | null = null;
let server: http.Server | null = null;
let apiBase = '';
let startingServer: Promise<number> | null = null;

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
}

app.whenReady().then(async () => {
  // 本地 API 必须优先可用：即使抓取运行环境首次初始化较慢，设置、素材库、AI 等页面
  // 也不能因此全部出现 Failed to fetch。抓取代理改为窗口创建后后台就绪。
  await startServer();
  ipcMain.handle('api-base', () => apiBase);
  ipcMain.handle('choose-library-root', async () => {
    const options = {
      title: '选择素材库本地目录',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  createWindow();

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
