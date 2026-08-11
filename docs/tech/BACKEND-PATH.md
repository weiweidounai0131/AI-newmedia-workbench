# 后端实现路径核对 · 新媒体工作台

> **定位**：本文件是「新媒体工作台」从 PRD 走向工程实现的**技术路径单一事实源**。
> PRD（`docs/prd/PRD-001.md`）回答「做什么」，本文件回答「怎么实现、用什么、有什么坑」。
> **写法**：按功能模块逐个核对，一轮定一个模块，定案即写入，不回头推翻（如需变更，走「决策变更」条目留痕）。
> 创建时间：2026-08-05　|　配套：`WORKFLOW-MAP.md`（工作流逻辑）、`docs/prd/PRD-001.md`（需求 V1.1）

---

## 核对进度

| # | 模块 | 对应 PRD | 状态 | 定案日期 |
|---|---|---|---|---|
| 0 | 全局技术栈与工程结构 | 1.5 NFR | ✅ 已定案 | 2026-08-05 |
| 1 | **选题**（热点 + 抓取 + 选题表） | US-1A / US-1B / US-1C | ✅ 已定案 | 2026-08-05 |
| 2 | 洗稿（两段式：识别 + 改写） | US-2A / US-2B | ✅ 已定案 | 2026-08-05 |
| 3 | 提示词生成 | US-3 | ✅ 已定案 | 2026-08-05 |
| 4 | 出图（固定 GPT 图像模型） | US-4 | ✅ 已定案 | 2026-08-05 |
| 5 | 素材库落库与导出 | US-5 / US-02 | ✅ 已定案 | 2026-08-05 |
| 6 | 设置、Key 加密、AI 代理层 | US-01 / US-03 | ✅ 已定案 | 2026-08-06 |
| 7 | 打包、签名、CI 双平台产出 | 1.5 NFR | ✅ 已定案 | 2026-08-06 |

---

## 0. 全局技术栈（已定案）

| 层 | 选型 | 说明 |
|---|---|---|
| 前端 | **React 18 + Vite + TypeScript + Tailwind CSS + HeroUI**（`@heroui/react` + `HeroUIProvider` + framer-motion） | 原型阶段的纯 CSS 视觉稿直接替换为 HeroUI 组件，不再手写样式 |
| 后端 | **Node / Express**，跑在 Electron 主进程内 | 不起独立服务进程，前端经 `http://127.0.0.1:<port>` 调用 |
| 存储 | **SQLite**（better-sqlite3）+ 文件目录（图片/docx 二进制） | 素材库元数据入库，大文件走 userData 目录 |
| 抓取 | **Electron BrowserWindow + 持久化 session**（详见 §1.2） | 不引入 Python / 不额外打包 Chromium |
| 封装 | **electron-vite + electron-builder** | Mac 出 `.dmg`，Windows 出 `.exe` / `.msi` |
| CI | **GitHub Actions** 双 runner（`macos-latest` + `windows-latest`） | 解决「Mac 本机打不出带安装器的 exe」 |
| AI | OpenAI 文本 + 图像接口，Key 本地加密，全部调用经后端代理 | 前端永不持有 Key |

### 工程结构（建议）

```
newmedia-workbench/
├─ electron/
│  ├─ main/            # 主进程：窗口、生命周期、后端启动
│  │  ├─ index.ts
│  │  ├─ server/       # Express（后端全部逻辑）
│  │  │  ├─ routes/    # hot / crawl / ai / library / settings
│  │  │  ├─ services/  # hotAggregator, crawler, openaiProxy, libraryStore
│  │  │  └─ db/        # SQLite schema + migration
│  │  └─ crawler/      # 抓取：BrowserWindow 池 + 各平台适配器
│  └─ preload/
├─ src/                # React + HeroUI 前端
│  ├─ views/           # 首页 / 选题 / 洗稿 / 提示词 / 出图 / 素材库 / 设置
│  ├─ store/           # 跨视图状态（对应原型的 STATE 总线）
│  └─ api/             # 前端 → 本地后端的调用封装
├─ prototype/index.html  # 视觉与交互基线（保留，作还原对照）
└─ .github/workflows/build.yml
```

> 原型里的 `STATE` 总线（切换模块不丢内容）对应到 `src/store/`，`LIB` 对应到后端 `libraryStore` + SQLite，逻辑一一映射，不重新设计。

---

## 1. 模块①　选题（已定案）

选题有两条独立入口，最终汇入同一张选题表：

```
1A 热点聚合 ──┐
              ├──→ 选题表（topic_table）──→ 洗稿模块承接
1B 关键词抓取 ┘
```

### 1.1　1A 热点聚合 —— 直接用开源，无悬念

**选型：`imsyy/DailyHotApi`**（配套前端 `imsyy/DailyHot`）

| 项 | 结论 |
|---|---|
| 项目现状 | 活跃维护，支持 60+ 平台，提供 Docker 镜像 `imsyy/dailyhot-api` |
| 语言 | **Node / TypeScript** —— 与本项目同栈，可直接内嵌，无额外运行时 |
| License | MIT 系，商用无障碍 |
| 备选 | `Jasper970311/rebang`、`csswee/TrendRadar` |

**接入方式（三选一，推荐「内嵌」）**

| 方式 | 做法 | 适用 |
|---|---|---|
| **内嵌（推荐）** | 将其 routes 作为依赖引入本项目 Express | 单机 app，零外部依赖，离线可控 |
| Docker 独立服务 | 起容器，调 `http://localhost:6688/<platform>` | 未来有内网服务器时 |
| 公共实例 | 直接调作者 demo 站 | 仅 demo，生产不可用 |

**需自行补齐的三件事**（开源项目不管的部分）

1. **本地缓存**：同一平台 10 分钟内不重复拉取，写入 `hot_cache` 表，避免被上游限流。
2. **平台名映射**：开源项目的 key（`douyin` / `weibo` / …）映射为 PRD 里的中文平台名，统一由后端出参。
3. **单平台失败降级**：某平台接口挂了返回空数组 + `partial: true` 标记，绝不让整个请求 500——首页四宫格必须有几个显示几个。

**对应 PRD 界面**

```
GET /api/hot?platforms=douyin,xhs,weibo,bilibili&limit=3
  → 首页「当日热点」2×2 四平台 TOP3（PRD 1.2）
GET /api/hot?platform=douyin&limit=50
  → 选题页「热榜」标签页完整榜单（US-1A）
```

---

### 1.2　1B 关键词抓取 —— 用开源的**成果**，不用它的**代码**

这是本轮最关键的决策变更。

#### 原方案的三个问题

原 PRD / WORKFLOW-MAP 记录的方案是直接集成 `NanmiCoder/MediaCrawler`。项目本身没问题（活跃、覆盖抖音/小红书/快手/B站/微博/贴吧/知乎、支持关键词搜索），但**塞进 Electron 客户端**有三个坑：

