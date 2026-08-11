"""平台适配配置（MediaCrawler 代理）。

单一事实源：每个平台的登录页 / 登录态 cookie / 搜索页 / 搜索 API 拦截规则 / DOM 兜底抽取脚本。

为什么不直接 clone NanmiCoder/MediaCrawler：
  - 体积 +230MB、非商业授权、爬虫代码易腐；
  - 我们真正需要的是它「有头持久化浏览器 + 复用真实登录态」这套**思路**，
    而不是它的全量框架。本目录以 Playwright 复刻该思路，行为等价但可维护。

关键：MC_HEADLESS 默认 "0"（有头）。小红书对无头浏览器风控极严，
无头模式搜索会稳定返回 error_code=300012（"网络连接异常/IP 存在风险"）。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


# 真实 Chrome UA（与 Playwright Chromium 大版本对齐，避免 UA 与指纹自相矛盾）
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


@dataclass
class Platform:
    key: str                      # 内部 key（xhs/douyin/weibo/zhihu）
    name: str                     # 中文名（与前端 / Electron 契约一致）
    home_url: str
    login_url: str
    search_url: Callable[[str], str]
    host_keyword: str             # cookie domain 过滤用
    auth_cookies: list[str]       # 出现任一即视为已登录
    # 触发登录弹窗的候选按钮（按序尝试点击，找不到就跳过）
    login_triggers: list[str] = field(default_factory=list)
    # 二维码元素候选选择器（按序尝试截图）
    qr_selectors: list[str] = field(default_factory=list)
    # 搜索结果 API 的 URL 特征（命中则拦截其 JSON 响应）
    search_api_hints: list[str] = field(default_factory=list)
    # 「游客」标志：登录入口按钮的候选选择器。可见即视为**未登录**。
    # 这是判定登录态最可靠的信号——扫码成功后登录入口会消失/变成头像。
    # （小红书等站点会给游客也下发 web_session，故单看 cookie 名会误判为已登录）
    guest_indicators: list[str] = field(default_factory=list)
    # 「登录中」标志：登录弹窗/面板可见时，游客标志可能被遮挡而不可见，
    # 此时应跳过页面探针，避免误判为已登录。
    login_progress_indicators: list[str] = field(default_factory=list)
    # 「已登录」标志：头像/用户菜单等。同时满足「无游客标志 + 有已登录标志」才最可靠。
    logged_in_indicators: list[str] = field(default_factory=list)


PLATFORMS: dict[str, Platform] = {
    "xhs": Platform(
        key="xhs",
        name="小红书",
        home_url="https://www.xiaohongshu.com/explore",
        login_url="https://www.xiaohongshu.com/explore",
        search_url=lambda kw: (
            "https://www.xiaohongshu.com/search_result?keyword="
            f"{kw}&source=web_explore_feed&type=51"
        ),
        host_keyword="xiaohongshu.com",
        auth_cookies=["web_session"],
        login_triggers=[
            "#login-btn",
            ".login-btn",
            ".side-bar .user .link-wrapper",
            "text=登录",
        ],
        qr_selectors=[
            ".login-container .qrcode-img",
            ".qrcode-img",
            ".login-container img[src^='data:image']",
            "img.qrcode-img",
            ".login-box-container .qrcode",
            ".login-container",
        ],
        search_api_hints=["/api/sns/web/v1/search/notes"],
        guest_indicators=[".login-btn", "#login-btn", ".login-btn-component"],
        login_progress_indicators=[".login-container", ".login-box-container", ".login-popup"],
        logged_in_indicators=[".reds-avatar", ".user-avatar", ".user-info", "[class*='avatar']"],
    ),
    "douyin": Platform(
        key="douyin",
        name="抖音",
        home_url="https://www.douyin.com/",
        login_url="https://www.douyin.com/",
        search_url=lambda kw: f"https://www.douyin.com/search/{kw}?type=general",
        host_keyword="douyin.com",
        auth_cookies=["sessionid_ss", "sessionid", "sid_guard", "sid_tt"],
        login_triggers=[
            "#login-panel-new",
            "[data-e2e='login-button']",
            ".login-button",
            "text=登录",
        ],
        qr_selectors=[
            "#login-panel-new img",
            ".web-login-scan-code__content__qrcode-wrapper img",
            ".web-login-scan-code img",
            "#login-pannel img",
            "[class*='qrcode'] img",
            "#login-panel-new",
        ],
        search_api_hints=[
            "/aweme/v1/web/general/search/single/",
            "/aweme/v1/web/search/item/",
        ],
        guest_indicators=["[data-e2e='login-button']", "#login-panel-new"],
        login_progress_indicators=[".web-login-scan-code", "#login-panel-new"],
        logged_in_indicators=["[data-e2e='user-avatar']", ".avatar"],
    ),
    "weibo": Platform(
        key="weibo",
        name="微博",
        home_url="https://weibo.com/",
        login_url="https://weibo.com/login.php",
        search_url=lambda kw: f"https://s.weibo.com/weibo?q={kw}",
        host_keyword="weibo.com",
        auth_cookies=["SUB", "SUBP"],
        login_triggers=["text=登录", ".LoginCard_btn_1cuxE"],
        qr_selectors=[
            ".LoginCard_qrcode_2S6HB img",
            "[class*='qrcode'] img",
            ".qrcode_box img",
            ".login_qrcode img",
        ],
        search_api_hints=[],  # 微博搜索是服务端渲染，走 DOM 抽取
        guest_indicators=["a[node-type='loginBtn']", "[class*='LoginCard']", ".gn_login"],
        login_progress_indicators=["[class*='LoginCard']", ".login_box"],
        logged_in_indicators=[".userinfo", ".gn_name_list"],
    ),
    "zhihu": Platform(
        key="zhihu",
        name="知乎",
        home_url="https://www.zhihu.com/",
        login_url="https://www.zhihu.com/signin",
        search_url=lambda kw: f"https://www.zhihu.com/search?type=content&q={kw}",
        host_keyword="zhihu.com",
        auth_cookies=["z_c0"],
        login_triggers=["text=登录", ".SignFlow-qrcodeTab"],
        qr_selectors=[
            ".Qrcode-img img",
            ".SignFlowQrcode img",
            "[class*='Qrcode'] img",
        ],
        search_api_hints=["/api/v4/search_v3"],
        guest_indicators=[".AppHeader-login", ".SignFlow", "button.SignFlow-submitButton"],
        login_progress_indicators=[".SignFlow", ".Login-socialLogin"],
        logged_in_indicators=[".AppHeader-profile", ".UserAvatar"],
    ),
}


# 中文名 → key（Electron / 前端用中文名作为契约）
NAME_TO_KEY: dict[str, str] = {p.name: p.key for p in PLATFORMS.values()}


def resolve(platform: str) -> Platform | None:
    """接受中文名（小红书）或 key（xhs），返回平台配置。"""
    if platform in PLATFORMS:
        return PLATFORMS[platform]
    key = NAME_TO_KEY.get(platform)
    return PLATFORMS.get(key) if key else None


# ---- DOM 兜底抽取脚本（API 拦截失败时用；返回 {t,l,c,tags,url,nickname} 形状） ----
DOM_EXTRACT: dict[str, str] = {
    "xhs": """() => {
      const out = [];
      const nodes = document.querySelectorAll('section.note-item, div.note-item');
      for (const n of nodes) {
        const a = n.querySelector('a.cover') || n.querySelector('a[href*="/explore/"]') || n.querySelector('a');
        const href = a ? a.getAttribute('href') : '';
        const titleEl = n.querySelector('.title span, .title, .content');
        const img = n.querySelector('img');
        const title = ((titleEl && titleEl.textContent) || (img && img.alt) || '').trim();
        const authorEl = n.querySelector('.author .name, .name');
        const likeEl = n.querySelector('.like-wrapper .count, .count');
        if (!title) continue;
        out.push({
          t: title,
          l: likeEl ? likeEl.textContent.trim() : '0',
          c: '—',
          tags: [],
          url: href ? (href.startsWith('http') ? href : 'https://www.xiaohongshu.com' + href) : '',
          nickname: authorEl ? authorEl.textContent.trim() : ''
        });
      }
      return out.slice(0, 30);
    }""",
    "douyin": """() => {
      const out = [];
      const nodes = document.querySelectorAll('[data-e2e="scroll-list"] li, .search-result-card, li[class*="SwitchTab"]');
      for (const n of nodes) {
        const a = n.querySelector('a[href*="/video/"]') || n.querySelector('a');
        const href = a ? a.getAttribute('href') : '';
        const titleEl = n.querySelector('[class*="title"], .video-title, .desc');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const authorEl = n.querySelector('[class*="author"], [class*="nickname"]');
        const likeEl = n.querySelector('[class*="like"], [class*="count"]');
        if (!title) continue;
        out.push({
          t: title,
          l: likeEl ? likeEl.textContent.trim() : '—',
          c: '—',
          tags: [],
          url: href ? (href.startsWith('http') ? href : 'https://www.douyin.com' + href) : '',
          nickname: authorEl ? authorEl.textContent.trim() : ''
        });
      }
      return out.slice(0, 30);
    }""",
    "weibo": """() => {
      const out = [];
      const nodes = document.querySelectorAll('div.card-wrap[action-type="feed_list_item"]');
      for (const n of nodes) {
        const txtEl = n.querySelector('p.txt');
        const title = txtEl ? txtEl.textContent.replace(/\\s+/g, ' ').trim() : '';
        const authorEl = n.querySelector('a.name');
        const acts = n.querySelectorAll('.card-act li');
        const like = acts.length >= 3 ? acts[2].textContent.replace(/\\D/g, '') : '';
        const comment = acts.length >= 2 ? acts[1].textContent.replace(/\\D/g, '') : '';
        const a = n.querySelector('.from a');
        if (!title) continue;
        out.push({
          t: title.slice(0, 120),
          l: like || '0',
          c: comment || '0',
          tags: [],
          url: a ? (a.getAttribute('href') || '').replace(/^\\/\\//, 'https://') : '',
          nickname: authorEl ? authorEl.textContent.trim() : ''
        });
      }
      return out.slice(0, 30);
    }""",
    "zhihu": """() => {
      const out = [];
      const nodes = document.querySelectorAll('.SearchResult-Card, .Card.SearchResult-Card');
      for (const n of nodes) {
        const titleEl = n.querySelector('h2, .ContentItem-title');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const a = n.querySelector('h2 a, .ContentItem-title a');
        const authorEl = n.querySelector('.AuthorInfo-name');
        const likeEl = n.querySelector('.VoteButton, [class*="Vote"]');
        if (!title) continue;
        out.push({
          t: title,
          l: likeEl ? likeEl.textContent.replace(/[^0-9]/g, '') || '0' : '0',
          c: '0',
          tags: [],
          url: a ? (a.getAttribute('href') || '') : '',
          nickname: authorEl ? authorEl.textContent.trim() : ''
        });
      }
      return out.slice(0, 30);
    }""",
}
