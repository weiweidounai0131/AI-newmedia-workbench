# AI 模型提供商管理：需求与实现方案

日期：2026-10-12。范围只覆盖设置页 AI provider/model 配置与现有 AI 调用，不涉及下载、登录、运行时安装或打包。

## 协议与能力表

| 协议 | 文字 / 图文识别 | 模型列表 / 鉴权 | 不支持项 |
|---|---|---|---|
| OpenAI Chat Completions | `POST chat/completions`，`messages`；图像用 `image_url` part；解析 `choices[0].message.content` | `GET models`，`Authorization: Bearer` | 视频只在用户给模型明确勾选“视频输入”时允许；仍用现有 Qwen `video_url` body |
| OpenAI Responses | `POST responses`，`instructions` + `input`；图像用 `input_image`；读取 `output_text` / `output[].content[].text` | `GET models`，`Authorization: Bearer` | 不支持当前 `video_url` 扩展；不得用 Chat Completions body 冒充 Responses |
| Anthropic Messages | `POST messages`，`system`、`max_tokens`、`messages`；图像为 `image` source block；解析文本 content blocks | `GET models`，`x-api-key` 与 `anthropic-version` | 不提供当前视频输入；不得误发 OpenAI 格式或宣称 OpenAI Images 兼容 |

官方协议参考： [OpenAI Chat Completions](https://platform.openai.com/docs/api-reference/chat/create)、[Responses](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Images generate/edit](https://developers.openai.com/api/reference/resources/images)、[OpenAI models list](https://developers.openai.com/api/reference/resources/models/methods/list)、[Anthropic Messages](https://platform.claude.com/docs/en/api/messages)、[Anthropic models list](https://platform.claude.com/docs/en/api/models/list)。实现以这些协议页面为准，不按模型名前缀推断能力。

出图仍走 OpenAI Images `images/generations` / `images/edits`，保留参考图编辑、既有 SudoCode 选项和 Codex 订阅出图路径。Responses/Anthropic provider 不可选为 OpenAI Images 槽位。Qwen 视频只在 Chat Completions provider 且该模型由用户明确勾选视频输入时可选；不新增 Gemini 原生协议。

## 配置、API 与安全约束

- 主设置区拆为“模型提供商管理”卡片（添加、编辑、删除）和“能力分配”四槽位：文字改写、图文识别、视频识别、出图。provider 使用稳定 ID；每个 model ID 单独勾选能力。`GET /models` 只发现 ID，不代表可用能力；失败时可手工添加模型 ID。
- 内置 provider ID、原 `keyId`、默认槽位及模型映射保持可读；读取旧 `settings.json` 时兼容已有 `keys`、`providers`、`suppliers`、`verified` 字段，不读真实配置做迁移验收。自定义 provider 的 Key 仍进入现有 `keys` 加密映射，每个 provider/key 仅保存一份；空白编辑 Key 表示保留现值。GET 只返回 `keyConfigured`，不回传明文或密文。
- provider/model 删除若被任一能力槽引用，返回冲突并列出槽位；不偷偷替换默认。配置、Key 或 model capability 更新递增版本并使相关槽位验证失效。验证请求开始时快照 provider、model、Key 版本；完成时若配置版本已变，不得标为新配置已验证。模型获取状态与能力验证状态分别显示。
- 模型获取与生成统一用本地 OpenAI SDK client / 现有 HTTPS proxy agent。模型列表请求总超时 20 秒、`maxRetries=0` 且支持取消；Anthropic 用同一 client 的原始 `get/post`，通过 `Authorization: null` 移除 SDK Bearer，再设置 `x-api-key` 与 `anthropic-version`，不产生双鉴权，也不让 Node 原生 fetch 绕过 `HTTPS_PROXY`。401、404、超时、空列表给出明确提示。上游错误 body/headers 不进 UI、日志或 AI audit；错误只保留安全类别与 HTTP 状态，不能只靠 `sk-` 正则脱敏。
- Responses 的 capability 验证按官方 schema 使用 `max_output_tokens` 最小值 16；图片出图验证不请求生成端点，避免验证动作生成/计费图片。
- Base URL 仅接受 `http:`/`https:`，拒绝 userinfo、fragment、query 和内嵌凭证；允许明确 localhost/回环地址。把用户输入的 URL path 原样作为 API base，不强行补 `/v1`、不覆盖自定义网关路径；endpoint 仅追加对应协议的相对 endpoint。UI 标注填写 provider API 根地址并给含路径示例。
- 前端 Key 仅存在未持久化的表单 state，不写 store/local storage；不新增明文秘密文件、不读取真实 key/profile/log/env。错误不能把任意格式自定义 Key 或上游回显内容带回 UI/audit/log。

## 实现边界与验收

预计实现文件：`electron/main/server/services/caps.ts`、`settings.ts`、`aiProxy.ts`、`routes/settings.ts`；`src/views/Settings.tsx`、`src/api/client.ts`、必要的 settings UI 类型；新增单一 scoped fake verifier 与 `package.json` 命令。只改 AI 设置/请求路径，Codex、Qwen 视频、图片编辑及其他产品流程保持既有入口。

合成验收覆盖：旧设置 schema 迁移与持久重载；provider CRUD、加密单份 Key、GET 无 Key；模型发现与手工添加、401/404/超时/空列表；四能力槽兼容过滤/删除保护/立即生效；Chat/Responses/Anthropic 文字与图像 body/解析；OpenAI Images 生成/编辑不发起真实生成；Qwen 视频 body 不变；Key/配置变更失效与并发验证不误标；base URL 校验和 proxy agent 传递；上游错误不泄露 Key。UI 需以真实 React 接 local mock 做添加/编辑/删除/四槽分配交互与截图，不用源码字符串断言。

不执行真实付费生成、不读取用户现有设置或密钥、不启动安装版、不打包或发布。交付后仍需用户自行用供应商账号验证网络/网关兼容性；本批 fake 测试不代表真实模型能力或供应商额度可用。
