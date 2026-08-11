"""真实搜索（MediaCrawler 代理）。

策略（按可靠性排序）：
  1. **拦截平台自己的搜索 API 响应**（首选）。签名由页面 JS 现算，我们只旁听 JSON，
     既不用逆向签名，也不受 DOM class 名变动影响。
  2. DOM 兜底抽取：API 特征没命中时，用页面选择器抽卡片。

风控：小红书未登录 / 无头 / IP 异常时，搜索 API 会返回 code=300012。
这里会把它识别出来并原样上报，而不是伪装成「没有结果」。
"""

from __future__ import annotations

import asyncio
import json
from typing import Any
from urllib.parse import quote

from playwright.async_api import Page, Response

from browser import manager
from platforms import DOM_EXTRACT, Platform


def _fmt_count(v: Any) -> str:
    """保留平台返回的完整互动数；缺失时明确标为不可得。"""
    if v is None:
        return "—"
    if isinstance(v, str):
        value = v.strip()
        # 小红书未展示互动数时，页面文案会直接返回“赞”，这不是数值。
        return "—" if value in ("", "赞", "点赞") else value
    try:
        n = int(v)
    except (TypeError, ValueError):
        return "—"
    return f"{n:,}"


# ---------------- 各平台 API JSON → 统一 item 形状 ----------------

def _parse_xhs(payload: dict) -> tuple[list[dict], str | None]:
    code = payload.get("code")
    if code not in (0, None) and not payload.get("success", True):
        msg = payload.get("msg") or ""
        if str(code) == "300012" or "网络连接异常" in msg:
            return [], "小红书风控拦截（error_code=300012）：请确认已登录且网络环境正常"
        return [], f"小红书接口返回异常：{code} {msg}".strip()

    items: list[dict] = []
    for it in (payload.get("data") or {}).get("items") or []:
        card = it.get("note_card") or {}
        if not card:
            continue
        title = (card.get("display_title") or "").strip()
        if not title:
            continue
        inter = card.get("interact_info") or {}
        user = card.get("user") or {}
        nid = str(it.get("id") or card.get("note_id") or "")
        # 搜索接口部分卡片把 id 写成 search_result/<note_id>；详情页只接受
        # 原始 note_id，必须剥离此前缀，才能让前端“打开”直达笔记。
        if nid.startswith("search_result/"):
            nid = nid.removeprefix("search_result/")
        token = (it.get("xsec_token") or card.get("xsec_token") or "")
        url = f"https://www.xiaohongshu.com/explore/{nid}" if nid else ""
        if url and token:
            url += f"?xsec_token={token}"
        items.append(
            {
                "t": title,
                "l": _fmt_count(inter.get("liked_count")),
                "c": _fmt_count(inter.get("comment_count")),
                "tags": [],
                "url": url,
                "nickname": (user.get("nickname") or user.get("nick_name") or "").strip(),
            }
        )
    return items, None


def _parse_douyin(payload: dict) -> tuple[list[dict], str | None]:
    status = payload.get("status_code")
    if status not in (0, None):
        return [], f"抖音接口返回异常：status_code={status}"
    items: list[dict] = []
    for it in payload.get("data") or []:
        info = it.get("aweme_info") or {}
        if not info:
            # 综合搜索里混排的用户/话题卡跳过
            continue
        title = (info.get("desc") or "").strip()
        if not title:
            continue
        stat = info.get("statistics") or {}
        author = info.get("author") or {}
        aid = info.get("aweme_id") or ""
        items.append(
            {
                "t": title,
                "l": _fmt_count(stat.get("digg_count")),
                "c": _fmt_count(stat.get("comment_count")),
                "tags": [],
                "url": f"https://www.douyin.com/video/{aid}" if aid else "",
                "nickname": (author.get("nickname") or "").strip(),
            }
        )
    return items, None


