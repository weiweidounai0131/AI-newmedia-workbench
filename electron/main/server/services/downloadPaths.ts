import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 下载服务可能由工作台自动拉起，也可能复用用户已经运行的 wechat-mp-tools。
// 记录本次任务由本机服务返回的目录，允许导入阶段安全地接住两种运行模式的真实路径。
const knownXhsDownloadDirs = new Set<string>();

function normalize(value: string): string {
  let raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('file://')) raw = raw.slice('file://'.length);
  if (raw.startsWith('~/') || raw === '~') raw = path.join(os.homedir(), raw.slice(2));
  // 历史记录可能由 Windows 版本生成；在 macOS 上接收时把分隔符转成当前平台格式。
  if (path.sep === '/') raw = raw.replaceAll('\\', '/');
  return path.resolve(raw);
}

function isWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isDirectory(value: string): boolean {
  try { return fs.statSync(value).isDirectory(); } catch { return false; }
}

function pathSuffixAfterXhsRoot(value: string): string | null {
  const normalized = value.replaceAll('\\', '/');
  const marker = '/xhs_downloads/';
  const index = normalized.toLowerCase().lastIndexOf(marker);
  if (index < 0) return null;
  const suffix = normalized.slice(index + marker.length).replace(/^\/+|\/+$/g, '');
  return suffix || null;
}

export interface XhsDownloadPathHints {
  title?: string;
  noteId?: string;
}

/**
 * 将 wechat-mp-tools 返回的目录映射为当前工作台实际可访问的目录。
 *
 * 兼容：旧版服务的绝对路径、打包服务的运行时目录、相对路径、file:// 路径，
 * 以及历史记录中目录被移动后仍保留的旧路径。只会在给定的下载根目录内查找。
 */
export function resolveXhsDownloadDir(rawValue: string | undefined, roots: string[], hints: XhsDownloadPathHints = {}): string | null {
  const normalizedRoots = roots
    .map((root) => normalize(root))
    .filter((root, index, all) => root && all.indexOf(root) === index);
  const raw = normalize(rawValue || '');
  const candidates: string[] = [];
  const addCandidate = (value: string) => {
    const candidate = normalize(value);
    if (!candidate || candidates.includes(candidate)) return;
    if (normalizedRoots.some((root) => isWithin(candidate, root))) candidates.push(candidate);
  };

  if (raw) {
    addCandidate(raw);
    if (!path.isAbsolute(String(rawValue || '').trim())) addCandidate(path.resolve(process.cwd(), String(rawValue || '').trim()));
    const suffix = pathSuffixAfterXhsRoot(String(rawValue || ''));
    if (suffix) for (const root of normalizedRoots) addCandidate(path.join(root, suffix));
  }

  for (const candidate of candidates) if (isDirectory(candidate)) return candidate;

  const tokens = [hints.noteId, hints.title, raw ? path.basename(raw) : undefined]
    .map((value) => String(value || '').trim().toLocaleLowerCase())
    .filter(Boolean);
  if (!tokens.length) return null;

  // 目录结构固定为 xhs_downloads/<作者>/<日期_标题>，最多检查两层，避免扫描用户其他文件。
  const matches: Array<{ dir: string; mtime: number }> = [];
  for (const root of normalizedRoots) {
    if (!isDirectory(root)) continue;
    let authors: fs.Dirent[] = [];
    try { authors = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const author of authors) {
      if (!author.isDirectory()) continue;
      const authorDir = path.join(root, author.name);
      let notes: fs.Dirent[] = [];
      try { notes = fs.readdirSync(authorDir, { withFileTypes: true }); } catch { continue; }
      for (const note of notes) {
        if (!note.isDirectory()) continue;
        const noteDir = path.join(authorDir, note.name);
        const haystack = `${note.name} ${author.name}`.toLocaleLowerCase();
        if (!tokens.some((token) => haystack.includes(token))) continue;
        try {
          matches.push({ dir: noteDir, mtime: fs.statSync(noteDir).mtimeMs });
        } catch { /* 目录在扫描期间被清理，忽略即可 */ }
      }
    }
  }
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0]?.dir || null;
}

export function rememberXhsDownloadDir(value: string): void {
  const normalized = normalize(value);
  if (!normalized || normalized === path.parse(normalized).root) return;
  knownXhsDownloadDirs.add(normalized);
  // 只保留最近的少量任务路径，避免长期运行时集合增长。
  while (knownXhsDownloadDirs.size > 32) {
    const oldest = knownXhsDownloadDirs.values().next().value;
    if (typeof oldest !== 'string') break;
    knownXhsDownloadDirs.delete(oldest);
  }
}

export function isKnownXhsDownloadDir(value: string): boolean {
  const normalized = normalize(value);
  return [...knownXhsDownloadDirs].some((root) => normalized === root || normalized.startsWith(`${root}${path.sep}`));
}
