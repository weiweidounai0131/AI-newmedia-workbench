# AI新媒体工作台（Rust + Tauri 2 原生重构版）

面向 macOS（Apple Silicon / Intel）与 Windows（x64）双平台的新媒体内容生产桌面工作台。彻底移除 Electron、Express、Python 虚拟环境、Playwright 与外部第三方工具窗口（`MediaCrawler` / `wechat-mp-tools` / `iframe`），全部核心能力以 Rust 原生实现并统一进工作台 UI。

## 架构亮点

- **极致轻量（瘦身 98%+）**：Tauri 2 系统原生 WebView + Rust LTO 裁剪二进制，零 Python 运行时下载。
- **Rust 原生核心后端**（`src-tauri/src/core/`）：
  - 四能力独立 AI 模型配置（文字改写 / 图片识别 / 视频识别 / 图片生成），支持 `OpenAI Chat Completions`、`OpenAI Responses`、`Anthropic Messages` 与 `OpenAI Images`。
  - 系统级安全存储（macOS Keychain / Windows Credential Manager + AES-256-GCM 降级路径），明文 Key 永不回传前端。
  - 纯 Rust 磁盘事实源素材库、OOXML `.docx` 生成与内存解析（跨平台零外部命令）、`rust_xlsxwriter` `.xlsx` 导出。
  - 抖音 + 小红书整点实时热榜缓存（`60s.viki.moe`）。
- **Rust 原生 CDP 浏览器引擎**（`src-tauri/src/cdp/`）：
  - 自动探测复用本机 Chrome / Edge，按平台隔离独立 `--user-data-dir`，应用退出自动回收本次创建的浏览器进程。
  - 扫码登录 + DOM 探针与关键 Cookie 双重防误判 + 搜索 API 响应 JSON 旁听 + DOM 兜底。
- **Rust 原生无水印下载器**（`src-tauri/src/downloader/`）：
  - 抖音纯 Rust `a_bogus`（RC4 + 国密 SM3）签名 + 无水印视频流式下载。
  - 小红书共享 CDP 真实登录态提取 `window.__INITIAL_STATE__` + 无水印图文并发下载与 `文案.txt` 落盘。
  - 彻底移除 `iframe`，通过 Tauri 事件驱动 `SpringProgress` 原生进度卡片。
- **旧版 Electron 无损迁移工具**（`src-tauri/src/core/migrate.rs`）：
  - 支持只读扫描旧版 `newmedia-workbench` 数据目录，自动解密重存 macOS OSCrypt `v10` / Windows DPAPI / 旧版 AES-256-GCM API Key，并提供二次确认后的旧版 Python `runtime/`（~876 MB）可选释放。
- **Motion 动效体系**（`src/motion/`）：
  - 基于 `motion/react`（`https://motion.dev/`）+ `LazyMotion` + `MotionConfig reducedMotion="user"`，提供侧栏与 Tab 物理弹簧滑块、视图平滑切换、列表轻交错与弹性进度条。

## 本地开发与构建

```sh
npm install --legacy-peer-deps
npm run typecheck
npm run tauri:dev
```

运行 Rust 核心单元测试：

```sh
cd src-tauri && cargo test
```

构建正式安装包：

```sh
npm run tauri:build
```

## 双平台 CI 与自动更新接入

- 双平台自动编译检查工作流位于 `.github/workflows/ci-build.yml`（`macos-latest` arm64 + `windows-latest` x64）。
- 后续对接现有 Cloudflare R2 与阿里云 OSS 自动更新源时，可在 `tauri.conf.json` 启用 `tauri-plugin-updater` 并配置独立路径的 `latest.json`（与旧版 Electron 的 `latest-mac.yml` 隔离，互不冲突）。
