// 素材库路由（M3 本地直写）：BACKEND-PATH §5.1
import { Router, type Request, type Response } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { library, LibraryError, type LibFolder, type LibKind } from '../services/library.js';
import { settings } from '../services/settings.js';

export const libraryRouter = Router();
const execFileAsync = promisify(execFile);

function xmlToText(xml: string): string {
  return xml
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function libraryFailure(res: Response, error: unknown): void {
  if (error instanceof LibraryError) {
    res.status(error.code === 'root_not_configured' ? 428 : 409).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: String((error as any)?.message || error), code: 'write_failed' });
}

// GET /api/library → 每次扫描真实本地目录，不读取历史索引。
libraryRouter.get('/', (_req: Request, res: Response) => {
  res.json(library.status());
});

// POST /api/library/root { rootDir } → 仅保存选择；缺失的分类文件夹由前端另行确认创建。
libraryRouter.post('/root', (req: Request, res: Response) => {
  const { rootDir } = req.body ?? {};
  if (!rootDir || typeof rootDir !== 'string') return res.status(400).json({ error: '请选择有效的本地目录', code: 'bad_request' });
  const input = rootDir.trim();
  const expanded = input === '~' ? os.homedir() : input.startsWith(`~${path.sep}`) || input.startsWith('~/')
    ? path.join(os.homedir(), input.slice(2))
    : input;
  const normalized = path.resolve(expanded);
  try {
    if (fs.existsSync(normalized) && !fs.statSync(normalized).isDirectory()) {
      return res.status(400).json({ error: '此路径是文件，请选择或填写一个文件夹路径', code: 'bad_request' });
    }
  } catch {
    return res.status(400).json({ error: '无法读取该本地目录，请检查路径后重试', code: 'bad_request' });
  }
  settings.setRootDir(normalized);
  res.json(library.status());
});

// POST /api/library/initialize → 用户确认后创建 选题 / 创意 / 洗稿 / 图片 四个文件夹。
libraryRouter.post('/initialize', (_req: Request, res: Response) => {
  try { res.json(library.initialize()); } catch (error) { libraryFailure(res, error); }
});

// POST /api/library/export { folder, name, kind, content?, data?, topics? }
//  → 真实落盘到 rootDir/<folder>/<name>，并写入索引
libraryRouter.post('/export', async (req: Request, res: Response) => {
  const { folder, name, kind, content, data, topics } = req.body ?? {};
  if (!library.folders.includes(folder as LibFolder)) {
    return res.status(400).json({ error: 'folder 非法', code: 'bad_request' });
  }
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name 必填', code: 'bad_request' });
  }
  if (!['x', 'w', 'i'].includes(kind as LibKind)) {
    return res.status(400).json({ error: 'kind 非法', code: 'bad_request' });
  }
  try {
    await library.export({ folder, name, kind, content, data, topics });
    res.json({ ok: true, ...library.status() });
  } catch (error) {
    libraryFailure(res, error);
  }
});

// POST /api/library/word-download { name, content }
// 直接返回 Word 文件，用于洗稿页与洗稿表下载；不额外写入素材库。
libraryRouter.post('/word-download', async (req: Request, res: Response) => {
  const { name, content } = req.body ?? {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name 必填', code: 'bad_request' });
  try {
    const base = library.safeName(name).replace(/\.docx$/i, '');
    const fileName = `${base}.docx`;
    const buf = await library.wordBuffer(String(content || ''));
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    res.send(buf);
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e), code: 'word_failed' });
  }
});

// POST /api/library/parse-word { name, data(base64) } → 从 .docx 提取纯文本。
libraryRouter.post('/parse-word', async (req: Request, res: Response) => {
  const { name, data } = req.body ?? {};
  if (!name || !data || typeof data !== 'string') return res.status(400).json({ error: '请选择 .docx 文件', code: 'bad_request' });
  if (!/\.docx$/i.test(String(name))) return res.status(400).json({ error: '目前支持 .docx 或 .txt 文件', code: 'unsupported_file' });
  const base64 = data.includes(',') ? data.split(',').pop() || '' : data;
  const input = Buffer.from(base64, 'base64');
  if (!input.length || input.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'Word 文件为空或超过 20MB 限制', code: 'bad_request' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmedia-word-'));
  const file = path.join(dir, 'source.docx');
  try {
    fs.writeFileSync(file, input, { mode: 0o600 });
    const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 10 * 1024 * 1024 });
    const text = xmlToText(stdout);
    if (!text) return res.status(422).json({ error: '未从 Word 中读取到正文内容', code: 'empty_word' });
    res.json({ text });
  } catch {
    res.status(422).json({ error: 'Word 解析失败，请确认文件为未加密的 .docx', code: 'word_parse_failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// GET /api/library/read-word?folder=洗稿&name=xxx.docx
// 从已导出的素材库 Word 读取完整正文，不能使用列表接口的 2,000 字预览。
libraryRouter.get('/read-word', async (req: Request, res: Response) => {
  const folder = String(req.query.folder || '');
  const name = String(req.query.name || '');
  if (folder !== '洗稿' || !name) return res.status(400).json({ error: '仅支持读取洗稿文件夹中的 Word', code: 'bad_request' });
  const file = library.filePath('洗稿', name);
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: '素材库文件不存在', code: 'not_found' });
  if (!/\.docx$/i.test(name)) return res.status(400).json({ error: '当前仅支持导入 .docx 文件', code: 'unsupported_file' });
  try {
    const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 10 * 1024 * 1024 });
    const text = xmlToText(stdout);
    if (!text) return res.status(422).json({ error: '该 Word 未读取到正文内容', code: 'empty_word' });
    res.json({ text });
  } catch {
    res.status(422).json({ error: '素材库 Word 解析失败', code: 'word_parse_failed' });
  }
});

// GET /api/library/file?folder=图片&name=xxx.png → 仅返回已在根目录下扫描到的实体文件。
libraryRouter.get('/file', (req: Request, res: Response) => {
  const folder = String(req.query.folder || '') as LibFolder;
  const name = String(req.query.name || '');
  if (!library.folders.includes(folder) || !name) return res.status(400).json({ error: 'folder/name 非法', code: 'bad_request' });
  const file = library.filePath(folder, name);
  if (!file) return res.status(404).json({ error: '本地文件不存在，刷新素材库后重试', code: 'not_found' });
  res.sendFile(file);
});

// POST /api/library/open { folder, name, reveal? } → 交给当前操作系统默认应用打开。
libraryRouter.post('/open', (req: Request, res: Response) => {
  const folder = String(req.body?.folder || '') as LibFolder;
  const name = String(req.body?.name || '');
  const reveal = Boolean(req.body?.reveal);
  if (!library.folders.includes(folder) || !name) return res.status(400).json({ error: 'folder/name 非法', code: 'bad_request' });
  const file = library.filePath(folder, name);
  if (!file) return res.status(404).json({ error: '本地文件不存在，刷新素材库后重试', code: 'not_found' });
  try {
    if (process.platform === 'darwin') spawn('open', reveal ? ['-R', file] : [file], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'win32') spawn('explorer.exe', reveal ? [`/select,${file}`] : [file], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [reveal ? path.dirname(file) : file], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || '无法使用系统默认应用打开文件', code: 'open_failed' });
  }
});

// POST /api/library/remove { folder, name }
