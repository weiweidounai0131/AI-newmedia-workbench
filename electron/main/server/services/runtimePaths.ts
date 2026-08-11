import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let cachedApp: any | null | undefined;

async function electronApp(): Promise<any | null> {
  if (cachedApp !== undefined) return cachedApp;
  try {
    const mod = await import('electron');
    cachedApp = (mod as any).app || null;
  } catch {
    cachedApp = null;
  }
  return cachedApp;
}

export function runtimePlatform(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (process.platform === 'win32') return process.arch === 'arm64' ? 'win-arm64' : 'win-x64';
  return `${process.platform}-${process.arch}`;
}

/** Runtime files are read-only; cookies, profiles and downloads belong in userData. */
export async function bundledRuntimeRoot(): Promise<string | null> {
  if (process.env.NEWMEDIA_RUNTIME_ROOT) return process.env.NEWMEDIA_RUNTIME_ROOT;
  const app = await electronApp();
  if (!app?.isPackaged) return null;
  const root = path.join((process as any).resourcesPath, 'resources', 'runtime', runtimePlatform());
  if (fs.existsSync(root)) return root;
  const installed = path.join(app.getPath('userData'), 'runtime');
  return fs.existsSync(installed) ? installed : null;
}

export async function runtimeInstallRoot(): Promise<string> {
  const app = await electronApp();
  const root = app?.getPath?.('userData') || path.join(os.homedir(), '.ai-newmedia-workbench');
  const dir = path.join(root, 'runtime');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function bootstrapRoot(): Promise<string | null> {
  const app = await electronApp();
  if (!app?.isPackaged) return path.join(process.cwd(), 'tools');
  const root = path.join((process as any).resourcesPath, 'resources', 'bootstrap');
  return fs.existsSync(root) ? root : null;
}

export async function userRuntimeDataDir(): Promise<string> {
  const app = await electronApp();
  const root = app?.getPath?.('userData') || path.join(os.homedir(), '.ai-newmedia-workbench');
  const dir = path.join(root, 'runtime-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Playwright 的浏览器运行时使用系统标准缓存目录。
 * 安装与实际抓取必须共享同一位置；不能把浏览器下载到 userData/runtime 后，
 * 又让 MediaCrawler 去另一个目录寻找。
 */
export function playwrightBrowsersPath(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

export function pythonExecutable(venvRoot: string): string {
  return process.platform === 'win32'
    ? path.join(venvRoot, 'Scripts', 'python.exe')
    : path.join(venvRoot, 'bin', 'python');
}
