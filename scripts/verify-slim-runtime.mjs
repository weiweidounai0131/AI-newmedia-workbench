#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));
const fail = (message) => {
  console.error(`[verify:slim] FAIL: ${message}`);
  process.exitCode = 1;
};
const ok = (message) => console.log(`[verify:slim] OK: ${message}`);

const required = [
  'resources/bootstrap/media-crawler/upstream/workbench_main.py',
  'resources/bootstrap/media-crawler/upstream/requirements.workbench.txt',
  'resources/bootstrap/wechat-mp-tools/workbench_app.py',
  'resources/bootstrap/wechat-mp-tools/requirements.workbench.txt',
];
for (const file of required) {
  if (exists(file)) ok(`存在 ${file}`);
  else fail(`缺少 ${file}`);
}

const runtime = read('electron/main/server/services/runtimeSetup.ts');
if (runtime.includes("path.join(installRoot, 'python')")) ok('首次安装使用共享 Python venv');
else fail('未检测到共享 Python venv');

if (runtime.includes("upstream', 'requirements.workbench.txt") &&
    runtime.includes("wechat-mp-tools', 'requirements.workbench.txt")) {
  ok('首次安装使用精简 requirements');
} else {
  fail('runtimeSetup 未引用精简 requirements');
}

if (runtime.includes("upstream', 'requirements.txt') ||
    runtime.includes("wechat-mp-tools', 'requirements.txt')") {
  fail('runtimeSetup 仍直接安装完整上游 requirements');
} else {
  ok('未直接安装完整上游 requirements');
}

const mediaReq = read('resources/bootstrap/media-crawler/upstream/requirements.workbench.txt').toLowerCase();
const wechatReq = read('resources/bootstrap/wechat-mp-tools/requirements.workbench.txt').toLowerCase();
const forbidden = [
  'pandas', 'matplotlib', 'wordcloud', 'jieba', 'sqlalchemy', 'alembic',
  'aiomysql', 'asyncmy', 'redis', 'motor', 'openpyxl', 'pytest',
  'mitmproxy', 'pywebview', 'pythonnet', 'pyobjc', 'scrapling',
];
const found = forbidden.filter((name) => mediaReq.includes(name) || wechatReq.includes(name));
if (found.length) fail(`精简 requirements 仍含重量级非必要依赖: ${found.join(', ')}`);
else ok('重量级非必要依赖已从工作台 requirements 移除');

const builder = read('electron-builder.yml');
for (const marker of [
  '!bootstrap/media-crawler/upstream/docs/**',
  '!bootstrap/wechat-mp-tools/frontend/**',
  '!bootstrap/wechat-mp-tools/backend/subtitle_remover/**',
]) {
  if (builder.includes(marker)) ok(`打包排除规则存在: ${marker}`);
  else fail(`缺少打包排除规则: ${marker}`);
}

if (!process.exitCode) {
  console.log('[verify:slim] PASS: 静态瘦身检查通过。下一步运行 npm run typecheck && npm run build。');
}