def _parse_zhihu(payload: dict) -> tuple[list[dict], str | None]:
    items: list[dict] = []
    for it in payload.get("data") or []:
        obj = it.get("object") or {}
        if not obj:
            continue
        title = obj.get("title") or ""
        if isinstance(title, dict):
            title = title.get("text", "")
        title = _strip_em(str(title)).strip()
        if not title:
            continue
        author = (obj.get("author") or {}).get("name") or ""
        items.append(
            {
                "t": title,
                "l": _fmt_count(obj.get("voteup_count")),
                "c": _fmt_count(obj.get("comment_count")),
                "tags": [],
                "url": (obj.get("url") or "").replace("api.zhihu.com/", "www.zhihu.com/"),
                "nickname": _strip_em(str(author)),
            }
        )
    return items, None


def _strip_em(s: str) -> str:
    return s.replace("<em>", "").replace("</em>", "").replace("<highlight>", "").replace("</highlight>", "")


PARSERS = {
    "xhs": _parse_xhs,
    "douyin": _parse_douyin,
    "zhihu": _parse_zhihu,
}


# ---------------- 主流程 ----------------

async def search(platform: Platform, keyword: str, limit: int = 20) -> dict:
    """返回 {items, live, reason, message}。"""
    if not keyword.strip():
        return {"items": [], "live": False, "reason": "empty_keyword", "message": "关键词为空"}

    if not await manager.is_logged_in(platform):
        return {
            "items": [],
            "live": False,
            "reason": "not_logged_in",
            "message": f"未登录「{platform.name}」，请先到设置页扫码登录后再搜索",
        }

    page = await manager.page(platform)
    captured: list[dict] = []
    risk: list[str] = []

    async def on_response(resp: Response) -> None:
        url = resp.url
        if not any(h in url for h in platform.search_api_hints):
            return
        try:
            payload = await resp.json()
        except Exception:
            try:
                payload = json.loads(await resp.text())
            except Exception:
                return
        if not isinstance(payload, dict):
            return
        parser = PARSERS.get(platform.key)
        if parser is None:
            return
        got, err = parser(payload)
        if err:
            risk.append(err)
        if got:
            captured.extend(got)

    if platform.search_api_hints:
        page.on("response", on_response)

    try:
        target = platform.search_url(quote(keyword))
        await page.goto(target, wait_until="domcontentloaded", timeout=40000)

        # 等 API 回包或 DOM 渲染；最多 ~18s
        deadline = asyncio.get_event_loop().time() + 18
        while asyncio.get_event_loop().time() < deadline:
            if captured or risk:
                break
            await page.wait_for_timeout(700)

        # 触发懒加载，多收一屏
        if captured and len(captured) < limit:
            try:
                await page.mouse.wheel(0, 2400)
                await page.wait_for_timeout(2200)
            except Exception:
                pass

        if risk and not captured:
            return {"items": [], "live": False, "reason": "risk_control", "message": risk[0]}

        if not captured:
            # DOM 兜底
            js = DOM_EXTRACT.get(platform.key)
            if js:
                try:
                    dom_items = await page.evaluate(js)
                    if isinstance(dom_items, list):
                        captured.extend([i for i in dom_items if i.get("t")])
                except Exception:
                    pass

        if not captured:
            return {
                "items": [],
                "live": False,
                "reason": "no_result",
                "message": f"「{platform.name}」未抓到结果（可能是登录态过期或页面结构变化）",
            }

        # 去重（按标题）
        seen: set[str] = set()
        uniq: list[dict] = []
        for it in captured:
            t = it.get("t", "")
            if t in seen:
                continue
            seen.add(t)
            uniq.append(it)

        return {"items": uniq[:limit], "live": True, "reason": None, "message": None}

    except Exception as e:  # noqa: BLE001
        return {"items": [], "live": False, "reason": "error", "message": f"搜索失败：{e}"}
    finally:
        if platform.search_api_hints:
            try:
                page.remove_listener("response", on_response)
            except Exception:
                pass
