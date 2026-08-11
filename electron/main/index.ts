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

// 主进程内起 Express（loopback，仅本机可达）
function startServer(): Promise<number> {
  const expressApp = createApp();
  return new Promise((resolve) => {
    server = expressApp.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 8787;
      apiBase = `http://127.0.0.1:${port}`;
      console.log(`[main] 后端已启动 ${apiBase}`);
      resolve(port);
    });
  });
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
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  server?.close();
  if (process.platform !== 'darwin') app.quit();
});