| 坑 | 说明 |
|---|---|
| **技术栈错配** | 它是 Python + Playwright。集成 = 打包 Python 运行时 + 独立 Chromium 内核，安装包粗估 **+230MB**（Electron 壳 ~150MB → 总计 400MB 起）；且 Mac 本机打不出 Windows 的 PyInstaller 产物，CI 复杂度翻倍 |
| **License 商用限制** | 其协议为自定义的「非商业学习授权」，**明确限制商业用途**。本项目是电信内部生产工具，直接打包其代码存在合规风险。⚠️ **此条需在集成决策前实际拉取其 LICENSE 文件复核** |
| **爬虫天然易腐** | 平台改一次接口/签名，爬虫就要跟一次版本。打包进 app 的版本三个月后可能失效，而终端用户无法自行 `git pull` |

#### 定案方案：Electron 原生抓取

**核心洞察：选择 Electron 等于白送了一个带持久化登录态的 Chromium** —— 而这恰恰是 MediaCrawler 绕一大圈用 Playwright 所追求的能力。

```
BrowserWindow（隐藏窗口，session: 'persist:<platform>'）
   ↓ 首次调用：显示窗口 → 用户扫码登录 → cookie 由 Electron session 自动持久化
   ↓ 后续调用：窗口隐藏运行
   ↓ webContents.executeJavaScript() 在页面上下文内直接调平台自身接口
   ↓ 【关键】请求签名（如小红书 x-s / x-t）由页面自己的 JS 现算，无需逆向、无需跟版本
   ↓ 解析字段 → 写入 crawl_item → 前端表格
```

**方案对比**

| 维度 | MediaCrawler sidecar | **Electron 原生（定案）** |
|---|---|---|
| 安装包增量 | +230MB | **0** |
| 跨平台构建 | Mac 打不了 Win，强依赖 CI | 与 app 同构建，无差异 |
| 登录态管理 | 自建一套 | Electron session 天然持久 |
| 请求签名 | 需跟平台版本 | **页面自算，不用管** |
| 平台覆盖 | 7 个开箱即用 | 需逐个实现 |
| License | 有商用疑虑 | 自有代码 |

**代价与应对**：平台要一个个啃。但 MediaCrawler 的研究成果没有浪费——**其公开的接口路径、参数结构、字段含义是最耗时的部分，读源码当技术文档，用 Node 重写调用逻辑**。

> ⚖️ **界限说明**：接口地址与数据结构本身不构成著作权客体，具体代码实现受保护。本方案只参考前者、不复制后者，规避 License 风险。

**实施范围（v1）**

| 平台 | v1 状态 | 说明 |
|---|---|---|
| 小红书 | ✅ 原生实现 | 主要采集源 |
| 抖音 | ✅ 原生实现 | 主要采集源 |
| 其余平台 | 降级 | 走「手动粘贴链接 → 单篇解析」通道（对应 PRD T4 兜底设计） |

**抓取适配器接口（预留扩展）**

```ts
interface PlatformAdapter {
  id: 'xhs' | 'douyin';
  ensureLogin(): Promise<boolean>;        // 未登录则拉起可见窗口扫码
  search(kw: string, opt: SearchOpt): Promise<CrawlItem[]>;
  parseUrl(url: string): Promise<CrawlItem>;  // 降级通道
}
```

新增平台只实现该接口，路由层与前端零改动。

**限频与合规（硬约束，写进代码而非文档）**

- 请求间隔 **≥ 3s + 随机抖动**，单次任务上限 50 条。
- **只抓公开内容**，不采集用户隐私字段（手机号、私信、地理位置精确值等）。
- 不做规模化存储与转卖，仅本机自用。
- 登录态加密存于本地，随时可在设置页一键清除。

---

### 1.3　选题表落库（US-1C）

两条入口汇入同一张表，生命周期规则全部落在这张表上：

```sql
CREATE TABLE topic_table (
  id          INTEGER PRIMARY KEY,
  biz_date    TEXT NOT NULL,          -- 业务日期 YYYY-MM-DD，重置/覆盖的判定依据
  source      TEXT NOT NULL,          -- 'hot' | 'crawl' | 'manual'
  platform    TEXT,
  title       TEXT NOT NULL,
  url         TEXT,
  metrics     TEXT,                   -- JSON：点赞/评论/收藏等
  adopted     INTEGER DEFAULT 0,      -- 是否「采用」
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_topic_date ON topic_table(biz_date);
```

| US-1C 规则 | 实现 |
|---|---|
| 同日导出覆盖 | 导出素材库时按 `biz_date` 命名，同名文件先删后插（与原型 `LIB` 行为一致） |
| 清空 | `DELETE FROM topic_table WHERE biz_date = ?` |
| 每日 0 点重置 | 应用启动 + 定时器双保险：当前日期 ≠ 表内最新 `biz_date` 时视为新一天，旧数据保留但不展示 |
| 往期导入 | 按 `biz_date` 查历史并 append 到当日表 |

---

### 1.4　API 契约（选题模块）

```
GET  /api/hot                  查询参数 platforms / limit，返回聚合热榜（带 partial 标记）
POST /api/crawl/search         { platform, keyword, limit } → { taskId }（异步）
GET  /api/crawl/status/:taskId → { state, progress, items[] }（前端进度条轮询）
POST /api/crawl/url            { url } → CrawlItem（降级通道）
GET  /api/platform/auth        { platform } → 拉起登录窗口，返回登录态
DEL  /api/platform/auth        { platform } → 清除登录态
GET  /api/topics               当日选题表
POST /api/topics               新增/采用
DEL  /api/topics               清空当日
POST /api/topics/import        { bizDate } 往期导入
```

表结构：`hot_cache` / `crawl_task` / `crawl_item` / `topic_table` / `platform_auth`。

---

### 1.5　风险登记

| ID | 风险 | 缓解 |
|---|---|---|
| T4 | 抓取违反平台 ToS，有封号/IP 风险 | 限频 + 仅自用 + 未登录时自动降级为手动贴链接；设置页明示风险提示 |
| T4-a | 平台改版导致抓取失效 | 适配器隔离，单平台失效不影响其他；失败自动提示走降级通道 |
| T7（新） | MediaCrawler License 商用限制 | 已通过「不复制代码、仅参考接口研究」规避；**仍需实际复核其 LICENSE 原文留档** |
| T8（新） | 隐藏窗口抓取被识别为自动化 | 复用真实登录态 + 真实页面上下文调接口，特征远低于 headless；必要时加 UA / 行为随机化 |

---

## 2. 模块②　洗稿（已定案）

### 2.1　设计前提：三 API 分层（已确认）

> 由用户 2026-08-05 拍板：API 不固化为单一 GPT，按**能力**分层，每层供应商可插拔。

