# AI新媒体工作台（Electron 桌面端）

面向个人创作者的新媒体内容工作台封装工程。设计决策全部收口于 `docs/tech/BACKEND-PATH.md`，本仓库是其工程落地。

## 里程碑进度

| 里程碑 | 范围 | 状态 |
|---|---|---|
| **M0** | electron-vite 工程脚手架（React+Vite+TS / Express 主进程 / 配置） | ✅ 完成 |
| **M1** | 后端 aiProxy + Key 加密 + Express 路由（四能力路由 / AIHubMix 出图中转 / 一次性返回 / dry-run） | ✅ 完成（20/20 验证通过） |
| M2 | UI 搬迁（原型 → HeroUI 组件） | ✅ 完成（tsc + Vite 构建 + 无头渲染冒烟通过） |
| M3 | 素材库本地直写（方案 C）+ 热榜/搜索后端数据源 | ✅ 完成（tsc + Vite 构建 + 后端落盘 + 无头全流程通过） |
| M4 | 抓取（Electron 原生 BrowserWindow 登录态）+ 链接洗稿多模态识别 + 热榜/搜索适配器占位 | ✅ 完成（tsc + Vite 构建 + 后端冒烟 7 项全绿 + 无头端到端通过） |
| M5 | 打包 + 签名 + CI 双平台 | ✅ 完成（本地全量编译 + 配置/CI YAML 校验；真实双平台签名产物由 CI 产出） |

## 工程结构

```
electron/
  main/
    index.ts                # 主进程：起 Express 后端 + 渲染窗口
    preload/index.ts        # 仅向渲染进程暴露本地后端地址（Key 永不进前端）
    server/
      index.ts              # createApp()：Express 装配（也可被 Node 独立起）
      dev.ts                # M1 独立运行入口（不依赖 Electron，用于验证 AI 链路）
      verify.ts             # M1 验证脚本（stub fetch 拦截，不触网不耗 Key）
      routes/settings.ts    # /api/settings（GET 摘要 / POST key / supplier / rootdir / verify）
      routes/ai.ts          # /api/ai（tishici / xigao/recognize / xigao/rewrite / chutu / xigao/recognize-link）
      routes/scrape.ts      # /api/scrape（status / login）—— M4 抓取登录态
      routes/content.ts     # /api/content（hot / search）—— 后端策展数据源（M3 真实化，M4 适配器占位）
      services/
        caps.ts             # CAP_SLOTS 四能力槽位定义（单一事实源 §2.1/§6.1）
        settings.ts         # Key 本地加密（safeStorage / AES-256-GCM 降级）
        aiProxy.ts          # AI 代理层：四能力路由 + 出图中转 + 一次性返回 + 错误归一
        promptParse.ts      # 提示词分隔符拆分（三级容错 §3.2）
        scrape.ts           # M4 抓取服务：Electron 登录态持久化 + 链接抓取 + 多模态识别 + 热榜/搜索适配器占位
src/                       # React 渲染进程（HeroUI；M2 已搬迁 7 视图）
  api/client.ts            # 前端 → 本地后端 loopback 调用封装（Key 永不进前端）
  store/appStore.ts        # 跨视图状态总线（useSyncExternalStore，对齐原型 STATE/WORKFLOW/LIB）
  data/sample.ts           # 热榜 / 搜索本地样本（M3/M4 接真实后端前用）
  icons.tsx                # 自绘图标集（对齐原型 I 图标，stroke 1.75）
  lib/ui.ts                # useToastMsg(addToast) / mapSize / mapQuality / copyText
  views/                   # Home / Xuanti / Xigao / Tishici / Chutu / Sucai / Settings
  main.tsx                 # HeroUIProvider + ToastProvider 装配
docs/                      # PRD / 技术路径 / 工作流（设计单一事实源）
prototype/index.html       # 单文件视觉基线（保留作还原对照）
```

## 核心设计（与 BACKEND-PATH 对齐）

