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

/**
 * 优先复用用户电脑已安装的 Chrome / Edge，避免首次运行强制下载数百 MB 的
 * Playwright Chromium。两个浏览器都基于 Chromium，Playwright 可以直接驱动。
 */
function systemBrowserPath(): string | null {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = process.platform === 'darwin'
    ? [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
    : process.platform === 'win32'
      ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
      : [];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function runtimeFiles(root: string | null) {
  if (!root) return { media: false, wechat: false };
  const sharedPython = pythonExecutable(path.join(root, 'python'));
  return {
    media: fs.existsSync(sharedPython)
      && fs.existsSync(path.join(root, 'media-crawler', 'proxy', 'server.py'))
      && fs.existsSync(path.join(root, 'media-crawler', 'upstream', 'workbench_main.py')),
    wechat: fs.existsSync(sharedPython)
      && fs.existsSync(path.join(root, 'wechat-mp-tools', 'workbench_app.py')),
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
  const systemBrowser = systemBrowserPath();
  const browserReady = browser || !!systemBrowser;
  const ready = files.media && files.wechat && browserReady;
  return {
    packaged, ready, installing: !!installProcess, phase,
    message: installProcess ? message : ready ? '抓取与下载环境已就绪。' : '首次使用需要安装精简版本机运行环境；检测到 Chrome / Edge 时不会额外下载 Chromium。',
    components: [
      { id: 'media', label: '内容抓取环境', ready: files.media, detail: files.media ? '已安装' : '待安装' },
      { id: 'wechat', label: '本地下载工具', ready: files.wechat, detail: files.wechat ? '已安装' : '待安装' },
      { id: 'browser', label: '浏览器运行时', ready: browserReady, detail: browser ? 'Playwright Chromium 已安装' : systemBrowser ? '复用本机 Chrome / Edge' : '待下载' },
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
  // bootstrap/media-crawler 内含 upstream；代理目录只需要 server/browser/search 等轻量文件，
  // 先移除嵌套副本，再把 upstream 放到唯一的正式位置，避免运行环境重复一份源码。
  fs.rmSync(path.join(installRoot, 'media-crawler', 'proxy', 'upstream'), { recursive: true, force: true });
  copyBootstrap(path.join(bootstrap, 'media-crawler', 'upstream'), path.join(installRoot, 'media-crawler', 'upstream'));
  copyBootstrap(path.join(bootstrap, 'wechat-mp-tools'), path.join(installRoot, 'wechat-mp-tools'));
  const uv = await installUv(path.join(dataRoot, 'bin'));
  const browserEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath() };

  phase = '安装共享运行环境'; message = '正在安装抓取与下载共用的精简 Python 环境…';
  const sharedVenv = path.join(installRoot, 'python');
  fs.rmSync(sharedVenv, { recursive: true, force: true });
  await run(uv, ['venv', '--python', '3.12', sharedVenv]);
  const sharedPython = pythonExecutable(sharedVenv);
  await run(uv, [
    'pip', 'install', '--python', sharedPython,
    '-r', path.join(installRoot, 'media-crawler', 'proxy', 'requirements.txt'),
    '-r', path.join(installRoot, 'media-crawler', 'upstream', 'requirements.workbench.txt'),
    '-r', path.join(installRoot, 'wechat-mp-tools', 'requirements.workbench.txt'),
  ], { env: browserEnv });

  // 新共享环境验证成功后再清理旧版双 venv，升级用户不会长期保留重复依赖。
  fs.rmSync(path.join(installRoot, 'media-crawler', 'venv'), { recursive: true, force: true });
  fs.rmSync(path.join(installRoot, 'wechat-mp-tools', 'venv'), { recursive: true, force: true });

  const existingBrowser = systemBrowserPath();
  if (existingBrowser) {
    phase = '复用本机浏览器'; message = '已检测到本机 Chrome / Edge，无需下载 Chromium。';
  } else {
    phase = '下载 Chromium'; message = '未检测到 Chrome / Edge，正在从国内镜像下载 Chromium 浏览器运行时…';
    try {
      await run(sharedPython, ['-m', 'playwright', 'install', 'chromium'], {
        env: { ...browserEnv, PLAYWRIGHT_DOWNLOAD_HOST: 'https://registry.npmmirror.com/-/binary/playwright' },
      });
    } catch (mirrorError) {
      phase = '重试下载 Chromium'; message = '国内镜像下载未完成，正在尝试备用下载源…';
      try {
        await run(sharedPython, ['-m', 'playwright', 'install', 'chromium'], { env: browserEnv });
      } catch (fallbackError: any) {
        const detail = fallbackError?.message || (mirrorError as Error)?.message || '网络连接异常';
        throw new Error(`浏览器运行时下载失败。建议先安装 Google Chrome 或 Microsoft Edge 后重新打开工作台；如需继续下载，请检查网络或代理后重试。${detail ? `\n${detail}` : ''}`);
      }
    }
  }
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