| 能力槽位 | 职责 | 默认供应商 | 备选 |
|---|---|---|---|
| **vision**（多模态识别） | 从素材里读出文本与画面信息 | **小红书图文 → 智谱 GLM-4V-Flash**；**抖音视频 → 通义 Qwen-VL-Max** | DeepSeek V4 识图（已灰度上线，待稳定） |
| **text**（文字改写） | 洗稿、重写、提示词写作 | **DeepSeek-V4-Flash** | 任何 OpenAI 兼容 Chat Completion |
| **image**（出图） | 文生图、海报/四宫格 | **OpenAI Images（gpt-image-1，经 AIHubMix 中转）** | — |

**为什么按能力而不是按厂商抽象**：国产模型 API 半年内翻过两次定价（DeepSeek 0.025 元/百万 tok 缓存命中、智谱 GLM-Flash 免费），DeepSeek V4 已灰度识图且未来某天会颠覆 vision 槽位的成本结构。「能力 → 供应商」的映射放设置页，下次哪家更便宜只需改配置不改代码。

**为什么不固化 GPT 用于洗稿**：DeepSeek-V4-Flash 输出价 ~2 元/百万 tok，同档 OpenAI 输入价 $5/输出价 $15，**文本侧成本降一个数量级**。OCR/摘要/改写这类纯文字工作，国产已完全够用，没必要为它花 OpenAI 的钱。

### 2.2　两条流 + 一道人工确认门（已确认）

```
流A（链接模式）
  ① 获取链接 ── 复用选题模块的 Electron 原生抓取适配器（小红书 / 抖音）
  ② 多模态识别 ── 按素材类型路由：视频→Qwen-VL-Max / 图文→GLM-4V-Flash
  ③ 【人工确认门】用户编辑识别稿件 → 确认
  ④ DeepSeek 改写 → 洗稿文案 ─┐
                                 ├── 合并到流 B
流B（贴稿模式）                  │
  DeepSeek 改写 → 洗稿文案 ─────┘
```

**新增的人审门是关键设计**：VL 识别可能看岔（视频尤其），错误直接串到改写会被放大成一整篇错稿且用户无法定位是哪一步出的错。在中间加可编辑确认门后：
- 错误可见、可就地修正（不必重跑整条链）
- 与原型其他三个 AI 模块的「人审-修订闭环」行为一致
- **流 A = 素材还原 + 流 B**，后半段代码完全复用

前端示意已在原型落地（2026-08-05 改造完成，31/31 验证通过）：

```
┌─────────────────────────────────────────────────────────┐
│ ✓ 获取链接   ✓ 多模态 AI 识别   人工确认内容    4 DeepSeek 改写 │
├─────────────────────────┬───────────────────────────────┤
│ 稿件来源                │ 识别稿件 · 待你确认           │
│  [贴稿件][填链接]       │ ⚠ AI 识别可能有偏差，请核对后再改写 │
│  ...                    │ ┌─────────────────────────┐  │
│  [AI 识别内容]          │ │ [标题]...               │  │
│                         │ │ [正文]...               │  │
│                         │ └─────────────────────────┘  │
│                         │ [确认内容，开始改写] [重新识别] │
│                         ├───────────────────────────────┤
│                         │ 洗稿文案                       │
│                         │ ┌─────────────────────────┐  │
│                         │ │ 改写后的稿件...          │  │
│                         │ └─────────────────────────┘  │
│                         │ [不满意？... AI 优化]          │
└─────────────────────────┴───────────────────────────────┘
```

### 2.3　抓取复用与流 A 第一段

链接模式的第一段（① 抓取素材）**复用选题模块已定案的抓取适配器**（见 §1.2）：

```
flowA-①  POST /api/crawl/url { url } → CrawlItem { type: 'video' | 'image-set' | 'article', payload }
         ↓
flowA-②  按 payload.type 路由 VL：
         - video   → 通义 Qwen-VL-Max 直接吃视频（省抽帧+ASR）
         - image   → 智谱 GLM-4V-Flash（图组逐图喂入）
         - article → 智谱 GLM-4V-Flash（封面图+正文）
         → 结构化稿件 { title, body, keypoints, visualNotes }
```

**视频为何选 Qwen-VL-Max 而不是省钱的自抽帧+ASR**：自抽帧意味着往 Electron 里塞 ffmpeg 二进制 + 再接一路 ASR 模型（Paraformer/whisper），开发量与维护成本远高于它比 GLM-Flash 贵的那点钱。

### 2.4　人审门实现要点

```ts
// state.xigao.stage 状态机
type Stage = 'idle' | 'recognizing' | 'review' | 'done';

interface XigaoState {
  stage: Stage;
  recog: string;          // VL 产出的可编辑稿件（人工可在 review 态改）
  mediaType: 'video' | 'image';
  vlModel: string;        // 当前路由到的供应商，仅展示用
  out: string;            // DeepSeek 改写产物
  // ... src / link / mode / importTitle（与原 PRD 一致）
}

// 硬约束：review 态必须由用户点「确认内容」才推进；不允许后台自动跳过
const canRunXigao = (s: XigaoState, optimize=false) =>
  !s.stage || optimize || s.stage === 'review' || s.stage === 'done';
//   ↑ draft 模式无 stage 字段；optimize 不受 stage 限制
```

错误防护：VL 失败 → `stage` 不写入 `review`，前端显示原始错误文案，让用户决定重新识别还是降级为流 B。

### 2.5　API 契约（洗稿模块）

```
POST /api/xigao/recognize   { url, type } → { recog, mediaType, vlModel }
                            流 A ①+②，复用抓取适配器 → 路由 VL
POST /api/xigao/rewrite     { source, req, optimizeHint? } → { out, usage }
                            流 A 流 B 共用后半段，调 DeepSeek
```

### 2.6　提示词（动态 vs 静态）

- **改写提示词模板**（后半段，§2.2 流 A/B 共用）：参数化模板（占位 `{source}` `{req}` `{optimizeHint?}`）。其中 `{req}` 由**前端用户输入的「洗稿要求」动态填充**——不是写死在系统里的固定模板，所以**无需预先提供原文，T6 非阻塞**。模板本体（含占位符与输出格式约束）随工程实现收口，原型阶段用占位演示。
- **识别稿件结构化提示词**（流 A ②）：固定 schema 指令，让 VL 按统一结构输出（标题/正文/要点/画面）。属于系统层格式约束、非用户内容原文，亦**非阻塞项**；结构化失败时回到 §2.4 的人审门让用户修正，不影响链路推进。

### 2.7　成本量级（单篇洗稿）

| 步骤 | 模型 | 估量 | 单价 | 成本 |
|---|---|---|---|---|
| ① 抓取素材 | 自研 | — | — | ~0 |
| ② VL 识别（视频） | Qwen-VL-Max | 1 段 1 分钟视频 | 中档 | **几分钱** |
| ② VL 识别（图文） | GLM-4V-Flash | 数张图 | 免费 | **~0** |
| ③ 人审 | — | — | — | 0 |
| ④ DeepSeek 改写 | DS-V4-Flash | 1k–3k tok | ~¥0.02–0.06/篇 | **<1 分钱** |
| **小计** | | | | **几分钱/篇** |

