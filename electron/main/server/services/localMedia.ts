import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { VisionPart } from './aiProxy.js';

const IMAGE_EXT = /\.(jpe?g|png|webp)$/i;
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;

function mimeOf(file: string): string {
  if (/\.png$/i.test(file)) return 'image/png';
  if (/\.webp$/i.test(file)) return 'image/webp';
  return 'image/jpeg';
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: 'ignore' });
    child.on('error', () => reject(new Error('本机未找到 FFmpeg，无法抽取视频画面')));
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('视频关键帧提取失败')));
  });
}

/** 将已下载的混合笔记媒体转为视觉模型可读的图片；视频只抽取少量关键帧。 */
export async function localMediaToVisionParts(files: string[], options?: { maxImages?: number }): Promise<VisionPart[]> {
  const parts: VisionPart[] = [];
  const maxImages = options?.maxImages ?? 4;
  for (const file of files.filter((p) => IMAGE_EXT.test(p)).slice(0, maxImages)) {
    try { parts.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mime: mimeOf(file) }); } catch { /* 单图失败不影响其余素材 */ }
  }
  const video = files.find((p) => VIDEO_EXT.test(p));
  if (!video) return parts;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmedia-frames-'));
  try {
    // 依视频时长均匀抽 4 帧；仅本地文件操作，不再访问内容平台。
    await ffmpeg(['-hide_banner', '-loglevel', 'error', '-i', video, '-vf', 'fps=1/5', '-frames:v', '4', path.join(dir, 'frame-%02d.jpg')]);
    for (const name of fs.readdirSync(dir).filter((p) => IMAGE_EXT.test(p)).slice(0, 4)) {
      const frame = path.join(dir, name);
      parts.push({ type: 'image', data: fs.readFileSync(frame).toString('base64'), mime: 'image/jpeg' });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return parts;
}
