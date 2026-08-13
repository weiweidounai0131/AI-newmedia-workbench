"""有头持久化浏览器管理（MediaCrawler 代理核心）。

每个平台一个独立的 Playwright persistent context（独立 user_data_dir），
登录态由 Chromium 自己落盘，进程重启后仍在 —— 这就是「登录一次，长期可用」的来源。

登录态判定有两条路径：
  1. 若该平台的 context 正活着 → 直接 context.cookies() 查关键 cookie；
  2. 若没活着（代理刚启动 / 浏览器已关）→ 直读 profile 下的 Cookies SQLite。
     注意：cookie 的 value 是加密的，但我们只需要判断「这个 name 存在且未过期」，
     不需要解密，所以 SQLite 方案完全够用，且无需弹出浏览器。
"""

from __future__ import annotations

import asyncio
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

from playwright.async_api import async_playwright, BrowserContext, Page, Playwright

from platforms import Platform, UA


def _env_bool(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


# MC_HEADLESS 默认 "0" —— 有头。小红书对无头浏览器风控极严（error_code=300012）。
HEADLESS = _env_bool("MC_HEADLESS", "0")

# 首次环境优先复用用户已安装的 Chrome / Edge，避免在国内网络环境额外下载
# Playwright Chromium。未传入时仍按 Playwright 默认浏览器运行，兼容旧安装。
BROWSER_EXECUTABLE_PATH = os.environ.get("MC_BROWSER_EXECUTABLE_PATH", "").strip()

# 数据根目录：Electron 会通过环境变量传入 userData 目录，独立跑时落在本目录下。
DATA_DIR = Path(
    os.environ.get("MC_DATA_DIR") or (Path(__file__).parent / ".mc-data")
).expanduser()

# 反自动化检测：去掉 navigator.webdriver 等最明显的指纹
STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
window.chrome = window.chrome || { runtime: {} };
const _q = navigator.permissions && navigator.permissions.query;
if (_q) {
  navigator.permissions.query = (p) =>
    p && p.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : _q(p);
}
"""

LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--start-maximized",
]


def profile_dir(platform: Platform) -> Path:
    # 正式 MediaCrawler 已完成的抖音登录态可作为本地代理的共享只读/复用
    # profile。这样搜索回退不会要求用户再次扫码，也不会混用普通 Chrome
    # 的个人 profile。
    if platform.key == "douyin" and os.environ.get("MC_DOUYIN_PROFILE_DIR"):
        d = Path(os.environ["MC_DOUYIN_PROFILE_DIR"]).expanduser()
        d.mkdir(parents=True, exist_ok=True)
        return d
    d = DATA_DIR / "mc-profiles" / platform.key
    d.mkdir(parents=True, exist_ok=True)
    return d


# ---------------- 「已验证登录」标记 ----------------
# 为什么需要它：小红书对**游客**也会下发 web_session cookie，
# 只看 cookie 名会把「刚打开首页的游客」误判成已登录 —— 表现就是
# 「设置页显示已连接，但一搜索就卡住/返回风控」。
# 因此：只有页面探针确认过真实登录，才写下这个标记；
# 便宜的 /login/status 用「标记 + cookie 仍在」双条件，杜绝误判。

def marker_path(platform: Platform) -> Path:
    return profile_dir(platform) / ".mc-verified-login"


def has_marker(platform: Platform) -> bool:
    return marker_path(platform).exists()


def set_marker(platform: Platform) -> None:
    try:
        marker_path(platform).write_text(str(int(time.time())), encoding="utf-8")
    except OSError:
        pass


def clear_marker(platform: Platform) -> None:
    try:
        marker_path(platform).unlink(missing_ok=True)
    except OSError:
        pass


# ---------------- Cookies SQLite（无需启动浏览器即可判定登录态） ----------------

_CHROME_EPOCH_OFFSET = 11644473600  # 1601-01-01 → 1970-01-01 秒数


def _chrome_now_us() -> int:
    return int((time.time() + _CHROME_EPOCH_OFFSET) * 1_000_000)


def cookie_names_from_profile(platform: Platform) -> set[str]:
    """直读 profile 的 Cookies SQLite，返回该站点下未过期的 cookie 名集合。

    只看 name，不解密 value —— 判定登录态足够，且避免触发 macOS 钥匙串。
    """
    db = profile_dir(platform) / "Default" / "Cookies"
    if not db.exists():
        return set()
    # 只读方式打开，避免与正在运行的 Chromium 抢锁
    uri = f"file:{db}?mode=ro&immutable=1"
    names: set[str] = set()
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=1.0)
        try:
            rows = conn.execute(
                "SELECT name, host_key, expires_utc FROM cookies WHERE host_key LIKE ?",
                (f"%{platform.host_keyword}",),
            ).fetchall()
        finally:
            conn.close()
    except sqlite3.Error:
        return set()
    now = _chrome_now_us()
    for name, _host, expires in rows:
        if not expires or expires > now:
            names.add(name)
    return names


class BrowserManager:
    """全局单例：管理各平台的持久化上下文。"""

    def __init__(self) -> None:
        self._pw: Optional[Playwright] = None
        self._contexts: dict[str, BrowserContext] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _lock(self, key: str) -> asyncio.Lock:
        if key not in self._locks:
            self._locks[key] = asyncio.Lock()
        return self._locks[key]

    async def _playwright(self) -> Playwright:
        if self._pw is None:
            self._pw = await async_playwright().start()
        return self._pw

    def is_open(self, platform: Platform) -> bool:
        ctx = self._contexts.get(platform.key)
        return ctx is not None

    async def context(self, platform: Platform, headless: bool | None = None) -> BrowserContext:
        """取得（必要时创建）该平台的持久化上下文。"""
        async with self._lock(platform.key):
            ctx = self._contexts.get(platform.key)
            if ctx is not None:
                try:
                    _ = ctx.pages  # 探活
                    return ctx
                except Exception:
                    self._contexts.pop(platform.key, None)

            pw = await self._playwright()
            use_headless = HEADLESS if headless is None else headless
            launch_options = dict(
                user_data_dir=str(profile_dir(platform)),
                headless=use_headless,
                args=LAUNCH_ARGS,
                user_agent=UA,
                viewport={"width": 1280, "height": 900},
                locale="zh-CN",
                timezone_id="Asia/Shanghai",
                ignore_default_args=["--enable-automation"],
            )
            if BROWSER_EXECUTABLE_PATH and Path(BROWSER_EXECUTABLE_PATH).is_file():
                launch_options["executable_path"] = BROWSER_EXECUTABLE_PATH
            ctx = await pw.chromium.launch_persistent_context(**launch_options)
            await ctx.add_init_script(STEALTH_JS)
            ctx.on("close", lambda _c=None: self._contexts.pop(platform.key, None))
            self._contexts[platform.key] = ctx
            return ctx

    async def sync_cookie_string(self, platform: Platform, raw_cookie: str) -> int:
        """把外部工具保存的 Cookie 字符串注入本平台的 Playwright 上下文。"""
        cookies = []
        for part in (raw_cookie or '').split(';'):
            item = part.strip()
            if not item or '=' not in item:
                continue
            name, value = item.split('=', 1)
            if name.strip() and value.strip():
                cookies.append({
                    'name': name.strip(),
                    'value': value.strip(),
                    'domain': f'.{platform.host_keyword}',
                    'path': '/',
                })
        if not cookies:
            return 0
        ctx = await self.context(platform)
        await ctx.add_cookies(cookies)
        if platform.key == 'douyin':
            set_marker(platform)
        return len(cookies)

    async def page(self, platform: Platform, headless: bool | None = None) -> Page:
        ctx = await self.context(platform, headless=headless)
        # 复用已有页面，避免每次操作都开新标签
        for p in ctx.pages:
            if not p.is_closed():
                return p
        return await ctx.new_page()

    async def live_cookie_names(self, platform: Platform) -> set[str] | None:
        """上下文活着时，从内存读 cookie 名；否则返回 None。"""
        ctx = self._contexts.get(platform.key)
        if ctx is None:
            return None
        try:
            cookies = await ctx.cookies()
        except Exception:
            return None
        return {
            c["name"]
            for c in cookies
            if platform.host_keyword in (c.get("domain") or "")
        }

    async def _page_on_site(self, platform: Platform) -> Page | None:
        """找一个已经停在本站的活页面（探针只能在本站页面上做）。"""
        ctx = self._contexts.get(platform.key)
        if ctx is None:
            return None
        for p in ctx.pages:
            try:
                if not p.is_closed() and platform.host_keyword in (p.url or ""):
                    return p
            except Exception:
                continue
        return None

    async def _any_visible(self, page, selectors: list[str]) -> bool:
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible():
                    return True
            except Exception:
                continue
        return False

    async def probe_logged_in(self, platform: Platform) -> bool | None:
        """页面探针：
          - 登录弹窗打开 → 无法判定（跳过，避免误判）。
          - 游客入口可见 → 未登录。
          - 游客入口不可见且已登录标志可见 → 已登录。
          - 两者都不可见 → 无法判定。

        返回 None 表示「无法判定」，由调用方走标记 + cookie 路径。
        """
        page = await self._page_on_site(platform)
        if page is None:
            return None
        try:
            # 正在登录流程中（弹窗打开），探针不可靠
            if platform.login_progress_indicators and await self._any_visible(page, platform.login_progress_indicators):
                return None
            guest_visible = await self._any_visible(page, platform.guest_indicators)
            logged_visible = await self._any_visible(page, platform.logged_in_indicators)
            if guest_visible:
                return False
            if logged_visible:
                return True
            return None
        except Exception:
            return None

    async def _auth_cookie_present(self, platform: Platform) -> bool:
        names = await self.live_cookie_names(platform)
        if names is None:
            names = cookie_names_from_profile(platform)
        elif not any(n in names for n in platform.auth_cookies):
            # 上下文刚起来、cookie 还没同步进内存时，再看一眼磁盘
            names = names | cookie_names_from_profile(platform)
        return any(n in names for n in platform.auth_cookies)

    async def is_logged_in(self, platform: Platform) -> bool:
        """真实登录态。探针优先；探不到时用「已验证标记 + 关键 cookie 仍在」。"""
        probed = await self.probe_logged_in(platform)
        if probed is True:
            set_marker(platform)
            return True
        if probed is False:
            clear_marker(platform)
            return False
        # 正式 MediaCrawler 的专用 profile 已由工作台登录流程验证过。代理在
        # 第一次打开页面前尚没有可探测 DOM，因此这里允许以有效抖音会话 cookie
        # 启动页面搜索；页面实际返回仍会继续作为最终成功判定。
        if platform.key == "douyin" and os.environ.get("MC_DOUYIN_PROFILE_DIR"):
            return await self._auth_cookie_present(platform)
        return has_marker(platform) and await self._auth_cookie_present(platform)

    async def close_platform(self, platform: Platform) -> None:
        async with self._lock(platform.key):
            ctx = self._contexts.pop(platform.key, None)
        if ctx is not None:
            try:
                await ctx.close()
            except Exception:
                pass

    async def shutdown(self) -> None:
        for key in list(self._contexts):
            ctx = self._contexts.pop(key, None)
            if ctx is not None:
                try:
                    await ctx.close()
                except Exception:
                    pass
        if self._pw is not None:
            try:
                await self._pw.stop()
            except Exception:
                pass
            self._pw = None


manager = BrowserManager()
