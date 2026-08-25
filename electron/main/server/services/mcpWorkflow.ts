// MCP 洗稿工作流的本地状态。
//
// 这条链路故意不调用本地 AI：网页 ChatGPT 负责理解、校对和改写，工作台只负责
// 链接解析/下载、状态约束和文件落盘。状态写在 userData/runtime-data 下，避免依赖
// 渲染器 localStorage，也不会把 Cookie、Key 或本机绝对路径返回给 MCP 客户端。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { library } from './library.js';
import { recognizeLink, sourceSnapshot, type SourceSnapshot } from './scrape.js';
import { userRuntimeDataDir } from './runtimePaths.js';

export type RewriteStage =
  | 'awaiting_source'
  | 'awaiting_manual_content'
  | 'awaiting_confirmation'
  | 'awaiting_rewrite'
  | 'awaiting_export'
  | 'completed'
  | 'failed';

export interface RewriteWorkflow {
  id: string;
  type: 'rewrite';
  stage: RewriteStage;
  createdAt: string;
  updatedAt: string;
  link?: string;
  platform?: string;
  sourceId?: string;
  source?: SourceSnapshot;
  recognizedContent?: string;
  requirement?: string;
  draft?: string;
  outputName?: string;
  error?: string;
}

export class McpWorkflowError extends Error {
  constructor(public code: 'not_found' | 'invalid_state' | 'invalid_input' | 'source_expired' | 'export_failed', message: string) {
    super(message);
    this.name = 'McpWorkflowError';
  }
}

let workflowDirPromise: Promise<string> | null = null;

async function workflowDir(): Promise<string> {
  if (!workflowDirPromise) {
    workflowDirPromise = userRuntimeDataDir().then((root) => {
      const dir = path.join(root, 'mcp-workflows');
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
  }
  return workflowDirPromise;
}

function assertId(id: string): string {
  const normalized = String(id || '').trim();
  if (!/^[0-9a-f-]{20,80}$/i.test(normalized)) throw new McpWorkflowError('invalid_input', 'workflowId 无效');
  return normalized;
}

async function workflowFile(id: string): Promise<string> {
  return path.join(await workflowDir(), `${assertId(id)}.json`);
}

async function save(workflow: RewriteWorkflow): Promise<RewriteWorkflow> {
  const file = await workflowFile(workflow.id);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(workflow, null, 2), { mode: 0o600 });
  fs.renameSync(temp, file);
  return workflow;
}

export async function getRewriteWorkflow(id: string): Promise<RewriteWorkflow> {
  const file = await workflowFile(id);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as RewriteWorkflow;
  } catch {
    throw new McpWorkflowError('not_found', `没有找到工作流 ${id}`);
  }
}

function touch(workflow: RewriteWorkflow): RewriteWorkflow {
  workflow.updatedAt = new Date().toISOString();
  return workflow;
}

export async function startRewriteWorkflow(): Promise<RewriteWorkflow> {
  const now = new Date().toISOString();
  return save({ id: randomUUID(), type: 'rewrite', stage: 'awaiting_source', createdAt: now, updatedAt: now });
}

export async function resolveRewriteSource(id: string, link: string, platform?: string): Promise<RewriteWorkflow> {
  const workflow = await getRewriteWorkflow(id);
  if (workflow.stage !== 'awaiting_source') {
    throw new McpWorkflowError('invalid_state', `当前阶段是 ${workflow.stage}，不能重复解析来源`);
  }
  const input = String(link || '').trim();
  if (!/^https?:\/\//i.test(input) && !/https?:\/\//i.test(input)) {
    throw new McpWorkflowError('invalid_input', '请提供完整的 http(s) 链接');
  }
  const result = await recognizeLink(input, platform);
  if (!result.sourceId) throw new McpWorkflowError('source_expired', '链接解析没有生成可继续使用的来源记录');
  const source = sourceSnapshot(result.sourceId);
  if (!source) throw new McpWorkflowError('source_expired', '来源检查结果已失效，请重新开始工作流');
  workflow.link = input;
  workflow.platform = source.platform || platform;
  workflow.sourceId = result.sourceId;
  workflow.source = source;
  workflow.stage = source.text ? 'awaiting_confirmation' : 'awaiting_manual_content';
  workflow.error = undefined;
  return save(touch(workflow));
}

