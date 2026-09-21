# AI-newmedia-workbench 体积优化修改日志

日期：2026-09-21  
分支：`optimize/m1-package-slimming`  
基线：`main@ea69417138ea0d6e4b8e527e9365f65dd439f3b3`

## 1. 优化目标

本轮不更换 Electron、不调整 UI、不改变前端 API 契约，优先解决两个问题：

1. Electron 安装包把构建素材、开源项目文档/测试/无关前端一起复制进最终 App。
2. 首次使用抓取功能时安装两套独立 Python venv，并为完整开源项目安装大量工作台实际上不使用的依赖。

## 2. 基线观察

历史 Release 中：
- Windows setup.exe 约 101 MB。
- Windows MSI 约 110 MB。
- macOS DMG 约 133 MB。
- macOS ZIP 约 127 MB。

原首次安装逻辑会创建：
- MediaCrawler Python 3.13 venv。
- wechat-mp-tools Python 3.12 venv。
- 两边重复安装 Playwright / HTTP / 加密等依赖。
- 无系统 Chrome / Edge 时另外下载 Playwright Chromium。

因此“安装后磁盘占用”比 Electron 安装包本身更值得优先优化。

## 3. 已完成修改

### M1.1 Electron Builder 资源白名单

`electron-builder.yml` 不再把整个 `resources/**` 复制进 App。

保留：
- `bootstrap/**`
- `licenses/**`
- `THIRD_PARTY_NOTICES.md`
- CI 动态生成的 `update-source.json`

同时排除：
- MediaCrawler 的 docs / tests / webui / tieba test_data。
- wechat-mp-tools 的 frontend / docs / GitHub 配置 / subtitle_remover。
- iconset、重复 icns/ico、构建阶段 app-icon 等不再通过 extraResources 二次复制。

按仓库文件大小计算，本轮明确不再进入 App 的未压缩资源约：
- 构建专用图标/素材：5.91 MB
- MediaCrawler 文档/测试：1.57 MB
- wechat-mp-tools 前端/字幕等：1.96 MB
- 合计约 9.44 MB

注意：最终 DMG/ZIP/EXE 是压缩产物，安装包实际下降值会小于 9.44 MB，应以本机打包结果为准。

### M1.2 修复 MediaCrawler upstream 重复复制

旧逻辑会：
1. 把整个 `bootstrap/media-crawler` 复制到 `runtime/media-crawler/proxy`；
2. 该目录本身已包含 `upstream/`；
3. 随后再把 `upstream/` 单独复制到 `runtime/media-crawler/upstream`。

现在第一步后立即移除 `proxy/upstream`，运行环境只保留一份 upstream。

### M2.1 wechat-mp-tools Lite

新增：
- `resources/bootstrap/wechat-mp-tools/workbench_app.py`
- `resources/bootstrap/wechat-mp-tools/requirements.workbench.txt`

工作台专用 Flask 服务只注册当前 Electron 实际调用的：
- `/api/settings`
- `/api/douyin/*`
- `/api/xhs/*`

不再启动原完整 app.py 中的：
- 微信公众号
- Bilibili
- 快手
- Channels
- RSS
- 转码
- 字幕去除
- updater
- 桌面 GUI / Web 前端

因此工作台 requirements 不再主动安装：
- mitmproxy
- pywebview
- pythonnet / clr_loader
- pyobjc
- scrapling
- 原 wechat 工具独立 Playwright 环境

Playwright 由共享 Runtime 提供。

### M2.2 MediaCrawler Lite

新增：
- `resources/bootstrap/media-crawler/upstream/workbench_main.py`
- `resources/bootstrap/media-crawler/upstream/requirements.workbench.txt`

Lite 入口只加载：
- 小红书
- 抖音
- search / detail
- json / jsonl / csv 文件存储

不再由入口加载：
- Bilibili / 快手 / 微博 / 贴吧 / 知乎 crawler
- 数据库初始化
- Excel store
- Mongo/MySQL/Postgres/SQLite store
- 词云生成