- **统一 `openai` SDK**：四家全 OpenAI 兼容，按能力切 `baseURL`+`apiKey`（`aiProxy.ts` `buildClient`）。
  - `text` → `https://api.deepseek.com`（deepseek-chat）
  - `visionImg` → `https://open.bigmodel.cn/api/paas/v4/`（glm-4v-flash）
  - `visionVideo` → `https://dashscope.aliyuncs.com/compatible-mode/v1`（qwen-vl-max）
  - `image` → `https://aihubmix.com/v1`（gpt-image-1，**经 AIHubMix 中转**，Key 即 AIHubMix Key；有参考图走 `/images/edits`，无参考图走 `/images/generations`）
- **一次性返回（非流式）**：v1 所有 AI 步请求→等待→整段返回，UI 用加载态。
- **Key 本地加密**：优先 Electron `safeStorage`；Node/测试环境降级为「机器指纹+持久 salt」派生 AES-256-GCM。明文 Key 永不进前端、不写日志、不落明文。
- **前端永不持有 Key**：所有调用经本地 loopback 后端代理；前端只持 `configured` 布尔。
- **错误归一**：上游异常映射为 `key_missing / invalid_base / rate_limited / moderation_blocked / upstream_error`，前端按 `code` 分支提示。

## 如何运行 / 验证 M1 后端

> 仅验证后端 AI 链路时，无需安装 Electron（跳过其 Chromium 二进制下载）。

```bash
# 1) 安装依赖（M1 最小集合）
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm install --no-save \
  openai express tsx typescript @types/node @types/express

# 2) 跑 M1 验证：断言四能力路由/请求体正确 + Key 加密往返，不触网不耗 Key
npm run verify:m1
# 期望输出：=== 结果：20 通过 / 0 失败 ===

# 3) 起独立后端（填真实 Key 后可直接真出图）
npm run dev:server          # 默认 http://127.0.0.1:8787
# 另开终端：
curl http://127.0.0.1:8787/api/health
curl -X POST http://127.0.0.1:8787/api/settings/key \
  -H 'Content-Type: application/json' -d '{"cap":"image","key":"sk-你的AIHubMixKey"}'
curl -X POST http://127.0.0.1:8787/api/ai/chutu \
  -H 'Content-Type: application/json' -d '{"prompt":"宽带春日促销海报","size":"1024x1536"}'
```

## 如何运行 / 验证 M2 前端

> M2 已具备后端的视图（设置 / 提示词 / 洗稿改写 / 出图）接真实本地后端；首页 / 选题 / 素材库为视觉还原（真实热榜 / 搜索 / 抓取后端在 M3/M4）。

```bash
# 1) 依赖（HeroUI 固定在 v2.7+，兼容 React 18；framer-motion 配套）
npm install

# 2) 网页开发：先起本地后端（终端 A）
npm run dev:server                 # http://127.0.0.1:8787，监听 server 代码并自动重启

# 3) 网页开发：再起前端（终端 B）
npm run dev:web                    # http://localhost:5174，监听前端代码并热更新

# 浏览器访问：http://localhost:5174
# 前端会直接请求 http://127.0.0.1:8787；两条命令都需要保持运行。
# 如修改 .env 等启动环境变量，请手动重启对应服务。

# 需要验证 Electron 桌面壳时，另行使用：
npm run dev                        # electron-vite dev

# 4) 仅类型检查 / 构建
npm run typecheck                  # tsc --noEmit
npx vite build                     # 产出 out/renderer
```

**M2 范围与接真后端对照**
- 真实 API：`/api/settings`（GET/POST key/supplier/rootdir/verify）、`/api/ai/tishici`（分隔符拆分三级容错）、`/api/ai/xigao/rewrite`、`/api/ai/chutu`（b64 真图渲染）。
- 视觉还原（M3/M4 接真后端）：首页仪表盘、选题（热门 / 搜索 / 选题表）、素材库（三文件夹 + 预览 / 下载）。
- 链接模式洗稿的多模态识别（图片/文章/视频分发的 `xigao/recognize-link`）已由 M4 实现并接真后端（见上「M4」段）。