> 文字侧成本可忽略。**真正的大头在出图**（§4 单独盘）。

### 2.8　风险登记（洗稿专属）

| ID | 风险 | 缓解 |
|---|---|---|
| T9 | VL 识别稿件错误（如把别人引言当本人话术） | 人工确认门 + 用户可编辑后再改写；`recog` 全量持久化便于追溯 |
| T10 | 双供应商配置文件变复杂 | 用「能力→供应商」单一映射表，UI 一目了然 |
| T11 | 流 A 抓取失败时不能动 | 后端返回结构化错误（`code: fetch_failed / verify_failed / vl_failed`），前端按 code 分别提示「重试抓取 / 重新识别 / 切换手动贴稿」 |

---

## 3. 模块③　提示词生成（已定案）

> 核心约束（用户 2026-08-05 明确）：**AI 一次只生成一段内容**，不分成两个接口调用。
> 「文字+图片」模式下，文案与图片提示词在**同一段输出**里，靠**分隔符**切开后落到两个框；
> 「图片」模式下只输出图片提示词，整段进图片框。

### 3.1　设计前提：DS API 出提示词（已确认）

- 提示词生成由 **DeepSeek 文本 API**（text 能力槽位，见 §2.1）一次性生成。
- 与原型一致：**不固化 GPT**。text 槽位默认 DeepSeek-V4-Flash，可在设置页切到任意 OpenAI 兼容供应商。
- 上游可承接洗稿产出（`openImportXigaoModal` 从洗稿表导入）或用户手动贴稿。

### 3.2　「一次生成 + 分隔符拆分」契约（已确认）

选「文字+图片」时，对 DeepSeek 的 system 提示词里写入固定分隔符指令：

```
请在「文字文案」与「图片提示词」之间，单独成行输出：
===[IMG_PROMPT]===
（该分隔符前后不得有其他文字 / 标点 / 空格）
```

> 分隔符选型理由：`===[IMG_PROMPT]===` 全大写英文 + 方括号 + 等号包围，中文文案几乎不可能自然出现该串，且单行、易按行正则匹配。

**解析三级容错**（原型 `parsePromptOutput(raw, type)`，实现已验证）：

| 优先级 | 命中条件 | 行为 | mode |
|---|---|---|---|
| ① 分隔符 | 正则 `^[ \t]*={2,}[ \t]*\[?[ \t]*IMG[ \t_\-]*PROMPT[ \t]*\]?[ \t]*={2,}[ \t]*$`（im） | 前半→文字框、后半→图片框，显示「分隔符已拆分」绿标 | `delim` |
| ② 语义标题兜底 | 无分隔符但有 `【图片提示词】` / `Image Prompt:` 等小标题 | 同①拆，但提示条转 `warn`，提示用户核对 | `fallback` |
| ③ 整段兜底 | 两者皆无 | 整段进文字框、图片框转空态提示，提示条转 `err` | `failed` |
| — 仅图片模式 | `type==='img'` | 整段当图片提示词，文字框整体隐藏 | `single` |

> 切回视图时由 `bindView('tishici')` 调 `renderParseNote()` 恢复绿标 / 提示条，STATE 全程保留（`outText`/`outImg`/`parseMode`），跨模块不丢。

### 3.3　API 契约（提示词模块）

```
POST /api/tishici/gen   { source, desc, type, refImg?, optimizeHint? }
                       → { outText, outImg, raw, parseMode }
  type='tp' : DeepSeek 单段生成 → 按分隔符拆 outText / outImg（三级容错）
  type='img': DeepSeek 单段生成 → 整段 outImg
POST /api/tishici/export { outText, outImg, type } → { libId }
                      写入素材库（见 §5），type 决定落「文案」夹 / 「图片提示词」夹
```

### 3.4　成本量级（单次提示词生成）

| 步骤 | 模型 | 估量 | 单价 | 成本 |
|---|---|---|---|---|
| 生成提示词（tp） | DS-V4-Flash | 1k–2k tok | ~¥0.02–0.04 | **<1 分钱** |
| 生成提示词（img） | DS-V4-Flash | 0.5k–1k tok | ~¥0.01–0.02 | **<半分钱** |

> 与洗稿同理，文字侧成本可忽略；完整海报成本大头仍在出图（§4）。

### 3.5　风险登记（提示词专属）

| ID | 风险 | 缓解 |
|---|---|---|
| T12 | DeepSeek 偶发不遵守分隔符约定 | 三级容错：分隔符→语义标题→整段兜底；`fallback`/`failed` 显式提示条 + 一键重新生成 |
| T13 | 拆分错位（文案里夹了图片描述） | 人审：提示词框可编辑，导出素材库前由用户确认；`raw` 全量留存便于追溯 |
| T14 | 仅图片模式误选成 tp 导致空图片框 | `type` 切换即重置输出并校验框显隐；`single` 模式文字框整体隐藏，从源头避免歧义 |

---

## 4. 模块④　出图（已定案）

> 出图方案已与用户对齐（参考 `https://video.aihubmix.com/image` 的 GPT 图像生成逻辑）：固定 **GPT 图像模型**（gpt-image-1 / AIHubMix 称 "GPT Image 2"），image 能力槽位、**用户不可选**；**每次固定输出 1 张**。参数为提示词（来自模块③）+ 参考图（可选）+ 尺寸 + 质量。中文乱码风控沿用既定"GPT 出视觉 + 思源黑体排版层叠字"兜底。**视频生成推迟**，不进 v1.1 核心（另一类模型，较重）。
>
> **调用通道（2026-08-06 补充）**：image 能力**经 AIHubMix 中转站**调用——中转站 OpenAI 兼容，`base_url = https://aihubmix.com/v1`，模型 `gpt-image-1`，设置页 image 槽位填的 **Key 即 AIHubMix Key**（非直连 OpenAI）。中转站本身 OpenAI 兼容，故仍走统一 `openai` SDK，仅 `base_url` + `Key` 不同（见 §6.1 / §6.8.1）。仅出图走中转，text / vision 仍走各原生供应商。

### 4.1　参数契约（对照参考站）

| 参数 | 取值 | 说明 |
|---|---|---|
| 模型 | `gpt-image-1`（GPT Image 2） | **固定，用户不可选**（image 槽位锁定，见 §6.1） |
| `prompt` | 来自模块③提示词 | 必填，文字 + 图片提示词拆分后取图片段 |
| `refImgs` | ≤ 14 张 | 可选参考图（参考站 `input_reference` 上限），原型以 base64 / 本地路径传参 |
| `size` | `1024×1024` / `1024×1536` / `1536×1024` | 多档可选，默认 `1024×1536`（竖版海报向） |
| `quality` | `auto` / `low` / `medium` / `high` | 默认 `auto` |
| `n` | **固定 1** | 每次只出 1 张，用户无需选数量 |

