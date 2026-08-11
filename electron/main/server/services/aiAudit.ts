import fs from 'node:fs';
import path from 'node:path';

export interface AiAuditEntry {
  at: string;
  capability: 'text' | 'visionImg' | 'visionVideo' | 'image';
  model: string;
  ok: boolean;
  durationMs: number;
  mediaCount?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  error?: string;
}

function auditPath(): string {
  const root = process.env.NEWMEDIA_DATA_DIR || path.join(process.cwd(), '.data');
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'ai-audit.jsonl');
}

/** 不保存 Key、提示词、正文或图片，仅保留可核对的调用事实。 */
export function recordAiAudit(entry: AiAuditEntry): void {
  try { fs.appendFileSync(auditPath(), `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 }); } catch { /* 审计写入不可影响主流程 */ }
}

export function listAiAudit(limit = 50): AiAuditEntry[] {
  try {
    return fs.readFileSync(auditPath(), 'utf8').trim().split('\n').filter(Boolean).slice(-limit).reverse().map((line) => JSON.parse(line));
  } catch { return []; }
}