## 下一步（M3 / M4 / M5）

- **M3（已完成）**：素材库实体文件本地直写（方案 C）+ 热榜/搜索后端数据源单一事实源。
  - **素材库落盘**：`POST /api/library/export` 按 `kind` 写真实文件（`i`→PNG base64 解码 / `x`→exceljs 工作表 / `w`→docx 文档），按「同日同名」覆盖；索引持久化 `library.json`（数据目录 `.data/`）。`GET /api/library` 返回索引 + 根目录；`POST /api/library/remove` 同时删索引与磁盘文件。
  - **索引驱动**：前端 `src/store/appStore.ts` 的 `lib` 由内存改为后端单一事实源（`loadLibrary()` 挂载拉取、`exportImageToLib/exportTextToLib` 写后回刷索引）；后端不可用时降级内存，UI 仍可用。
  - **热榜 / 搜索数据源**：前端不再自带 `HOT_LISTS`/`SEARCH` 硬编码，改 `GET /api/content/hot`、`GET /api/content/search` 由后端策展（与 prototype 对齐，热榜现已接入 vikiboss/60s，路由契约不变）。首页「四平台 TOP3」同样后端驱动。
  - **设置可编辑**：素材库导出根目录可在「设置」页输入并 `POST /api/settings/rootdir` 真实生效（落盘路径随之切换），Electron 真实封装的目录选择器见 M4。
  - **CORS**：后端回显请求 Origin（仅监听 127.0.0.1，外部不可达），放行 Electron 渲染进程（`app://`、`file://`）与 headless 验证的跨源请求。
  - 设计注：`libraryStore` 持久化采用 `library.json`（轻量、零依赖），而非早期方案的 SQLite。
- **M4（已完成）**：抓取（Electron 原生 BrowserWindow 登录态）+ 链接洗稿多模态识别 + 热榜/搜索适配器占位。
  - **抓取登录态**：`services/scrape.ts` 在 Electron 主进程内 `login(platform)` 开 `persist:scrape-<platform>` 分区 `BrowserWindow`，监听 `did-navigate` 离开登录页即抓 cookie 落盘 `.data/scrape.json`；`hasSession()`/`status()` 供后续带态抓取与前端「已连接」指示。Node 独立运行（`npm run dev:server`）无 electron → 登录报 `electron_required`，其余降级。
  - **链接多模态识别**：`POST /api/ai/xigao/recognize-link {link, platform?}` → `recognizeLink()` 依 `detectMediaType()` 分发：`image`→字节 base64 送 `visionImg`(GLM-4V)；`article`→轻量 HTML 抽取标题+正文（无第三方依赖、无 Key 亦可跑）；`video`→需 Electron 登录态，无态返回 `needLogin` 引导。`recognize-link` 路由捕获 `ScrapeError` 归一为 `bad_link / not_image / not_html / key_missing / electron_required / needLogin` 等 `code`。
  - **热榜/搜索适配器占位**：`fetchHot/fetchSearch` 初版返回 `null` → `routes/content.ts` 回退策展样本并标 `live:false`；后续按平台逐个接入真实抓取（签名不变），即自动转 `live:true`，前端契约稳定。
  - **前端接线**：`api.client` 新增 `scrapeStatus()/scrapeLogin(p)/xigaoRecognizeLink(body)`；`Xigao.tsx` 链接模式「识别→确认并改写」走 `recog` 文本交 `runRewite`；`Settings.tsx` 抓取账号面板四平台连接态 + 登录/重新登录（Node 模式提示「需 Electron」）。
  - **验证**：`tsc` + `vite build` 零错误；后端冒烟 7 项全绿（status / electron_required / content 回退 / 文章抽正文 / 图片触达视觉模型 key_missing / 视频 needLogin / 非法 bad_link）；无头 CDP 跑通 Xigao 链接模式端到端（填 → 识别 → 确认改写，控制台零异常）。