### 4.2　API 契约（出图模块）

```
// 前端 → 本地后端（aiProxy）
POST /api/chutu/gen   { prompt, refImgs?, size?, quality? }
                    → { images:[{ url | b64 }] }   固定 1 张
// 本地后端（aiProxy）→ AIHubMix 中转（OpenAI 兼容）
POST https://aihubmix.com/v1/images/generations
   { model:'gpt-image-1', prompt, n:1, size, quality }  → { data:[{ b64_json }] }
//   有参考图时改用 /v1/images/edits（image + text 编辑）
POST /api/lib/export { folder:'图片', name, payload:b64 }  // 落素材库（见 §5）
```

### 4.3　风险登记（出图专属）

| ID | 风险 | 缓解 |
|---|---|---|
| T5 | 中文乱码（GPT 类图像模型生成中文常乱码） | 原型用 Canvas 占位 + 思源黑体排版层叠字兜底；封装阶段接入真实层叠字方案（AI 出视觉背景 + 字体层叠），列为已知风险 T5，v1 先接受当前行为 |
| T5-a | 成本（出图单价最高） | gpt-image-1 经 AIHubMix：1024×1536 ≈ low $0.016 / high $0.25 每张；v1 每次 1 张、按需生成，成本可控；用量可在设置页统计 |
| T5-b | 内容审核（艺术家名 / 敏感内容触发 `moderation_blocked`） | 海报提示词用「风格」而非具名艺术家（如用 Ghibli / Pixar 而非具体画家名）；参考图压缩预处理提速；编辑端点不支持 `moderation` 参数 |
| T6-a | 参考图过多撑爆请求体 | 前端限制 ≤ 14 张 + 压缩；超限提示分批 |

---

## 5. 模块⑤　素材库落库与导出（已定案）

> 核心定位（用户 2026-08-05 确认）：素材库是**归档出口**——把各模块的成品按输出类型**导出到本地磁盘**，而不是再加工的中间件。**提示词不进素材库**（它只喂给模块④，框旁有复制即可）。

### 5.1　方案 C：本地直写为主 + 系统内只存索引

- **导出根目录**：用户首次（或首次点导出）用系统目录选择器（`dialog.showOpenDialog`）选定一个本地根目录（默认建议 `~/Documents/电信新媒体工作台/`），路径**加密存 settings 表**，后续复用。
- **导出动作**：后端 `exporter` 服务生成实体文件后，用 Node `fs` **直接写入** `根目录/选题/`、`根目录/洗稿/`、`根目录/图片/` 三个子文件夹，**不经过下载步骤**。
- **系统内索引**：SQLite 的 `files` 表**只存元数据**（localPath / folder / name / kind / size / createdAt / 缩略图 dataURL），不存文件体。素材库列表 = 查 `files` 表。
- **打开 / 定位**：点文件 → `shell.openPath(localPath)` 用系统默认 App 打开；点「在文件夹中显示」→ `shell.showItemInFolder(localPath)`。
- **同步盘红利**：若根目录放在 iCloud / OneDrive / 坚果云，导出即自动云备份 + 跨设备访问，**零额外运维**。
- **容错**：文件被外部移动/删除 → `fs.existsSync(localPath)` 失败 → 提示「本地文件丢失，可重新导出」。

### 5.2　三文件夹（去掉提示词）

| 文件夹 | 来源模块 | 落地格式 | 命名规则 |
|---|---|---|---|
| `选题` | ① 选题 | **Excel** `.xlsx` | `选题表YYYYMMDD.xlsx`（**同日覆盖**） |
| `洗稿` | ② 洗稿 | **Word** `.docx` | `洗稿+<标题>.docx`（导入选题表）或 `洗稿+<原稿件前四字>.docx`（直接贴稿），**同名覆盖** |
| `图片` | ④ 出图 | PNG | `<用户命名>.png`（含真实缩略图） |
| ~~`提示词`~~ | — | （已废弃） | 提示词仅在模块③内复制 / 直喂模块④，不落库 |

### 5.3　统一导出层（exceljs + docx 合并为一个 `exporter` 服务）

> 用户要求"统一这两个库"——Excel / Word 生成**统一收口到一个后端服务** `services/exporter.ts`（底层仍用两个成熟开源库，配置/调用一致）。