export async function attachRewriteContent(id: string, content: string): Promise<RewriteWorkflow> {
  const workflow = await getRewriteWorkflow(id);
  if (workflow.stage !== 'awaiting_manual_content') {
    throw new McpWorkflowError('invalid_state', `当前阶段是 ${workflow.stage}，不需要补充文字内容`);
  }
  const text = String(content || '').trim();
  if (!text) throw new McpWorkflowError('invalid_input', '补充内容不能为空');
  if (text.length > 100_000) throw new McpWorkflowError('invalid_input', '补充内容不能超过 100,000 个字符');
  workflow.source = { ...(workflow.source as SourceSnapshot), text };
  workflow.stage = 'awaiting_confirmation';
  return save(touch(workflow));
}

export async function confirmRewriteSource(id: string, recognizedContent?: string): Promise<RewriteWorkflow> {
  const workflow = await getRewriteWorkflow(id);
  if (workflow.stage !== 'awaiting_confirmation') {
    throw new McpWorkflowError('invalid_state', `当前阶段是 ${workflow.stage}，请先完成来源解析`);
  }
  const content = String(recognizedContent || workflow.source?.text || '').trim();
  if (!content) throw new McpWorkflowError('invalid_input', '确认前必须提供可改写的稿件内容');
  if (content.length > 100_000) throw new McpWorkflowError('invalid_input', '稿件内容不能超过 100,000 个字符');
  workflow.recognizedContent = content;
  workflow.stage = 'awaiting_rewrite';
  return save(touch(workflow));
}

export async function submitRewrite(id: string, draft: string, requirement?: string): Promise<RewriteWorkflow> {
  const workflow = await getRewriteWorkflow(id);
  if (workflow.stage !== 'awaiting_rewrite') {
    throw new McpWorkflowError('invalid_state', `当前阶段是 ${workflow.stage}，请先确认稿件内容`);
  }
  const output = String(draft || '').trim();
  if (!output) throw new McpWorkflowError('invalid_input', '改写内容不能为空');
  if (output.length > 100_000) throw new McpWorkflowError('invalid_input', '改写内容不能超过 100,000 个字符');
  workflow.draft = output;
  workflow.requirement = String(requirement || '').trim() || undefined;
  workflow.stage = 'awaiting_export';
  return save(touch(workflow));
}

function firstSentence(text: string): string {
  const line = text.split(/\r?\n/).map((item) => item.trim()).find(Boolean) || '未命名稿件';
  return line.replace(/^标题[：:]\s*/u, '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 48);
}

export async function exportRewrite(id: string, requestedName?: string): Promise<RewriteWorkflow> {
  const workflow = await getRewriteWorkflow(id);
  if (workflow.stage !== 'awaiting_export') {
    throw new McpWorkflowError('invalid_state', `当前阶段是 ${workflow.stage}，请先提交改写内容`);
  }
  const base = String(requestedName || `洗稿+${firstSentence(workflow.source?.text || workflow.recognizedContent || '')}`).trim();
  const name = library.safeName(base).replace(/\.docx$/i, '') + '.docx';
  try {
    await library.export({ folder: '洗稿', kind: 'w', name, content: workflow.draft || '' });
  } catch (error) {
    const message = String((error as Error)?.message || error);
    workflow.error = message;
    await save(touch(workflow));
    throw new McpWorkflowError('export_failed', message);
  }
  workflow.outputName = name;
  workflow.stage = 'completed';
  workflow.error = undefined;
  return save(touch(workflow));
}

export function workflowPublicView(workflow: RewriteWorkflow): Record<string, unknown> {
  return {
    workflowId: workflow.id,
    type: workflow.type,
    stage: workflow.stage,
    link: workflow.link,
    platform: workflow.platform,
    title: workflow.source?.title,
    mediaType: workflow.source?.mediaType,
    content: workflow.source?.text,
    recognizedContent: workflow.recognizedContent,
    requirement: workflow.requirement,
    draft: workflow.draft,
    outputName: workflow.outputName,
    fileCount: workflow.source?.fileCount,
    hasLocalMedia: workflow.source?.hasLocalMedia,
    feedback: workflow.source?.feedback,
    error: workflow.error,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}
