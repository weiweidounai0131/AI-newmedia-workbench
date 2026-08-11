#!/usr/bin/env node
/**
 * Prepare the native runtime that travels inside the desktop app.
 *
 * This intentionally copies only executables and source code. User cookies,
 * download history and browser profiles are created on the destination machine
 * under Electron userData, never copied from the build machine.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const platform = process.argv.find((value) => value.startsWith('--platform='))?.slice(11)
  || (process.platform === 'darwin' ? `mac-${process.arch}` : process.platform === 'win32' ? `win-${process.arch}` : `${process.platform}-${process.arch}`);
const runtimeRoot = path.join(root, 'resources', 'runtime', platform);
const home = os.homedir();
const isWindows = platform.startsWith('win-');

function exists(file) { return fs.existsSync(file); }
function remove(target) { fs.rmSync(target, { recursive: true, force: true }); }
function copy(source, destination, filter) {
  if (!exists(source)) throw new Error(`缺少运行时来源：${source}`);
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter });
}
function withoutExcluded(source) {
  const relative = path.relative(root, source).split(path.sep);
  return !relative.some((part) => ['.git', '.github', '__pycache__', 'browser_data', 'docs', 'tests', 'test', 'webui', 'cache'].includes(part));
}

const mediaVenv = process.env.NEWMEDIA_MEDIA_CRAWLER_VENV
  || (isWindows ? '' : path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'media-crawler'));
const wechatVenv = process.env.NEWMEDIA_WECHAT_TOOLS_VENV
  || path.join(root, 'tools', 'wechat-mp-tools', 'venv312');
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH
  || (isWindows ? '' : path.join(home, 'Library', 'Caches', 'ms-playwright'));

if (!mediaVenv || !exists(mediaVenv)) {
  throw new Error('缺少 MediaCrawler Python 运行环境。Windows 构建请设置 NEWMEDIA_MEDIA_CRAWLER_VENV 指向 Windows venv。');
}
if (!wechatVenv || !exists(wechatVenv)) {
  throw new Error('缺少 wechat-mp-tools Python 运行环境。Windows 构建请设置 NEWMEDIA_WECHAT_TOOLS_VENV 指向 Windows venv。');
}
if (!browsers || !exists(browsers)) {
  throw new Error('缺少 Playwright Chromium。Windows 构建请设置 PLAYWRIGHT_BROWSERS_PATH。');
}

remove(runtimeRoot);
fs.mkdirSync(runtimeRoot, { recursive: true });

copy(path.join(root, 'tools', 'media-crawler'), path.join(runtimeRoot, 'media-crawler', 'proxy'), withoutExcluded);
copy(path.join(root, 'tools', 'MediaCrawler'), path.join(runtimeRoot, 'media-crawler', 'upstream'), withoutExcluded);
copy(mediaVenv, path.join(runtimeRoot, 'media-crawler', 'venv'));
copy(path.join(root, 'tools', 'wechat-mp-tools'), path.join(runtimeRoot, 'wechat-mp-tools'), (source) => {
  const name = path.basename(source);
  return !['.git', '.github', '__pycache__', 'venv312', 'venv', 'data', 'docs'].includes(name);
});
copy(wechatVenv, path.join(runtimeRoot, 'wechat-mp-tools', 'venv'));

for (const folder of ['chromium-1234', 'chromium_headless_shell-1234', 'ffmpeg-1011']) {
  const source = path.join(browsers, folder);
  if (!exists(source)) throw new Error(`Playwright 缺少 ${folder}，请先在构建机器安装 Chromium 1234。`);
  copy(source, path.join(runtimeRoot, 'ms-playwright', folder));
}

fs.writeFileSync(path.join(runtimeRoot, 'runtime-manifest.json'), JSON.stringify({
  platform,
  generatedAt: new Date().toISOString(),
  browserRevision: '1234',
  contains: ['MediaCrawler proxy', 'MediaCrawler upstream', 'wechat-mp-tools', 'Playwright Chromium'],
}, null, 2));

console.log(`已准备便携运行时：${runtimeRoot}`);