- **M5（已完成）**：打包 + 签名 + CI 双平台产出（单一事实源 BACKEND-PATH §7）。
  - **打包链路**：`electron-vite build` 全量编译主进程（`out/main`，Express 后端 + 抓取 + 封装）、预加载（`out/preload`）、渲染进程（`out/renderer`）；产物经 `electron-builder` 打进 `app.asar` + `extraResources`，后端随主进程打包、不另起服务。
  - **双平台配置**：`electron-builder.yml` 中 `mac` 出 `dmg`（含 `zip` 兜底）、`win` 出 `nsis`(`exe`)/`msi`；`mac` 开 `hardenedRuntime` + `entitlements`（`build/entitlements.mac.plist`，放行 JIT/出网）；`win` `nsis` 支持桌面快捷方式、安装目录可选。
  - **签名/公证（环境变量注入，不落库）**：macOS 经 `APPLE_CERT_BASE64`/`APPLE_CERT_PASSWORD`/`APPLE_TEAM_ID`/`APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD` 自动 codesign + notarize；Windows 经 `CSC_LINK`(p12 base64)/`CSC_KEY_PASSWORD` 自动 Authenticode。缺证书时本地仍能产「未签名」包。
  - **CI 双 runner**：`.github/workflows/build.yml` 两 job 并行——`build-mac`(macos-latest，导入证书 + notarize)、`build-win`(windows-latest，Authenticode)；打 `v*` tag 时自动合入 GitHub Draft Release。依赖 `npm install`（`ELECTRON_SKIP_BINARY_DOWNLOAD=1`，二进制由 electron-builder 构建期下载）；两 runner 证书 Secrets 隔离。
  - **验证**：本地 `electron-vite build` 全量编译零错误（2152 渲染模块 + 主进程 4.7MB）、`tsc` 零错误；`electron-builder.yml`/`build.yml` YAML 与 `entitlements.mac.plist` XML 均校验合法；真实双平台签名产物由其 CI（有网络 + 证书 Secrets）产出。

## 如何运行 / 验证 M5

> 真实打包需要目标平台 electron 二进制与代码签名证书，均在 CI 完成；本机只做「未签名」预览与配置校验。

```bash
# 1) 全量编译（主进程 + 预加载 + 渲染），产物进 out/
npm run build                 # = electron-vite build

# 2) 本地未签名打包预览（需先放 resources/icon.icns 与 icon.ico）
npm run pack                  # electron-builder --dir（解包目录，免安装试跑）
npm run dist                  # 全平台未签名产物（dist/）

# 3) 仅出某一平台（CI 同理，但带签名）
npm run dist:mac              # .dmg / .zip
npm run dist:win              # .exe / .msi

# 4) 配置/CI 语法校验（无需网络）
node -e "require('js-yaml').load(require('fs').readFileSync('electron-builder.yml','utf8'))"
node -e "require('js-yaml').load(require('fs').readFileSync('.github/workflows/build.yml','utf8'))"
```

**发布前前置（一次性）**
- 图标：`resources/icon.icns`（mac）/ `resources/icon.ico`（win）必须存在，否则打包中断（详见 `resources/README.md`）。
- 仓库 Secrets（GitHub → Settings → Secrets）：
  - **Mac runner**：`APPLE_CERT_BASE64`、`APPLE_CERT_PASSWORD`、`APPLE_TEAM_ID`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`KEYCHAIN_PWD`。
  - **Win runner**：`WIN_CSC_LINK`（p12 base64）、`WIN_CSC_KEY_PASSWORD`（CI 内映射为 `CSC_LINK`/`CSC_KEY_PASSWORD`）。
- 触发：`git tag v0.1.0 && git push --tags` → 两 runner 并行产出签名包并合入 Draft Release。
