# 网页 ChatGPT · AI 新媒体工作台 MCP 最小闭环

## 目标

MCP 是工作台的一条备用入口，不替换现有 `/api` 和设置页里的 DeepSeek、智谱、千问、AIHubMix 配置。网页 ChatGPT 负责理解、校对和生成改写稿；工作台负责平台链接解析/下载、流程状态约束和本地 Word 落盘。

第一版只开放文字洗稿闭环：

1. 创建洗稿工作流；
2. 用户提供链接，工作台解析来源并返回可读文字；
3. ChatGPT 展示原稿，等待用户人工确认；
4. ChatGPT 根据用户要求生成改写稿并回传；
5. 用户确认后，工作台导出到已配置的本地素材库 `洗稿` 文件夹。

图片和视频仍由原工作台链路处理。MCP 第一版不会把本机文件路径、Cookie、API Key 或浏览器 profile 发给网页端；遇到只有图片/视频而没有可返回文字的来源时，工具会要求用户手动粘贴文字。

## 本地端点

开发服务：`http://127.0.0.1:8787/mcp`

Electron 打包应用：后端仍只监听 `127.0.0.1` 的随机端口；设置页「网页 ChatGPT 连接（MCP）」会显示当前端点并可复制。端点健康检查为 `/mcp/health`。

如需把端点交给网页 ChatGPT，不能直接填写 `localhost`：网页端需要能访问的 HTTPS MCP 地址。请使用受信任的 MCP 隧道或反向代理，把公网 HTTPS 请求转发到本机这个端点，并只转发 `/mcp`。不要把工作台端口直接暴露到公网。

如果隧道支持固定 Bearer Token，可在启动工作台前设置：

```text
MCP_AUTH_TOKEN=仅保存在本机和隧道配置中的随机长字符串
```

带 Token 时，客户端请求必须携带：`Authorization: Bearer <token>`。Token 不要提交到 GitHub、截图或聊天中。

## ChatGPT 连接方式

在 ChatGPT 的开发者模式中新增一个远程 MCP/连接器，填入隧道提供的 HTTPS `/mcp` 地址和认证信息。ChatGPT 网页端不会读取本机 Codex CLI 的 MCP 配置，所以需要在网页端单独添加这个连接器。

连接成功后，可以在对话中说“开始洗稿”，ChatGPT 应按工具返回的 `next` 指引逐步调用工具；不要跳过人工确认，也不要在用户确认导出前调用导出工具。

## 工具清单

| 工具 | 用途 |
| --- | --- |
| `workbench_start_rewrite` | 创建工作流并返回 `workflowId` |
| `workbench_set_rewrite_source` | 解析用户链接、下载并返回文字摘要 |
| `workbench_attach_rewrite_content` | 图片/视频来源无法返回文字时，接收用户粘贴内容 |
| `workbench_confirm_rewrite_source` | 用户人工校对后放行改写 |
| `workbench_submit_rewrite` | 保存网页 ChatGPT 生成的改写稿，等待导出确认 |
| `workbench_export_rewrite` | 导出 Word 到本地素材库/洗稿 |
| `workbench_get_rewrite_status` | 查询工作流当前阶段 |

每个工作流保存在当前用户的 `runtime-data/mcp-workflows` 中，服务重启后仍保留状态；平台来源的临时抓取缓存仍遵循工作台原有生命周期。

## 验收边界

这一版验证的是“网页 ChatGPT → MCP → 工作台”的协议和状态机闭环，不代表网页端已经接入，也不代表图片/视频二进制已经能被网页模型直接读取。下一阶段再增加选题表选择、图文识别、视频抽帧、创意和图片导出工具。
