import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { bootstrapRoot, bundledRuntimeRoot, playwrightBrowsersPath, pythonExecutable, runtimeInstallRoot, userRuntimeDataDir } from './runtimePaths.js';

export interface RuntimeSetupStatus {
  packaged: boolean;
  ready: boolean;
  installing: boolean;
  phase: string;
  message: string;
  components: { id: string; label: string; ready: boolean; detail: string }[];
}

let installProcess: Promise<void> | null = null;
let phase = '未检测';
let message = '首次使用抓取功能前，请完成环境检查。';

function isPackaged(): boolean {
  return typeof process.versions.electron !== 'undefined' && !(process as any).defaultApp;
}

function hasChromium(): boolean {
  try {
    return fs.readdirSync(playwrightBrowsersPath()).some((name) => name.startsWith('chromium-'));
  } catch {
    return false;
  }
}

function runtimeFiles(root: string | null) {
  if (!root) return { media: false, wechat: false };
  return {
    media: fs.existsSync(pythonExecutable(path.join(root, 'media-crawler', 'venv')))
      && fs.existsSync(path.join(root, 'media-crawler', 'proxy', 'server.py'))
      && fs.existsSync(path.join(root, 'media-crawler', 'upstream', 'main.py')),
    wechat: fs.existsSync(pythonExecutable(path.join(root, 'wechat-mp-tools', 'venv')))
      && fs.existsSync(path.join(root, 'wechat-mp-tools', 'app.py')),
  };
}

export async function runtimeSetupStatus(): Promise<RuntimeSetupStatus> {
  const packaged = isPackaged();
  if (!packaged) {
    return {
      packaged: false, ready: true, installing: false, phase: '开发环境', message: '开发环境使用本机依赖。',
      components: [
        { id: 'media', label: '内容抓取', ready: true, detail: '开发环境' },
        { id: 'wechat', label: '本地下载工具', ready: true, detail: '开发环境' },
        { id: 'browser', label: 'Chromium', ready: hasChromium(), detail: hasChromium() ? '已安装' : '未检测到' },
      ],
    };
  }
  const root = await bundledRuntimeRoot();
  const files = runtimeFiles(root);
  const browser = hasChromium();
  const ready = files.media && files.wechat && browser;
  return {
    packaged, ready, installing: !!installProcess, phase,
    message: installProcess ? message : ready ? '抓取与下载环境已就绪。' : '首次使用需要下载本机运行环境（约 0.8–1.5 GB，取决于系统与网络）。',
    components: [
      { id: 'media', label: '内容抓取环境', ready: files.media, detail: files.media ? '已安装' : '待安装' },
      { id: 'wechat', label: '本地下载工具', ready: files.wechat, detail: files.wechat ? '已安装' : '待安装' },
      { id: 'browser', label: 'Chromium 浏览器运行时', ready: browser, detail: browser ? '已安装' : '待下载' },
    ],
  };
}

function copyBootstrap(source: string, destination: string): void {
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
}

function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: 'pipe', windowsHide: true });
    let output = '';
    child.stdout?.on('data', (data) => { output += data.toString(); });
    child.stderr?.on('data', (data) => { output += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(output.slice(-1600) || `${command} 执行失败`)));
  });
}

async function installUv(target: string): Promise<string> {
  const bin = process.platform === 'win32' ? path.join(target, 'uv.exe') : path.join(target, 'uv');
  if (fs.existsSync(bin)) return bin;
  fs.mkdirSync(target, { recursive: true });
  if (process.platform === 'win32') {
    await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$env:UV_UNMANAGED_INSTALL='${target.replace(/'/g, "''")}'; irm https://astral.sh/uv/install.ps1 | iex`]);
  } else {
    await run('sh', ['-c', `curl -LsSf https://astral.sh/uv/install.sh | env UV_UNMANAGED_INSTALL='${target.replace(/'/g, "'\\''")}' sh`]);
  }
  if (!fs.existsSync(bin)) throw new Error('uv 安装未完成，请检查网络或安全软件后重试');
  return bin;
}

async function installRuntime(): Promise<void> {
  const bootstrap = await bootstrapRoot();
  if (!bootstrap || !fs.existsSync(bootstrap)) throw new Error('安装资源缺失，请重新下载安装包');
  const installRoot = await runtimeInstallRoot();
  const dataRoot = await userRuntimeDataDir();
  phase = '准备安装资源'; message = '正在准备本机运行环境…';
  copyBootstrap(path.join(bootstrap, 'media-crawler'), path.join(installRoot, 'media-crawler', 'proxy'));
  copyBootstrap(path.join(bootstrap, 'media-crawler', 'upstream'), path.join(installRoot, 'media-crawler', 'upstream'));
  copyBootstrap(path.join(bootstrap, 'wechat-mp-tools'), path.join(installRoot, 'wechat-mp-tools'));
  const uv = await installUv(path.join(dataRoot, 'bin'));
  const browserEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath() };

  phase = '安装内容抓取环境'; message = '正在安装内容抓取所需的 Python 依赖…';
  const mediaVenv = path.join(installRoot, 'media-crawler', 'venv');
  await run(uv, ['venv', '--python', '3.13', mediaVenv]);
  await run(uv, ['pip', 'install', '--python', pythonExecutable(mediaVenv), '-r', path.join(installRoot, 'media-crawler', 'proxy', 'requirements.txt'), '-r', path.join(installRoot, 'media-crawler', 'upstream', 'requirements.txt')], { env: browserEnv });

  phase = '安装下载工具'; message = '正在安装本地下载工具依赖…';
  const wechatVenv = path.join(installRoot, 'wechat-mp-tools', 'venv');
  await run(uv, ['venv', '--python', '3.12', wechatVenv]);
  await run(uv, ['pip', 'install', '--python', pythonExecutable(wechatVenv), '-r', path.join(installRoot, 'wechat-mp-tools', 'requirements.txt')], { env: browserEnv });

  phase = '下载 Chromium'; message = '正在下载 Chromium 浏览器运行时，请保持网络连接…';
  await run(pythonExecutable(mediaVenv), ['-m', 'playwright', 'install', 'chromium'], { env: browserEnv });
  phase = '已完成'; message = '环境安装完成，可以继续登录抖音和小红书。';
}

export async function startRuntimeInstall(): Promise<RuntimeSetupStatus> {
  if (!isPackaged()) return runtimeSetupStatus();
  if (!installProcess) {
    installProcess = installRuntime().catch((error: any) => {
      phase = '安装失败';
      message = error?.message || '环境安装失败，请检查网络后重试';
      throw error;
    }).finally(() => { installProcess = null; });
  }
  void installProcess.catch(() => {});
  return runtimeSetupStatus();
}
