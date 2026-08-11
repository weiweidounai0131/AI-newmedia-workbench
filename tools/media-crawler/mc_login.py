"""扫码登录（MediaCrawler 代理）。

修复重点：小红书给**游客**也会下发 `web_session` cookie，只看 cookie 名会误判为已登录
（设置页显示「已连接」，搜索却一直卡住）。
因此登录态判定改为**页面探针优先**：页面上的「登录」入口按钮消失 → 视为已登录；
再用 .mc-verified-login 标记让便宜的 /login/status 不用每次都开浏览器。

流程：
  1. start_login(platform) → 有头打开登录页，若已登录直接返回。
     未登录则尝试点出登录弹窗，读取二维码 img 的 data:image/png;base64 src（
     比截图稳定），返回给前端展示。
  2. 前端轮询 login_status(platform) → 登录入口消失且关键 cookie 在 → 登录成功。
  3. 登录成功后保持上下文，供搜索直接复用真实登录态。
"""

from __future__ import annotations

import asyncio
import base64

from playwright.async_api import Page

from browser import manager
from platforms import Platform

# 风控 / 异常关键词 → 命中即认为登录环境异常。
# 注意：「验证码」「滑动验证」本身是正常登录 UI 文案，不能作为错误指标，
# 否则会误报「环境异常」让用户恐慌。只保留明确的平台风控/错误文案。
RISK_KEYWORDS = [
    "300012",
    "IP 存在风险",
    "IP存在风险",
    "网络连接异常",
    "当前登录存在风险",
    "环境异常",
    "操作太频繁",
    "访问频次异常",
    "您的访问行为异常",
    "网络环境存在异常",
]


async def _try_open_login(page: Page, platform: Platform) -> None:
    """尽力点出登录弹窗（找不到就算了，有头窗口用户也能手动点）。"""
    for sel in platform.login_triggers:
        try:
            loc = page.locator(sel).first
            if await loc.count() > 0 and await loc.is_visible():
                await loc.click(timeout=2500)
                await page.wait_for_timeout(1200)
                return
        except Exception:
            continue


async def _read_qr_from_data_url(page: Page, platform: Platform) -> str | None:
    """从 img.qrcode-img 的 src 属性直接读 data:image/png;base64。"""
    for sel in (".qrcode-img", "img.qrcode-img", ".login-container .qrcode-img"):
        try:
            loc = page.locator(sel).first
            if await loc.count() == 0 or not await loc.is_visible():
                continue
            src = await loc.get_attribute("src")
            if src and src.startswith("data:image"):
                return src
        except Exception:
            continue
    return None


async def _capture_qr(page: Page, platform: Platform, timeout_ms: int = 12000) -> str | None:
    """按候选选择器截取二维码元素，返回 data:image/png;base64,...；失败返回 None。"""
    deadline = asyncio.get_event_loop().time() + timeout_ms / 1000
    while asyncio.get_event_loop().time() < deadline:
        data_url = await _read_qr_from_data_url(page, platform)
        if data_url:
            return data_url
        for sel in platform.qr_selectors:
            try:
                loc = page.locator(sel).first
                if await loc.count() == 0 or not await loc.is_visible():
                    continue
                box = await loc.bounding_box()
                if not box or box["width"] < 40 or box["height"] < 40:
                    continue
                png = await loc.screenshot(type="png")
                return "data:image/png;base64," + base64.b64encode(png).decode("ascii")
            except Exception:
                continue
        await page.wait_for_timeout(600)
    return None


async def start_login(platform: Platform) -> dict:
    """打开登录页并抓二维码。返回 {connected, qr, headful, error}。"""
    if await manager.is_logged_in(platform):
        return {"connected": True, "qr": None, "headful": not _headless(), "error": None}

    page = await manager.page(platform)
    try:
        await page.goto(platform.login_url, wait_until="domcontentloaded", timeout=30000)
    except Exception:
        pass
    await page.wait_for_timeout(1500)

    # 打开过程中可能已经是登录态
    if await manager.is_logged_in(platform):
        return {"connected": True, "qr": None, "headful": not _headless(), "error": None}

    await _try_open_login(page, platform)
    qr = await _capture_qr(page, platform)
    err = await _login_error_message(page)
    return {
        "connected": False,
        "qr": qr,
        "headful": not _headless(),
        "error": err,
    }


async def login_status(platform: Platform) -> dict:
    """轮询登录结果。返回 {connected, error}。"""
    connected = await manager.is_logged_in(platform)
    error = None
    if not connected and manager.is_open(platform):
        try:
            page = await manager.page(platform)
            error = await _login_error_message(page)
        except Exception:
            error = None
    return {"connected": connected, "error": error}


async def _login_error_message(page: Page) -> str | None:
    try:
        body = await page.inner_text("body", timeout=1500)
    except Exception:
        return None
    for kw in RISK_KEYWORDS:
        if kw in body:
            if "300012" in kw or "IP" in kw or "网络连接异常" in kw:
                return "小红书检测到 IP/环境风险（error_code=300012），请稍后重试或更换网络后再登录"
            return f"登录环境异常：命中「{kw}」，请在弹出的浏览器窗口中手动处理后重试"
    return None


def _headless() -> bool:
    from browser import HEADLESS

    return HEADLESS