抖音、小红书 store 已改为工作台专用文件 store，避免仅为了 JSON 输出在 import 阶段加载 SQLAlchemy/MongoDB/Excel。

`AsyncFileWriter` 的词云模块改为真正按需 import。

`var.py` 去掉仅用于类型标注的 `aiomysql` 强制 import。

从工作台运行 requirements 中移除的主要非必要依赖包括：
- pandas
- matplotlib
- wordcloud
- jieba
- SQLAlchemy
- alembic
- aiomysql
- asyncmy
- redis
- motor
- openpyxl
- pytest / pytest-asyncio

为了保持抖音滑块验证码兼容，本轮仍保留 OpenCV；这一项没有为了体积数字强行删除。

### M2.3 两套 Python venv 合并为一套

旧结构：

```
runtime/
  media-crawler/venv    # Python 3.13
  wechat-mp-tools/venv  # Python 3.12
```

新结构：

```
runtime/
  python/               # Python 3.12，共享
  media-crawler/
  wechat-mp-tools/
```

首次安装现在一次性把以下三份 requirements 安装到共享 venv：
- media-crawler proxy requirements
- MediaCrawler requirements.workbench
- wechat-mp-tools requirements.workbench

共享环境成功安装后，会删除旧版：
- `runtime/media-crawler/venv`
- `runtime/wechat-mp-tools/venv`

### M2.4 系统浏览器策略继续保留

优先复用：
- Google Chrome
- Microsoft Edge

只有本机没有兼容浏览器时，才下载 Playwright Chromium。

这一策略没有回退。

## 4. 兼容性处理

- MediaCrawler Node 服务优先调用 `workbench_main.py`，不存在时仍回退旧 `main.py`。
- Python 可执行文件优先使用新共享 `runtime/python`，旧版 MediaCrawler venv 保留兼容回退路径。
- wechat-mp-tools 优先启动 `workbench_app.py`，开发态或旧环境仍可回退 `app.py`。
- 前端 API 路径没有修改。
- Electron UI 没有修改。
- 自动更新的 `update-source.json` 仍保留在打包白名单。

## 5. 新增本地检查

新增：

```bash
npm run verify:slim
```

它会静态检查：
- Lite 入口是否存在。
- 是否使用共享 Python venv。
- Runtime 是否引用 requirements.workbench。
- 是否仍误装完整上游 requirements。
- 重量级非必要依赖是否重新进入 Lite requirements。
- electron-builder 排除规则是否存在。

## 6. 建议本机验证顺序

在干净 checkout 上执行：

```bash
npm install --legacy-peer-deps
npm run verify:slim
npm run typecheck
npm run build
```

macOS：

```bash
npm run dist:mac
```

Windows：

```powershell
npm run dist:win
```

验证安装后的功能：

1. 工作台可正常启动，设置页/素材库/AI 页面不受 Runtime 安装影响。
2. 首次运行环境检查可正常安装共享 Python Runtime。
3. 有 Chrome / Edge 的机器不应下载独立 Chromium。
4. 抖音登录、主动搜索正常。
5. 小红书登录、主动搜索正常。
6. 抖音链接下载正常。
7. 小红书图文下载正常。
8. 链接模式 detail 能生成原有 JSON 输出并被 Electron 读取。
9. 关闭/重启应用后登录态和下载目录仍正常。
10. 自动更新配置仍能读取 update-source.json。

## 7. 需要记录的实测数据

请在本机测试时记录：

- 新 Windows setup.exe / MSI 或 macOS DMG / ZIP 大小。
- 安装后 App 本体大小。
- 首次 Runtime 安装前后 userData/runtime 大小。
- 是否复用了 Chrome / Edge。
- 抖音、小红书各完成一次：登录、搜索、下载/解析。

本轮不预先承诺 Runtime 能减少多少 MB；Python wheel、平台架构及浏览器是否复用都会影响结果，以本机实际目录大小为准。

## 8. 当前分支状态

本分支从 main 创建，修改范围集中在打包配置、Runtime 安装、两个开源组件的工作台专用入口与文件存储；未合并 main，便于本机验证后决定是否合入。
