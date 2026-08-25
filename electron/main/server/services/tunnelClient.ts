import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { settings } from './settings.js';

/**
 * Secure MCP Tunnel 的本机运行时管理。
 *
 * 设计边界：
 * - tunnel-client 是可选备用通道，不影响原有 API/MCP 本机服务；
 * - 二进制按用户操作下载到 userData，不打进每一次工作台安装包；
 * - 运行密钥只通过环境变量传给 tunnel-client，永不出现在 argv、GET 响应或日志中；
 * - ChatGPT 仍需在网页端完成 Tunnel 连接，工作台只负责本机 MCP 服务和客户端生命周期。
 */

const require = createRequire(import.meta.url);
const FALLBACK_VERSION = '0.0.12';
const RELEASE_API = 'https://api.github.com/repos/openai/tunnel-client/releases/latest';
const RELEASE_PAGE = 'https://github.com/openai/tunnel-client/releases/latest';

export type TunnelPhase = 'unconfigured' | 'missing' | 'stopped' | 'downloading' | 'starting' | 'ready' | 'error';

export interface TunnelClientStatus {
  phase: TunnelPhase;
  configured: boolean;
  keyConfigured: boolean;
  tunnelId: string | null;
  installed: boolean;
  running: boolean;
  healthy: boolean;
  version?: string;
  percent?: number;
  message: string;
}

let mcpServerUrl = '';
let child: ChildProcess | null = null;
let startPromise: Promise<TunnelClientStatus> | null = null;
let installPromise: Promise<TunnelClientStatus> | null = null;
let lastError = '';
let downloadPercent = 0;
let installedVersion: string | undefined;
let tunnelHealthy = false;

function electronApp(): any | null {
  try {
    return require('electron').app || null;
  } catch {
    return null;
  }
}

function dataDir(): string {
  const app = electronApp();
  return app?.getPath?.('userData') || path.join(process.cwd(), '.data');
}

function tunnelRoot(): string {
  return path.join(dataDir(), 'tunnel-client');
}

function targetPlatform(): { id: string; asset: string; executable: string } {
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    return { id: `darwin-${arch}`, asset: `darwin-${arch}`, executable: 'tunnel-client' };
  }
  if (process.platform === 'win32') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    return { id: `windows-${arch}`, asset: `windows-${arch}`, executable: 'tunnel-client.exe' };
  }
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  return { id: `linux-${arch}`, asset: `linux-${arch}`, executable: 'tunnel-client' };
}

function isAlive(processRef: ChildProcess | null): boolean {
  return !!processRef && processRef.exitCode === null && !processRef.killed;
}

function localBinaryPath(): string {
  const target = targetPlatform();
  return path.join(tunnelRoot(), target.id, target.executable);
}

function findOnPath(): string | null {
  const target = targetPlatform();
  const names = process.platform === 'win32' ? ['tunnel-client.exe', 'tunnel-client'] : ['tunnel-client'];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // 允许开发者把官方运行时放在 resources/tunnel-client 中做内部测试。
  const appResources = (process as any).resourcesPath;
  if (appResources) {
    const bundled = path.join(appResources, 'resources', 'tunnel-client', target.id, target.executable);
    if (fs.existsSync(bundled)) return bundled;
  }
  return null;
}

function resolveBinary(): string | null {
  const installed = localBinaryPath();
  if (fs.existsSync(installed)) return installed;
  return findOnPath();
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const processRef = spawn(command, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    processRef.stdout?.on('data', (chunk) => { output += chunk.toString(); });
    processRef.stderr?.on('data', (chunk) => { output += chunk.toString(); });
    processRef.once('error', reject);
    processRef.once('close', (code) => code === 0 ? resolve() : reject(new Error(output.slice(-1600) || `${command} 执行失败`)));
  });
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function quotePowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function extractZip(zipPath: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath ${quotePowerShell(zipPath)} -DestinationPath ${quotePowerShell(destination)} -Force`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
    return;
  }
  await run('/usr/bin/ditto', ['-x', '-k', zipPath, destination]);
}

async function downloadFile(url: string, destination: string): Promise<void> {
  // GitHub Release 的大文件在部分 macOS Node/代理组合下会卡在重定向阶段；
  // 复用系统 curl（Windows 使用 PowerShell）可继承用户现有代理和证书设置。
  if (process.platform === 'win32') {
    const command = `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri ${quotePowerShell(url)} -OutFile ${quotePowerShell(destination)}`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command]);
    return;
  }
  await run('curl', ['-fL', '--retry', '2', '--connect-timeout', '15', '--max-time', '1200', '-o', destination, url]);
}

function findFile(root: string, fileName: string): string | null {
  const queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(candidate);
      else if (entry.name === fileName) return candidate;
    }
  }
  return null;
}

async function releaseAsset(): Promise<{ version: string; url: string; name: string; checksumUrl?: string }> {
  const target = targetPlatform();
  try {
    const response = await fetchWithTimeout(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } }, 15_000);
    if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
    const release = await response.json() as { tag_name?: string; assets?: Array<{ name?: string; browser_download_url?: string }> };
    const tag = String(release.tag_name || '').replace(/^v/, '');
    const name = `tunnel-client-v${tag}-${target.asset}.zip`;
    const asset = release.assets?.find((item) => item.name === name && item.browser_download_url);
    if (!tag || !asset?.browser_download_url) throw new Error('官方发布包未包含当前系统架构');
    const checksum = release.assets?.find((item) => item.name === 'SHA256SUMS.txt')?.browser_download_url;
    return { version: tag, name, url: asset.browser_download_url, checksumUrl: checksum };
  } catch (error) {
    // GitHub API 在部分网络环境不可达时，仍保留一个已验证的官方版本兜底。
    const name = `tunnel-client-v${FALLBACK_VERSION}-${target.asset}.zip`;
    return {
      version: FALLBACK_VERSION,
      name,
      url: `https://github.com/openai/tunnel-client/releases/download/v${FALLBACK_VERSION}/${name}`,
      checksumUrl: `https://github.com/openai/tunnel-client/releases/download/v${FALLBACK_VERSION}/SHA256SUMS.txt`,
    };
  }
}

