"""MediaCrawler 代理服务（FastAPI）。

由 Electron 主进程自动拉起，默认监听 127.0.0.1:8091（仅本机可达）。

端点：
  GET  /health                      健康检查
  GET  /login/status                全平台登录态
  POST /login/qr    {platform}      打开有头浏览器 + 抓二维码
  GET  /login/session?platform=     轮询登录结果
  POST /logout      {platform}      关闭该平台上下文
  GET  /search?platform=&kw=        真实搜索

启动：
  MC_DATA_DIR=<userData> MC_HEADLESS=0 <venv>/bin/python server.py --port 8091
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import os
import sys
from pathlib import Path

# 允许以脚本方式直接运行（同目录模块导入）
sys.path.insert(0, str(Path(__file__).parent))

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import browser  # noqa: E402
import mc_login  # noqa: E402
import search as search_mod  # noqa: E402
from browser import manager  # noqa: E402
from platforms import PLATFORMS, resolve  # noqa: E402


app = FastAPI(title="MediaCrawler Proxy", version="1.0")

# 每平台一把操作锁：Playwright 同一 page 不能并发驱动
_op_locks: dict[str, asyncio.Lock] = {}


def _op_lock(key: str) -> asyncio.Lock:
    if key not in _op_locks:
        _op_locks[key] = asyncio.Lock()
    return _op_locks[key]


class PlatformBody(BaseModel):
    platform: str


class CookieSyncBody(PlatformBody):
    cookies: str = ''


class VideoFramesBody(PlatformBody):
    link: str


@app.get("/health")
async def health() -> dict:
    return {
        "ok": True,
        "headless": browser.HEADLESS,
        "dataDir": str(browser.DATA_DIR),
        "platforms": [p.name for p in PLATFORMS.values()],
    }


@app.get("/login/status")
async def login_status_all() -> dict:
    out: dict[str, bool] = {}
    for p in PLATFORMS.values():
        try:
            out[p.name] = await manager.is_logged_in(p)
        except Exception:
            out[p.name] = False
    return {"platforms": out}


@app.post("/login/qr")
async def login_qr(body: PlatformBody) -> dict:
    p = resolve(body.platform)
    if p is None:
        return {"error": f"不支持的平台：{body.platform}", "code": "unsupported"}
    async with _op_lock(p.key):
        try:
            return await mc_login.start_login(p)
        except Exception as e:  # noqa: BLE001
            return {"error": f"打开登录页失败：{e}", "code": "login_failed"}


@app.get("/login/session")
async def login_session(platform: str) -> dict:
    p = resolve(platform)
    if p is None:
        return {"error": f"不支持的平台：{platform}", "code": "unsupported"}
    try:
        return await mc_login.login_status(p)
    except Exception as e:  # noqa: BLE001
        return {"connected": False, "error": f"查询登录态失败：{e}"}


@app.post("/login/cookies")
async def sync_login_cookies(body: CookieSyncBody) -> dict:
    p = resolve(body.platform)
    if p is None:
        return {"error": f"不支持的平台：{body.platform}", "code": "unsupported"}
    try:
        count = await manager.sync_cookie_string(p, body.cookies)
        return {"ok": True, "count": count}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"同步登录态失败：{e}", "code": "cookie_sync_failed"}


@app.post("/logout")
async def logout(body: PlatformBody) -> dict:
    p = resolve(body.platform)
    if p is None:
        return {"error": f"不支持的平台：{body.platform}", "code": "unsupported"}
    await manager.close_platform(p)
    return {"ok": True}


@app.get("/search")
async def do_search(platform: str, kw: str, limit: int = 20) -> dict:
    p = resolve(platform)
    if p is None:
        return {"items": [], "live": False, "reason": "unsupported", "message": f"不支持的平台：{platform}"}
    async with _op_lock(p.key):
        return await search_mod.search(p, kw, limit=limit)


@app.post("/video/frames")
async def video_frames(body: VideoFramesBody) -> dict:
    """从已登录的平台页面截取少量关键画面，供本地工作台识别使用。"""
    p = resolve(body.platform)
    if p is None:
        return {"error": f"不支持的平台：{body.platform}"}
    if not await manager.is_logged_in(p):
        return {"error": f"未登录「{p.name}」，请先在设置页完成登录", "code": "not_logged_in"}
    async with _op_lock(p.key):
        page = None
        try:
            # 不复用搜索/登录留下的标签页：其上可能存在弹窗或未完成的跳转，
            # 会让视频定位和截图一直等待。
            context = await asyncio.wait_for(manager.context(p), timeout=15)
            page = await asyncio.wait_for(context.new_page(), timeout=8)
            await page.goto(body.link, wait_until="domcontentloaded", timeout=15000)
            await page.wait_for_timeout(1000)
            title = await page.title()
            # 不用 Locator.get_attribute：当平台未输出 og 描述时它会按默认
            # 30 秒等待，导致明明已加载的视频被误判为超时。
            description = await page.evaluate(
                "() => document.querySelector(\"meta[property='og:description']\")?.getAttribute('content') || ''"
            )
            video = page.locator("video").first
            if await video.count() == 0:
                return {"error": "未在页面中找到可识别的视频画面", "code": "video_not_found"}
            try:
                await video.scroll_into_view_if_needed(timeout=3000)
            except Exception:
                pass
            duration = await video.evaluate("el => Number.isFinite(el.duration) ? el.duration : 0")
            # 三帧足够覆盖开头、主体和结尾，也能把单次识别等待控制在可接受范围。
            points = [0.1, 0.5, 0.9] if duration > 1 else [0]
            frames: list[str] = []
            for ratio in points:
                try:
                    if duration > 1:
                        await video.evaluate("(el, t) => { el.currentTime = t; }", duration * ratio)
                        await page.wait_for_timeout(450)
                    image = await video.screenshot(type="jpeg", quality=65, scale="css", timeout=4000)
                    frames.append(base64.b64encode(image).decode("ascii"))
                except Exception:
                    continue
            if not frames:
                return {"error": "视频画面暂不可读取，请稍后重试", "code": "frame_capture_failed"}
            return {"title": title, "description": description, "frames": frames}
        except asyncio.TimeoutError:
            return {"error": "打开视频页面超时，请稍后重试", "code": "video_timeout"}
        except Exception as exc:  # noqa: BLE001
            return {"error": f"视频页面读取失败：{exc}", "code": "video_page_failed"}
        finally:
            if page is not None:
                with contextlib.suppress(Exception):
                    await page.close()


@app.on_event("shutdown")
async def _shutdown() -> None:
    with contextlib.suppress(Exception):
        await manager.shutdown()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=int(os.environ.get("MC_PORT", "8091")))
    args = ap.parse_args()
    print(
        f"[mc] MediaCrawler 代理启动 http://{args.host}:{args.port} "
        f"headless={browser.HEADLESS} data={browser.DATA_DIR}",
        flush=True,
    )
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