| 格式 | 开源库 | 协议 | 用途 | 体积 |
|---|---|---|---|---|
| **Excel** `.xlsx` | **[`exceljs`](https://github.com/exceljs/exceljs)** | **Apache 2.0**（商用 OK） | 选题表：样式 / 表头冻结 / 列宽 / 平台色标 | ~1 MB |
| **Word** `.docx` | **[`docx`](https://github.com/dolanmiu/docx)**（dolanmiu） | **MIT**（商用 OK） | 洗稿稿：标题 / 正文段落 / 表格（如含要点）/ 可选配图 | ~200 KB |

- 两者均**纯 JS / 纯 Node**，在 Electron 主进程跑，**不依赖 Python / LibreOffice / 任何外部进程**，打包体积几乎零增量。
- Excel 备选 SheetJS `xlsx`（同为 Apache 2.0）但社区版有"不得用于生产"警告，**不采用**。
- 导出服务对外统一签名：`exporter.export(folder, name, payload) → { localPath }`，内部按 kind 路由到 `buildXlsx()` / `buildDocx()` / `writePng()`，再 `fs.writeFile` + 写索引。

### 5.4　API 契约（素材库）

```
POST /api/lib/export   { folder, name, payload }  // payload: 选题数组 / 洗稿文本 / 图片 base64
                     → { localPath, size }
  导出服务按 folder 路由到 exceljs / docx / png，fs 直写根目录子文件夹，回写 files 索引
GET  /api/lib/list     → { files:[{localPath,folder,name,kind,date,size}] }   // 仅元数据
POST /api/lib/reveal   { localPath }              → shell.showItemInFolder（在文件夹中显示）
POST /api/lib/open     { localPath }              → shell.openPath（系统默认 App 打开）
```

### 5.5　成本量级

| 步骤 | 成本 |
|---|---|
| 生成文件（exceljs / docx / canvas png） | 本地 CPU，**~0** |
| 写盘 / 索引 | ~0 |
| 同步盘上传（若启用） | 由同步盘自身承担，不计 |

> 素材库导出是本地操作，无 API 调用成本。

### 5.6　风险登记（素材库）

| ID | 风险 | 缓解 |
|---|---|---|
| T15 | 根目录被删除 / 移动 / 未授权访问 | 启动时校验根目录存在且可写；不可写则提示重新选择；敏感文件走用户文档目录，不碰系统目录 |
| T16 | 同名覆盖误伤（选题同日覆盖 / 洗稿同名） | 覆盖前在 UI 提示「将覆盖同名文件」；洗稿命名双分支降低冲突；索引表记录 createdAt 便于追溯 |
| T17 | 文件被外部移动后索引失效 | 打开/显示前 `fs.existsSync` 校验，失败提示「本地文件丢失，可重新导出」 |
| T18 | 同步盘并发写冲突 | 写盘用原子写（临时文件 + rename）；同一文件串行写入 |

---

## 6. 模块⑥　设置、Key 加密、AI 代理层（已定案）

> 核心定位（用户 2026-08-06 确认）：设置页不只是一个「填 Key」的面板，而是 **AI 能力的统一配置入口 + 安全边界**——API 按能力分层、Key 本地加密、所有调用经后端代理、前端永不持有 Key。对应 PRD `US-01` / `US-03`，原型四面板已落地（AI 模型分层 / AI 代理层 / 素材库本地直写 / 抓取账号可选）。

### 6.1　三能力槽位配置（`CAP_SLOTS`）

`CAP_SLOTS` 是设置页的单一事实源——每个能力槽位对应一个供应商下拉 + Key 输入 + 保存 + 状态灯。image 槽位**锁定**（出图固定 GPT，用户不可改）。

| `cap` | 标签 | `key`（存储键） | 默认供应商 | 备选 | 锁定 |
|---|---|---|---|---|---|
| `text` | 文字改写 | `deepseek` | **DeepSeek-V4-Flash** | DeepSeek-Reasoner | — |
| `visionImg` | 图文识别 | `zhipu` | **智谱 GLM-4V-Flash** | 智谱 GLM-4V-Plus | — |
| `visionVideo` | 视频识别 | `qwen` | **通义 Qwen-VL-Max** | 通义 Qwen-VL-Plus | — |
| `image` | 出图 | `openai` | **GPT Image（gpt-image-1，经 AIHubMix 中转）** | — | **🔒 固定** |

- **不固化单一 GPT**：成本结构上国产文字模型便宜一个数量级，按能力分层后下次哪家更便宜只需在设置页切，代码零改动。
- **锁定image槽位**：出图方案已定（固定 gpt-image-1），不让用户切走，避免"选了非 GPT 模型却按 GPT 生图逻辑传参"的错配；下拉 `disabled` 不可选。
- **image 槽位走 AIHubMix 中转**：该槽位 `key` 填的是 **AIHubMix Key**（非直连 OpenAI）；`aiProxy` 对 image 能力用 `base_url=https://aihubmix.com/v1` 调 `images.generate`（有参考图时走 `/v1/images/edits`）。中转站 OpenAI 兼容，统一 `openai` SDK 不变（见 §6.8.1）。
- **状态灯**：每个槽位实时显示 `已配置 / 未配置`（依据 `SETTINGS.keys[key]` 是否非空），未配置则对应 AI 步骤触发时提示跳设置。

### 6.2　AI 代理层（前端不持有 Key）

```
前端 (React) ──http://127.0.0.1:<port>──▶ 后端代理 (Node/Express, 主进程)
                                            │ 读本地加密 Key
                                            ├─▶ DeepSeek / 智谱 / 通义（原生）
                                            ├─▶ OpenAI gpt-image-1（经 AIHubMix 中转：aihubmix.com/v1）
                                            └─ 失败重试 / 限频 / 超时统一处理
```

- **Key 只在主进程内存 + 本地加密文件**里，前端包（Electron 渲染进程）里**不存在任何供应商 Key**。
- **前端只持有一个「调本地后端的会话凭证」**（本地 loopback 调用，不暴露公网），后端凭证再转发各家 API。
- 好处：① 一键切供应商不影响前端；② Key 不进前端包，避免打包产物泄露；③ 限频/重试/错误码在后端统一收敛，前端按 `code` 分支提示。

### 6.3　Key 本地加密

| 环节 | 做法 |
|---|---|
| **落盘加密** | Key 用 Node `crypto` 派生密钥（优先 Electron `safeStorage`；降级用机器指纹派生的 AES-256-GCM）加密后写 `settings` 存储；**不落明文** |
| **内存** | 解密后的 Key 仅在后端请求生命周期内存在，不写日志、不进任何前端响应 |
| **格式校验** | 保存时校验非空 + 前缀：`deepseek` / `openai` 必须以 `sk-` 开头，否则禁止保存并提示 |
| **输入遮罩** | 前端 `<input type=password>`，配「显示/隐藏」眼睛按钮；Key 回显只在本地渲染进程 |
| **重置** | 设置页可单槽位重填；机器迁移/解密失败时引导用户重新配置 |

### 6.4　抓取账号（可选，复用 §1.2）

- 设置页「抖音 / 小红书 登录态」面板 → 点「扫码登录」拉起 **Electron 原生 BrowserWindow**（`session: 'persist:<platform>'`），登录态由 Electron session 自动持久化并加密。
- 未配置 → 1B 搜索退化为手动贴链接（见 §1.2 降级通道），后续流程不受影响。
- 设置页提供**一键清除登录态**；登录失效时提示重新登录。

### 6.5　设置页四面板（原型已落地，2026-08-06）

| # | 面板 | 内容 | 对应原型 |
|---|---|---|---|
| ① | **AI 模型（按能力分层）** | 4 个 `cap` 槽位（供应商下拉 + Key + 保存 + 状态灯），顶部 `cap-note` 说明"不固化厂商 + 经代理层" | `V_settings()` 第一面板 |
| ② | **AI 代理层** | 只读说明：调用经后端代理、Key 仅本地加密、前端不持有 | 第二面板 |
| ③ | **素材库（本地直写）** | 「导出根目录」选择（默认 `~/Documents/电信新媒体工作台/`）+ 三文件夹计数 + 打开素材库 | 第三面板（`pickRootDir()`） |
| ④ | **抓取账号（可选）** | 抖音/小红书 登录态、扫码登录、一键清除 | 第四面板 |

### 6.6　API 契约（设置模块）

```
GET  /api/settings            → { rootDir, suppliers, caps:[{cap,configured}] }   // 不含明文 Key
POST /api/settings/supplier   { cap, supplier }           切换某能力槽位供应商
POST /api/settings/key        { cap, key }                 加密存 Key（后端校验 sk- 前缀）
POST /api/settings/rootdir    { rootDir }                  导出根目录（加密存，见 §5.1）
POST /api/platform/auth       { platform }                抓取登录（见 §1.2）
DEL  /api/platform/auth       { platform }                清除登录态
```

> 明文 Key **绝不**出现在任何 `GET /api/settings` 响应体里——前端只读 `configured` 布尔与供应商选择。

### 6.7　风险登记（设置专属）

| ID | 风险 | 缓解 |
|---|---|---|
| T19 | Key 明文泄露（设置文件 / 内存 / 日志） | 加密落盘（`safeStorage`/AES-GCM）+ 不写日志 + 前端包无 Key；迁移场景引导重配 |
| T20 | 代理层单点故障（后端进程崩 → 所有 AI 步不可用） | 后端代理加健康探针 + 失败重试 + 前端降级提示「服务不可用，请重启应用」；后端崩溃自动拉起 |
| T21 | 加密密钥管理（机器绑定密钥丢失 → 旧 Key 无法解密） | 解密失败时引导用户重新填 Key（不阻塞应用启动）；根目录等可重置项独立校验 |

### 6.8　调用实现策略（架构级决策；机械接线留待封装阶段）

> 本节只钉**架构级**两点。各家**具体请求体 / 返回格式 / 兼容坑**，开发到对应功能时**查阅官方 SDK 文档现场接线**，不预先抄入本文档（易过时且无收益，属体力活而非设计）。

#### 6.8.1　SDK 选型：统一 `openai` SDK

- **决策（用户 2026-08-06 确认）**：后端**只依赖一个** `openai` npm 包，按能力槽位切换 `baseURL` + `apiKey` 调四家。DeepSeek / 智谱 / 通义 / OpenAI **全部 OpenAI 兼容**（已核实：DeepSeek `https://api.deepseek.com`、智谱 `https://open.bigmodel.cn/api/paas/v4/`、通义 `https://dashscope.aliyuncs.com/compatible-mode/v1`、OpenAI 默认）。
- **不引入各家原生 SDK**（`zhipuai` / `dashscope` 等）——除非某家在 OpenAI 兼容模式下出现无法绕过的坑，再**局部**换原生，不影响整体架构。
- **image 能力经 AIHubMix 中转站**：`base_url=https://aihubmix.com/v1`、Key 为 AIHubMix Key，调 `gpt-image-1` 的 `images.generate`（参考图走 `/v1/images/edits`）。中转站本身 OpenAI 兼容，故仍属「统一 `openai` SDK」范畴，仅 `base_url` + `Key` 不同。**仅出图走中转**，text / vision 仍走各原生供应商（用户 2026-08-06 决定）。
- **落点**：`electron/main/server/services/aiProxy.ts`，跑在主进程；前端经本地后端调用，**永不持有 Key**。

#### 6.8.2　输出模式：v1 一次性返回（非流式）

- **决策（用户 2026-08-06 确认）**：v1 所有 AI 步采用**请求 → 等待 → 一次性返回结果**，UI 用「加载中 / 骨架屏」过渡（原型 `fakeAI()` 即模拟此态）。
- **理由**：代理层与前端状态最简；国产 API 在 OpenAI 兼容模式下的流式偶有兼容差异，v1 先保跑通、降低不确定性。
- **未来增强**：若体验需要「逐字蹦」流式，可在 `aiProxy` 加 SSE / 流式转发，前端改增量渲染——属**增强项，非 v1 阻塞**。

#### 6.8.3　`aiProxy` 服务职责（封装阶段实现）

- 按 `CAP_SLOTS` 路由到对应 `baseURL` 的 `openai` 客户端。
- 按能力拼请求体：`text` / `visionImg` / `visionVideo` 走 `chat.completions`（VL 在 `content` 里塞 `image_url` / `video` part）；`image` 走 `images.generate({ model:'gpt-image-1' })`。
- 统一职责：Key 从加密存储取（不落前端）、失败重试、限频、错误码归一（`code` 供前端分支提示）。
- **不在本文档预写各家请求体细节**——实现时对照官方文档。

---

## 7. 模块⑦　打包、签名、CI 双平台产出（已定案）

> 核心约束（见 §0 / PRD 1.5 NFR）：开发在 **Mac**，但同事用 **Windows** 也要能装——Mac 本机打不出带安装器的 exe，故 **Windows 包经 GitHub Actions 的 windows runner 产出**。Mac 包本机或 mac runner 均可。

### 7.1　工程形态：electron-vite

```
newmedia-workbench/
├─ electron/        # 主进程（Express 后端 + 抓取 + 封装）
├─ src/             # React + HeroUI 前端（Vite 构建）
├─ resources/       # 图标 / 安装背景图
├─ electron.vite.config.ts
├─ electron-builder.yml
└─ .github/workflows/build.yml
```

- `electron-vite` 统一编排「主进程(Vite) + 预加载 + 渲染进程(Vite)」三步构建，避免手动拼 webpack。
- 后端 Express 随主进程打包（`extraResources` 不额外起服务），前端产物进 `app.asar`。

### 7.2　electron-builder 双平台配置

| 平台 | target | 产物 | 签名 |
|---|---|---|---|
| **macOS** | `dmg` | `电信新媒体工作台-x.y.z.dmg`（含 `zip` 兜底） | **Apple 开发者证书 codesign + notarize**（公证，否则 Ventura+ 直接拦截） |
| **Windows** | `nsis`（`.exe` 安装器）/ `msi` | `电信新媒体工作台-x.y.z-setup.exe` + `.msi` | **Authenticode 代码签名（EV 或 OV 证书）**，否则 SmartScreen 报未知发布者 |

- 两套产物的构建参数放 `electron-builder.yml` 的 `mac` / `win` 段，条件编译 `appId`、图标、证书环境变量。
- `nsis` 安装器支持「创建桌面快捷方式 / 开机不启动 / 安装目录可选」，符合内部软件分发习惯。

### 7.3　GitHub Actions 双 runner

```yaml
jobs:
  build-mac:   runs-on: macos-latest     # 出 .dmg / .zip
  build-win:   runs-on: windows-latest   # 出 .exe / .msi
# 两 job 并行，产物分别上传 artifact，再合入 Release
```

- **Mac runner** 持有 `APPLE_CERT_BASE64` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` 等 Secrets，构建后自动 `notarize`。
- **Windows runner** 持有 `WIN_CSC_LINK`（p12 证书 base64）/ `WIN_CSC_KEY_PASSWORD`，构建后自动 Authenticode 签名。
- 两个 `secrets` 集合**彼此隔离**，证书不外泄到对方 runner。

### 7.4　签名与公证要点

| 项 | macOS | Windows |
|---|---|---|
| 证书 | Apple Developer ID Application | Authenticode（DigiCert/Sectigo EV 或 OV） |
| 流程 | codesign → `xcrun notarytool submit` → staple | signtool / electron-builder 内建签名 |
| 不签名的代价 | 双击被 Gatekeeper 拦截「无法验证开发者」 | SmartScreen 红页「未知发布者」 |
| 自动化 | CI 内完成，零人工 | CI 内完成，零人工 |

### 7.5　风险登记（打包/CI）

| ID | 风险 | 缓解 |
|---|---|---|
| T22 | 证书成本（Apple $99/年 + Windows 代码签名证书） | 内部工具走公司既有开发者账号；Windows 可先用 OV 证书降成本，SmartScreen 信誉随时间累积 |
| T23 | 双 runner 构建时间长（各 5–15 min） | 并行 job；依赖缓存（`actions/cache` 缓存 `node_modules` / `pnpm store`） |
| T24 | 安装包体积（Electron 壳 ~150MB + 依赖） | 用 `electron-builder` 的 `asar` + 压缩；不打包 Python/LibreOffice（抓取与导出均纯 Node）；体积主要由壳决定，可控 |

---

## 决策记录

| 日期 | 决策 | 理由 |
|---|---|---|
| 2026-08-05 | 前端 React+Vite+TS+Tailwind+HeroUI；封装 Electron | 用户指定 HeroUI；需跨平台安装使用 |
| 2026-08-05 | Mac 本机开发，Windows 包经 GitHub Actions 产出 | Mac 无法本地打带安装器的 exe |
| 2026-08-05 | 1A 热点：内嵌 `imsyy/DailyHotApi` | 同为 Node 栈、MIT、覆盖面足够 |
| 2026-08-05 | **1B 抓取：改为 Electron 原生实现，不集成 MediaCrawler** | 体积零增量、跨平台无差异、登录态天然持久、规避 License 风险；MediaCrawler 降级为接口研究参考 |
| 2026-08-05 | 素材库分类按输出类型四文件夹（选题/洗稿/图片/提示词），长图/四宫格/六宫格降为图片子分类【已被方案 C 推翻：提示词不进库，降为三文件夹】 | 与用户实际产出形态一致 |
| 2026-08-05 | 本地落盘彻底作废，v1.1 纯系统内存储；是否加可选落盘留待封装阶段决定 | 简化配置，去掉绑定目录这一多余门槛 |
| 2026-08-05 | **【已被方案 C 推翻】素材库改为本地直写**：上方"本地落盘彻底作废"作废 | 用户明确希望"导出即落本地文件夹、免下载步骤"；且放同步盘可自动云备份。详见 §5 |
| 2026-08-05 | **API 不固化为单一 GPT，按能力分层**：vision（图文 GLM-4V-Flash / 视频 Qwen-VL-Max）· text（DeepSeek-V4-Flash）· image（OpenAI Images），供应商由设置页配置 | 国产文字模型成本低一个数量级；DeepSeek V4 已灰度识图，未来 vision 槽位可一键切换；架构可插拔不被厂商锁定 |
| 2026-08-05 | **洗稿模块拆两段式**：链接 = 抓取 → VL 识别 → 【人工确认门】→ DeepSeek 改写；贴稿 = 直接改写 | VL 识别可能看岔，错误会被放大成一整篇错稿；人工确认门让错误可见可改；流 A 后半段与流 B 完全复用 |
| 2026-08-05 | **提示词生成「一次生成 + 分隔符拆分」**：tp 模式 DeepSeek 单段出「文案 + `===[IMG_PROMPT]===` + 图片提示词」，系统按分隔符拆两框；img 模式整段进图片框 | 用户要求 AI 一次只生成一段内容，分隔符机制让单段输出可确定性拆分；三级容错（分隔符→语义标题→整段兜底）应对模型不守约 |
| 2026-08-05 | **出图（模块④）固定 GPT 图像模型**：image 槽位 = gpt-image-1（AIHubMix 称 "GPT Image 2"），用户不可选；每次固定输出 1 张；视频生成推迟（v1.1 不做） | 参考站 image 逻辑即 GPT 生图；用户明确"固定 gpt 模型、不需要用户选、数量默认 1 张"；视频是另一类重模型，单独立项 |
| 2026-08-05 | **素材库 = 本地直写（方案 C）+ 三文件夹 + 统一导出层**：导出直接 `fs` 写用户根目录子文件夹（选题/洗稿/图片），系统内仅存索引；Excel/Word 统一收口到 `exporter` 服务（exceljs 出 .xlsx、docx 出 .docx）；提示词不进素材库（仅模块③④中转） | 用户要求"导出免下载、直接落电脑文件夹"；exceljs(Apache2.0)/docx(MIT) 均纯 Node 可商用；提示词既复制又能直喂出图，无需归档 |
| 2026-08-06 | **设置 = AI 能力分层配置 + 安全边界**：设置页拆四面板（AI 模型分层 / AI 代理层 / 素材库本地直写 / 抓取账号可选）；API Key 按能力槽位（text/visionImg/visionVideo/image）分别配置、本地加密、**所有调用经后端代理、前端不持有 Key**；image 槽位锁定为 gpt-image-1 | 不固化单一 GPT，按能力分层可一键切供应商；Key 不入前端包降低泄露风险；对应 PRD US-01/US-03 |
| 2026-08-06 | **打包与 CI 双平台**：electron-vite 工程 + electron-builder；Mac 出 `.dmg`（codesign + notarize），Windows 出 `.exe`/`.msi`（Authenticode 签名）；Windows 包经 GitHub Actions `windows-latest` runner 产出、Mac 包经 `macos-latest`，两 job 并行 | Mac 本机打不出带安装器的 exe；证书 Secrets 两 runner 隔离；nsic/msi 符合内部软件分发 |
| 2026-08-06 | **AI 调用实现策略（架构级，用户明确确认）**：后端统一用**单个 `openai` SDK**（按能力切 `baseURL`+`apiKey`，四家全 OpenAI 兼容）；v1 采用**一次性返回（非流式）**，UI 用加载态过渡；各家具体请求体**留封装阶段查官方文档现场接线** | 一个 SDK 通吃四家、切供应商零代码改动；v1 先保跑通、流式作增强；机械接线不预抄文档（易过时） |
| 2026-08-06 | **【T6 定性下调】洗稿提示词非阻塞**：PRD 早前把"洗稿改写提示词原文未提供"标为 T6 阻塞项；经澄清，所谓洗稿提示词 = **前端用户输入的「洗稿要求」动态填充**，不是写死在系统里的固定模板，故 **T6 不再阻塞**——模块②/③/⑤ 的链路与验收均已具备，无需等待用户提供原文 | 用户 2026-08-06 明确"洗稿提示词就是前端的洗稿要求，不是固定下来的提示词"；VL 结构化输出提示词同理为系统层固定 schema，亦非内容原文 |
| 2026-08-06 | **出图经 AIHubMix 中转站**：image 能力 `base_url=https://aihubmix.com/v1`（OpenAI 兼容）、模型 `gpt-image-1`、设置页 image 槽位 Key = **AIHubMix Key**；text / vision 仍走各原生供应商 | 用户指定出图走 GPT 中转；中转站 OpenAI 兼容、统一 `openai` SDK 不变（仅 `base_url`+`Key` 不同）；返回 `b64_json` 可直接 `fs` 写 PNG；参考图走 `/v1/images/edits` |
