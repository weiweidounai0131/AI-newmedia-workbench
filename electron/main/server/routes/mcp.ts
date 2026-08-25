// 网页 ChatGPT 使用的 MCP Streamable HTTP 入口。
// 工作台的 API 链路保持不变；这里仅暴露受状态机约束的备用工作流工具。
import { Router, type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import {
  McpWorkflowError,
  attachRewriteContent,
  confirmRewriteSource,
  exportRewrite,
  getRewriteWorkflow,
  resolveRewriteSource,
  startRewriteWorkflow,
  submitRewrite,
  workflowPublicView,
} from '../services/mcpWorkflow.js';

export const mcpRouter = Router();

const MCP_AUTH_TOKEN = () => process.env.MCP_AUTH_TOKEN?.trim() || '';

function isAuthorized(req: Request): boolean {
  const expected = MCP_AUTH_TOKEN();
  if (!expected) return true;
  const header = String(req.headers.authorization || '');
  return header === `Bearer ${expected}`;
}

function jsonText(data: Record<string, unknown>): string {
  return JSON.stringify(data, null, 2);
}

function ok(data: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: jsonText(data) }] };
}

function failure(error: unknown) {
  const code = error instanceof McpWorkflowError ? error.code : 'internal_error';
  const message = String((error as Error)?.message || error);
  return { isError: true, content: [{ type: 'text' as const, text: jsonText({ ok: false, code, error: message }) }] };
}

function workflowResponse(workflow: Awaited<ReturnType<typeof startRewriteWorkflow>>, next: string) {
  return ok({ ok: true, ...workflowPublicView(workflow), next });
}

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: 'ai-newmedia-workbench', version: '0.1.0-mcp' });

  server.registerTool('workbench_start_rewrite', {
    title: '开始洗稿工作流',
    description: '创建一个新的洗稿任务。创建后必须先调用 workbench_set_rewrite_source 提供链接，不能跳过来源解析。',
  }, async () => {
    try {
      const workflow = await startRewriteWorkflow();
      return workflowResponse(workflow, '请让用户提供一个完整的抖音、小红书或普通网页链接，然后调用 workbench_set_rewrite_source。');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_get_rewrite_status', {
    title: '查看洗稿任务状态',
    description: '查看当前洗稿工作流的阶段、来源摘要和已提交内容。',
    inputSchema: { workflowId: z.string().min(20).describe('由 workbench_start_rewrite 返回的 workflowId') },
  }, async ({ workflowId }) => {
    try {
      const workflow = await getRewriteWorkflow(workflowId);
      return workflowResponse(workflow, '根据 stage 决定下一步，不要绕过状态机。');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_set_rewrite_source', {
    title: '解析洗稿来源',
    description: '把用户提供的链接交给工作台解析/下载。解析只负责来源检查，不调用本地 AI；成功后返回可供 ChatGPT 校对的文字摘要。',
    inputSchema: {
      workflowId: z.string().min(20).describe('工作流 ID'),
      link: z.string().min(1).describe('用户粘贴的分享文本或完整 http(s) 链接'),
      platform: z.string().optional().describe('可选平台：抖音、小红书、微博、知乎'),
    },
  }, async ({ workflowId, link, platform }) => {
    try {
      const workflow = await resolveRewriteSource(workflowId, link, platform);
      const next = workflow.stage === 'awaiting_confirmation'
        ? '请把 content 展示给用户校对；用户明确确认后，调用 workbench_confirm_rewrite_source。'
        : '当前来源含本地图片/视频但没有可直接返回的文字；请让用户粘贴要改写的文字，再调用 workbench_attach_rewrite_content。';
      return workflowResponse(workflow, next);
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_attach_rewrite_content', {
    title: '补充洗稿文字',
    description: '当链接已解析但只有图片/视频、无法把二进制交给网页 ChatGPT 时，接收用户粘贴的文字内容。',
    inputSchema: {
      workflowId: z.string().min(20).describe('工作流 ID'),
      content: z.string().min(1).max(100_000).describe('用户确认要交给 ChatGPT 校对的原稿文字'),
    },
  }, async ({ workflowId, content }) => {
    try {
      const workflow = await attachRewriteContent(workflowId, content);
      return workflowResponse(workflow, '请把 content 展示给用户校对；用户明确确认后调用 workbench_confirm_rewrite_source。');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_confirm_rewrite_source', {
    title: '确认洗稿原稿',
    description: '仅在用户人工校对并明确确认后调用。调用后才允许提交改写稿。',
    inputSchema: {
      workflowId: z.string().min(20).describe('工作流 ID'),
      recognizedContent: z.string().max(100_000).optional().describe('校对后的原稿；不传则使用工作台返回的 content'),
    },
  }, async ({ workflowId, recognizedContent }) => {
    try {
      const workflow = await confirmRewriteSource(workflowId, recognizedContent);
      return workflowResponse(workflow, '请根据用户的洗稿要求生成改写稿；生成后调用 workbench_submit_rewrite，不要直接导出。');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_submit_rewrite', {
    title: '提交 AI 改写稿',
    description: '保存网页 ChatGPT 生成的改写稿，提交后仍需用户确认是否导出。',
    inputSchema: {
      workflowId: z.string().min(20).describe('工作流 ID'),
      draft: z.string().min(1).max(100_000).describe('网页 ChatGPT 生成的改写稿'),
      requirement: z.string().max(2_000).optional().describe('用户的洗稿要求，例如：改朋友圈口语风'),
    },
  }, async ({ workflowId, draft, requirement }) => {
    try {
      const workflow = await submitRewrite(workflowId, draft, requirement);
      return workflowResponse(workflow, '请让用户确认是否导出；确认后调用 workbench_export_rewrite。');
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool('workbench_export_rewrite', {
    title: '导出洗稿文件',
    description: '只有用户确认改写稿后才调用。将内容保存到工作台已配置的本地素材库/洗稿目录，并返回文件名。',
    inputSchema: {
      workflowId: z.string().min(20).describe('工作流 ID'),
      name: z.string().max(120).optional().describe('可选文件名，不含扩展名也可以'),
    },
  }, async ({ workflowId, name }) => {
    try {
      const workflow = await exportRewrite(workflowId, name);
      return workflowResponse(workflow, '工作流已完成。素材库页面刷新后可以看到该 Word 文件。');
    } catch (error) {
      return failure(error);
    }
  });

  return server;
}

mcpRouter.get('/health', (req: Request, res: Response) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: 'MCP_AUTH_TOKEN 无效' });
  res.json({ ok: true, transport: 'streamable-http', auth: Boolean(MCP_AUTH_TOKEN()), tools: 7 });
});

mcpRouter.post('/', async (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP_AUTH_TOKEN 无效' }, id: null });
  }
  const server = buildMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error('[mcp] request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'MCP 服务内部错误' }, id: null });
    }
  }
});

function methodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'MCP 端点仅支持 POST' }, id: null });
}

mcpRouter.get('/', methodNotAllowed);
mcpRouter.delete('/', methodNotAllowed);