async function verifyChecksum(filePath: string, assetName: string, checksumUrl?: string): Promise<void> {
  if (!checksumUrl) return;
  try {
    const response = await fetchWithTimeout(checksumUrl, {}, 15_000);
    if (!response.ok) return;
    const text = await response.text();
    const line = text.split(/\r?\n/).find((item) => item.includes(assetName));
    const expected = line?.match(/\b([a-fA-F0-9]{64})\b/)?.[1]?.toLowerCase();
    if (!expected) return;
    const actual = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toLowerCase();
    if (actual !== expected) throw new Error('下载包校验失败，文件可能已损坏或被篡改');
  } catch (error) {
    if ((error as Error)?.message?.includes('校验失败')) throw error;
    // 校验清单临时不可达时不阻断安装；下载仍来自官方 HTTPS 地址。
  }
}

async function installTunnelClientInternal(): Promise<TunnelClientStatus> {
  const existing = resolveBinary();
  if (existing) {
    installedVersion = installedVersion || '已检测到本机安装';
    lastError = '';
    return getTunnelClientStatus();
  }
  if (isAlive(child)) return getTunnelClientStatus();

  const target = targetPlatform();
  const asset = await releaseAsset();
  downloadPercent = 10;
  lastError = '';
  const root = path.join(tunnelRoot(), target.id);
  const tempRoot = path.join(tunnelRoot(), `.download-${Date.now()}`);
  const zipPath = path.join(tempRoot, asset.name);
  try {
    await mkdir(tempRoot, { recursive: true });
    downloadPercent = 20;
    await downloadFile(asset.url, zipPath);
    downloadPercent = 70;
    await verifyChecksum(zipPath, asset.name, asset.checksumUrl);
    const extracted = path.join(tempRoot, 'extracted');
    await extractZip(zipPath, extracted);
    const binary = findFile(extracted, target.executable);
    if (!binary) throw new Error('官方下载包中未找到 tunnel-client 可执行文件');
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    fs.cpSync(extracted, root, { recursive: true });
    const installedBinary = path.join(root, target.executable);
    if (!fs.existsSync(installedBinary)) fs.copyFileSync(binary, installedBinary);
    if (process.platform !== 'win32') fs.chmodSync(installedBinary, 0o755);
    installedVersion = asset.version;
    downloadPercent = 0;
    return getTunnelClientStatus();
  } catch (error: any) {
    lastError = error?.message || 'tunnel-client 下载或安装失败';
    throw new Error(`${lastError}。如当前网络无法访问 GitHub，请先打开官方下载页 ${RELEASE_PAGE} 手动下载。`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    downloadPercent = 0;
  }
}

export async function installTunnelClient(): Promise<TunnelClientStatus> {
  if (installPromise) return installPromise;
  installPromise = installTunnelClientInternal().finally(() => { installPromise = null; });
  return installPromise;
}

async function waitForReady(processRef: ChildProcess, healthFile: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processRef.exitCode !== null) throw new Error(`tunnel-client 已退出（${processRef.exitCode}）`);
    try {
      const base = (await readFile(healthFile, 'utf8')).trim().replace(/\/$/, '');
      if (base) {
        const response = await fetchWithTimeout(`${base}/readyz`, {}, 1_500);
        if (response.ok) return;
      }
    } catch {
      // 客户端启动时 health 文件和 readyz 可能晚于进程出现，继续轮询。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('tunnel-client 启动超时，请检查运行 API Key、Tunnel 权限和网络连接');
}

export function configureTunnelMcpServerUrl(url: string): void {
  mcpServerUrl = url.replace(/\/$/, '');
}

export function getTunnelClientStatus(): TunnelClientStatus {
  const tunnelId = settings.tunnelId;
  const keyConfigured = !!settings.tunnelApiKey;
  const configured = !!tunnelId && keyConfigured;
  const binary = resolveBinary();
  const running = isAlive(child);
  if (downloadPercent > 0) {
    return { phase: 'downloading', configured, keyConfigured, tunnelId, installed: !!binary, running, healthy: false, version: installedVersion, percent: downloadPercent, message: '正在下载并安装 tunnel-client 官方运行环境…' };
  }
  if (!configured) {
    return { phase: 'unconfigured', configured: false, keyConfigured, tunnelId, installed: !!binary, running, healthy: false, message: '可选备用通道，填写 Tunnel ID 和运行 API Key 后启用。' };
  }
  if (!binary) {
    return { phase: 'missing', configured: true, keyConfigured, tunnelId, installed: false, running: false, healthy: false, message: '尚未安装 tunnel-client，点击“安装并连接”按需下载官方运行环境。' };
  }
  if (running && lastError === '') {
    return { phase: tunnelHealthy ? 'ready' : mcpServerUrl ? 'starting' : 'error', configured: true, keyConfigured, tunnelId, installed: true, running: true, healthy: tunnelHealthy, version: installedVersion, message: tunnelHealthy ? 'Secure MCP Tunnel 已连接，网页 ChatGPT 可以使用工作台 MCP。' : mcpServerUrl ? '正在连接 Secure MCP Tunnel…' : '本机 MCP 地址尚未准备好。' };
  }
  if (lastError) {
    return { phase: 'error', configured: true, keyConfigured, tunnelId, installed: true, running, healthy: false, version: installedVersion, message: lastError };
  }
  return { phase: 'stopped', configured: true, keyConfigured, tunnelId, installed: true, running: false, healthy: false, version: installedVersion, message: 'tunnel-client 已安装，尚未连接。' };
}

export async function startTunnelClient(): Promise<TunnelClientStatus> {
  if (startPromise) return startPromise;
  const config = { tunnelId: settings.tunnelId, apiKey: settings.tunnelApiKey };
  if (!config.tunnelId || !config.apiKey) return getTunnelClientStatus();
  const binary = resolveBinary();
  if (!binary) return getTunnelClientStatus();
  if (!mcpServerUrl) {
    lastError = '本机 MCP 服务尚未启动，请稍后重试';
    return getTunnelClientStatus();
  }
  if (isAlive(child)) return getTunnelClientStatus();

  lastError = '';
  const target = targetPlatform();
  const runRoot = path.join(tunnelRoot(), target.id);
  const healthFile = path.join(runRoot, 'health-url');
  const logFile = path.join(runRoot, 'tunnel-client.log');
  await mkdir(runRoot, { recursive: true });
  await rm(healthFile, { force: true });
  const args = [
    'run',
    '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
    '--control-plane.tunnel-id', config.tunnelId,
    '--mcp.server-url', `url=${mcpServerUrl},channel=main`,
    '--health.listen-addr', '127.0.0.1:0',
    '--health.url-file', healthFile,
    '--log.file', logFile,
  ];
  startPromise = new Promise<TunnelClientStatus>((resolve) => {
    const processRef = spawn(binary, args, {
      env: { ...process.env, CONTROL_PLANE_API_KEY: config.apiKey! },
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    child = processRef;
    tunnelHealthy = false;
    processRef.once('error', (error) => {
      lastError = error.message || 'tunnel-client 启动失败';
      child = null;
    });
    processRef.once('exit', (code) => {
      if (child === processRef) child = null;
      tunnelHealthy = false;
      if (code !== 0 && !lastError) lastError = `tunnel-client 已退出（${code ?? '未知'}），请查看设置页状态或本机日志`;
    });
    void waitForReady(processRef, healthFile)
      .then(() => {
        lastError = '';
        tunnelHealthy = true;
        resolve({ ...getTunnelClientStatus(), phase: 'ready', healthy: true, message: 'Secure MCP Tunnel 已连接，网页 ChatGPT 可以使用工作台 MCP。' });
      })
      .catch((error: any) => {
        lastError = error?.message || 'tunnel-client 连接失败';
        resolve(getTunnelClientStatus());
      });
  }).finally(() => { startPromise = null; });
  return startPromise;
}

export async function stopTunnelClient(): Promise<TunnelClientStatus> {
  const processRef = child;
  child = null;
  tunnelHealthy = false;
  if (!processRef || processRef.exitCode !== null) return getTunnelClientStatus();
  if (process.platform === 'win32' && processRef.pid) {
    await run('taskkill', ['/pid', String(processRef.pid), '/t', '/f']).catch(() => {});
  } else {
    processRef.kill('SIGTERM');
  }
  lastError = '';
  return getTunnelClientStatus();
}

export async function autoStartConfiguredTunnel(): Promise<void> {
  const status = getTunnelClientStatus();
  if (status.configured && status.installed && mcpServerUrl) await startTunnelClient();
}
