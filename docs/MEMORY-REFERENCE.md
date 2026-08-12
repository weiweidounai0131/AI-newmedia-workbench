# 交接记忆摘要

本文件是为后续开发者准备的项目级记忆索引，不包含个人账号、API Key、Cookie 或浏览器资料。

## 历史开发结论

- 统一主仓库为 `/Users/jiangjiawei/Projects/newmedia-workbench`；不要在旧的 handoff 副本中继续修改。
- UI 使用 HeroUI，产品名称固定为“AI新媒体工作台”。
- 选题热榜每个平台最多展示 20 条；主动搜索仅支持抖音、小红书，且应保留平台冷却、任务状态和风控提示。
- 洗稿遵循“解析来源 → AI 识别稿件 → 人工确认内容 → AI 改写”，不得绕过人工确认。
- 抖音视频采用本地下载、FFmpeg 抽帧与视觉模型识别；小红书只处理文案和图片，不下载或识别小红书视频。
- 平台登录态只通过既有 Cookie 同步路径共享，不共享浏览器 Profile；禁止把 Cookie、浏览器目录、运行数据加入交接包或仓库。
- 打包运行时必须使用统一的 Playwright Chromium 路径；目录存在不代表浏览器可运行，应验证实际 executable path。
- 更新发布需区分 macOS 与 Windows。当前 macOS 采用对象存储通用更新源，标签 `mac-vX.Y.Z` 会触发 macOS-only 工作流。

## 本次交接时的状态

- 源码版本为 `0.1.12`。
- 用户已手动安装 `0.1.11`，等待测试其自动升级到 `0.1.12`。
- `0.1.11` 修复了此前自动更新脚本使用错误 macOS 命令路径的问题；如自动更新仍异常，首先检查：
  `~/Library/Caches/newmedia-workbench-updater/apply-update.log`。

完整当前状态请优先阅读 `docs/HANDOFF-2026-08-12.md`；产品需求阅读 `docs/prd/PRD-001.md`。
