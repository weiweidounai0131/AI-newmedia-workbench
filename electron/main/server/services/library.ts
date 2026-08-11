// 素材库是用户本地目录的只读镜像：磁盘文件才是唯一事实源。
// 不维护独立索引，因此用户在 Finder / 资源管理器中删除或移动文件后，刷新即可同步。
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { Document, Packer, Paragraph, TextRun } from 'docx';
import { settings } from './settings.js';

export type LibKind = 'x' | 'w' | 'i';
export type LibFolder = '选题' | '创意' | '洗稿' | '图片';
export const FOLDERS: LibFolder[] = ['选题', '创意', '洗稿', '图片'];

export interface LibTopic {
  title: string;
  source: '热榜' | '搜索';
  platform: string;
  heat?: string;
  likes?: string;
  comments?: string;
  link?: string;
}

export interface LibFile {
  folder: LibFolder;
  name: string;
  date: string;
  kind: LibKind;
  localPath: string;
  size: number;
  modifiedAt: number;
}

export interface LibraryStatus {
  rootDir: string | null;
  missingFolders: LibFolder[];
  ready: boolean;
  files: LibFile[];
}

export interface ExportPayload {
  folder: LibFolder;
  name: string;
  kind: LibKind;
  content?: string;
  data?: string;
  topics?: LibTopic[];
}

export class LibraryError extends Error {
  constructor(public code: 'root_not_configured' | 'folders_missing' | 'invalid_file', message: string) {
    super(message);
  }
}

function fmtYMD(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`;
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

function root(): string | null {
  return settings.rootDir || null;
}

function folderPath(folder: LibFolder): string | null {
  const dir = root();
  return dir ? path.join(dir, folder) : null;
}

function missingFolders(): LibFolder[] {
  if (!root()) return FOLDERS.slice();
  return FOLDERS.filter((folder) => {
    const dir = folderPath(folder)!;
    try { return !fs.statSync(dir).isDirectory(); } catch { return true; }
  });
}

function kindFor(folder: LibFolder, name: string): LibKind | null {
  if (folder === '选题') return /\.xlsx$/i.test(name) ? 'x' : null;
  if (folder === '洗稿' || folder === '创意') return /\.docx$/i.test(name) ? 'w' : null;
  return /\.(png|jpe?g|webp)$/i.test(name) ? 'i' : null;
}

function list(): LibFile[] {
  if (!root()) return [];
  const files: LibFile[] = [];
  for (const folder of FOLDERS) {
    const dir = folderPath(folder)!;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const kind = kindFor(folder, entry.name);
      if (!kind) continue;
      const full = path.join(dir, entry.name);
      try {
        const stat = fs.statSync(full);
        files.push({ folder, name: entry.name, kind, size: stat.size, modifiedAt: stat.mtimeMs, date: fmtYMD(stat.mtime), localPath: `${folder}/${entry.name}` });
      } catch { /* 外部删除竞态，下一次扫描会自然消失 */ }
    }
  }
  return files.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

function status(): LibraryStatus {
  const rootDir = root();
  const missing = missingFolders();
  return { rootDir, missingFolders: missing, ready: !!rootDir && missing.length === 0, files: list() };
}

function initialize(): LibraryStatus {
  const rootDir = root();
  if (!rootDir) throw new LibraryError('root_not_configured', '请先选择本地素材库目录');
  fs.mkdirSync(rootDir, { recursive: true });
  for (const folder of FOLDERS) fs.mkdirSync(path.join(rootDir, folder), { recursive: true });
  return status();
}

function assertReady(): void {
  const state = status();
  if (!state.rootDir) throw new LibraryError('root_not_configured', '请先选择本地素材库目录');
  if (!state.ready) throw new LibraryError('folders_missing', `素材库缺少文件夹：${state.missingFolders.join('、')}，请先在素材库中确认创建`);
}

async function wordBuffer(content: string): Promise<Buffer> {
  const doc = new Document({ sections: [{ children: (content || '').split('\n').map((line) => new Paragraph({ children: [new TextRun(line || ' ')] })) }] });
  return Buffer.from(await Packer.toBuffer(doc));
}

async function writeFile(payload: ExportPayload): Promise<void> {
  assertReady();
  const dir = folderPath(payload.folder)!;
  const name = safeName(payload.name);
  const full = path.join(dir, name);
  if (payload.kind === 'i') {
    const b64 = (payload.data || '').split(',')[1] || '';
    if (!b64) throw new LibraryError('invalid_file', '图片内容为空，无法导出');
    fs.writeFileSync(full, Buffer.from(b64, 'base64'));
    return;
  }
  if (payload.kind === 'x') {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('选题');
    ws.columns = [{ header: '序列', width: 6 }, { header: '标题', width: 52 }, { header: '来源', width: 10 }, { header: '平台', width: 12 }, { header: '热度', width: 14 }, { header: '点赞', width: 14 }, { header: '评论', width: 14 }, { header: '链接', width: 44 }];
    (payload.topics || []).forEach((topic, index) => {
      const source = topic.source || '热榜';
      ws.addRow([index + 1, topic.title, source, topic.platform, source === '热榜' ? topic.heat || '—' : '—', source === '搜索' ? topic.likes || '—' : '—', source === '搜索' ? topic.comments || '—' : '—', topic.link || '']);
    });
    await wb.xlsx.writeFile(full);
    return;
  }
  if (payload.kind === 'w') {
    fs.writeFileSync(full, await wordBuffer(payload.content || ''));
    return;
  }
  throw new LibraryError('invalid_file', '未知文件类型');
}

function filePath(folder: LibFolder, name: string): string | null {
  const dir = folderPath(folder);
  if (!dir || !name || safeName(name) !== name) return null;
  const full = path.join(dir, name);
  try { return fs.statSync(full).isFile() ? full : null; } catch { return null; }
}

export const library = { root, folders: FOLDERS, status, initialize, export: writeFile, wordBuffer, safeName, filePath };
