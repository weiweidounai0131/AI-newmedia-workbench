# AI新媒体工作台 v2.0.0

面向个人与团队创作者的跨平台新媒体内容生产桌面工作台，覆盖 **热点选题 → 借势创意 → 爆款洗稿 → 提示词工程 → AI 出图 → 本地素材库** 全链路工作流。

**v2.0.0 全面升级为 Rust + Tauri 2 原生桌面架构**，彻底移除 Electron、Express、Python 虚拟环境、Playwright 与外部第三方依赖窗口（`MediaCrawler` / `wechat-mp-tools` / `iframe`），安装包体积直降 **99%+**，冷启动毫秒级响应。

> 原 v0.1.x Electron 版本已完整归档于 [`v1-electron`](https://github.com/weiweidounai0131/AI-newmedia-workbench/tree/v1-electron) 分支。

---

## v2.0.0 vs v1.x 核心对比

| 维度 | v1.x (Electron + Python) | v2.0.0 (Rust + Tauri 2) |
| :--- | :--- | :--- |
| **体积占用** | ~1.32 GB（386 MB 应用 + 876 MB Python 运行时） | **~7.8 MB DMG / ~9.1 MB App**（瘦身 99%+） |
| **外部依赖** | 需下载 Python / Playwright / 第三方桌面工具 | **零 Python、零 Playwright**，自动静默复用本机 Chrome / Edge |
| **AI 响应体验** | 一次性等待返回 | **全站统一 SSE 真流式输出** + 流畅 `motion` 弹簧动效 |
| **素材解析与下载** | 内嵌外部工具 iframe 窗口 | **Rust 原生四级解析下载器** + FFmpeg 关键帧提取 |
| **密钥与隐私** | 明文配置或单端存储 | **macOS Keychain / Windows 凭据管理器** + AES-256-GCM 加密，明文永不进前端 |

---

## 核心功能一览

- **选题（热门热榜 + 主动搜索 + 选题表）**
  - **四平台实时热榜**：抖音、小红书、微博、知乎整点缓存与双上游源自动容错（`60s` + `uapis`）。
  - **后台静默主动搜索**：复用本机 Chrome/Edge（`--headless=new`）在后台隔离 Profile 运行，不弹外部窗口；遇到安全验证支持按需拉起验证窗口；内置冷却限频与风控提醒。
  - **选题表管理**：标题与外链一键调用系统默认浏览器打开，支持系统原生「另存为」导出标准 `.xlsx` 及一键归档至本地素材库。
- **创意（热点借势 + 4 方向策划）**
  - 一键从选题表导入热榜，AI 生成 4 个差异化借势方向，选定后流式生成完整传播文案与多轮 AI 优化。
- **洗稿（抖音无水印视频 & 小红书图文 + 原稿直贴）**
  - **抖音**：纯 Rust `a_bogus`（RC4 + 国密 SM3）签名 + 四级解析兜底，下载无水印高清视频，自动调用本机 FFmpeg 抽取轻量化关键帧交由视觉模型还原口播与核心结构。
  - **小红书**：复用已登录 CDP 会话解析 `window.__INITIAL_STATE__`，并发下载无水印图片与 `文案.txt` 到统一缓存目录，逐图视觉识别。
  - **流式改写 & 原生导出**：实时 SSE 流式输出改写文案，支持原生「另存为」导出 `.docx` 与归档至素材库。
- **提示词 & 出图**
  - 图文拆解三级容错引擎，自动拆分文字文案与多张配图提示词并一键带入出图。
  - 支持标准 OpenAI Images 接口以及 **本机已登录 Codex CLI 自动发现与极速隔离生图**（无感集成于设置页图片生成配置中）。
- **素材库（本地文件夹同步 + 统计概览）**
  - 新增 **统计概览首页**：实时统计素材总量、今日更新数、占用空间、四大板块（`选题 / 创意 / 洗稿 / 图片`）明细与最近更新记录，支持跨视图 Tab 状态记忆。
  - 实体文件始终保存在用户指定的本地目录，支持系统原生预览与一键在访达/资源管理器中定位。
- **精细网络路由与安全模型管理**
  - **四能力独立模型槽位**（文字改写 / 图片识别 / 视频识别 / 图片生成），全面支持 `OpenAI Chat Completions`、`OpenAI Responses`、`Anthropic Messages` 三大协议。
  - **智能代理分流**：抖音/小红书抓取与下载强制国内直连（不走外网代理）；远端 AI 模型与 Codex CLI 自动识别系统代理；本机回环网关（`127.0.0.1` / `localhost`）自动免代理直连。

---

## 技术栈

- **桌面与后端**：Rust (`edition = 2021`) · Tauri 2 · Tokio · Reqwest (`rustls-tls`) · `tokio-tungstenite`（原生 CDP）· `keyring` · `aes-gcm` · `rust_xlsxwriter` · `zip`（纯 Rust OOXML `.docx`）
- **前端与动效**：React 18 · TypeScript 5.6 · Vite 5 · Tailwind CSS 3 · HeroUI 2.8 · [`motion/react`](https://motion.dev/)

---

## 下载安装

前往本仓库 [**Releases**](https://github.com/weiweidounai0131/AI-newmedia-workbench/releases) 页面获取双平台安装包：

- **macOS (Apple Silicon)**：`AI新媒体工作台_2.0.0_aarch64.dmg`
- **Windows (x64)**：`AI新媒体工作台_2.0.0_x64-setup.exe`

> macOS 首次打开若遇到“未验证开发者”提示，可在终端执行一次 `xattr -cr /Applications/AI新媒体工作台.app` 后正常打开。
> 如需在洗稿模块识别抖音视频，建议本机安装 [FFmpeg](https://ffmpeg.org/)（macOS 可通过 `brew install ffmpeg` 安装）。

---

## 本地开发与构建

前置环境：Node.js 22+、Rust stable、对应平台 Tauri 2 系统构建依赖。

```sh
# 安装前端依赖
npm install --legacy-peer-deps

# 类型检查
npm run typecheck

# 启动桌面端热更新开发模式
npm run tauri:dev

# 运行 Rust 单元测试
cd src-tauri && cargo test

# 构建当前平台正式安装包
npm run tauri:build
```

---

## 合规提示

本工具的平台登录态与搜索抓取能力仅限个人学习与内部运营研究自用，内置冷却保护与风控提示，请严格遵守各内容平台的服务协议，勿用于高频采集或商业转售。
