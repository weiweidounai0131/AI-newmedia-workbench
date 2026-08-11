"""诊断脚本：确认某平台游客页面的「登录入口选择器」与「二维码元素」到底长什么样。

用途：平台改版后，登录探针 / 二维码抓取失效时，先跑这个看真实 DOM，再回填 platforms.py。

用法：
  <venv>/bin/python diagnose.py xhs
  <venv>/bin/python diagnose.py douyin
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from playwright.async_api import async_playwright  # noqa: E402

from browser import LAUNCH_ARGS, STEALTH_JS  # noqa: E402
from platforms import UA, resolve  # noqa: E402


async def main(key: str) -> None:
    p = resolve(key)
    if p is None:
        print("unknown platform", key)
        return

    tmp = tempfile.mkdtemp(prefix=f"mc-diag-{p.key}-")
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=tmp,
            headless=False,
            args=LAUNCH_ARGS,
            user_agent=UA,
            viewport={"width": 1280, "height": 900},
            locale="zh-CN",
            timezone_id="Asia/Shanghai",
            ignore_default_args=["--enable-automation"],
        )
        await ctx.add_init_script(STEALTH_JS)
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        await page.goto(p.login_url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(4000)
        print("URL:", page.url)

        print("\n--- 游客标志候选（guest_indicators）---")
        for sel in p.guest_indicators:
            try:
                loc = page.locator(sel).first
                n = await loc.count()
                vis = await loc.is_visible() if n else False
                txt = (await loc.inner_text())[:40].replace("\n", " ") if vis else ""
                print(f"  {sel:<45} count={n} visible={vis} text={txt!r}")
            except Exception as e:
                print(f"  {sel:<45} ERR {e}")

        print("\n--- 页面上所有含「登录」字样的可见元素 ---")
        found = await page.evaluate(
            """() => {
              const out = [];
              const all = document.querySelectorAll('button, a, div, span, li');
              for (const e of all) {
                const t = (e.textContent || '').trim();
                if ((t === '登录' || t === '登录/注册' || t === '立即登录') && e.offsetParent !== null) {
                  out.push({ tag: e.tagName, cls: e.className && e.className.toString().slice(0,80), id: e.id, text: t });
                }
              }
              return out.slice(0, 12);
            }"""
        )
        for f in found:
            print("  ", f)

        print("\n--- 点击登录入口 ---")
        clicked = None
        for sel in p.login_triggers:
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible():
                    await loc.click(timeout=3000)
                    clicked = sel
                    break
            except Exception:
                continue
        print("  clicked:", clicked)
        await page.wait_for_timeout(3500)

        print("\n--- 二维码候选（qr_selectors）---")
        for sel in p.qr_selectors:
            try:
                loc = page.locator(sel).first
                n = await loc.count()
                vis = await loc.is_visible() if n else False
                box = await loc.bounding_box() if vis else None
                print(f"  {sel:<50} count={n} visible={vis} box={box}")
            except Exception as e:
                print(f"  {sel:<50} ERR {e}")

        print("\n--- 页面上所有 img(data:/canvas)，尺寸 >80 ---")
        imgs = await page.evaluate(
            """() => {
              const out = [];
              for (const e of document.querySelectorAll('img, canvas')) {
                const r = e.getBoundingClientRect();
                if (r.width > 80 && r.height > 80) {
                  out.push({
                    tag: e.tagName,
                    cls: (e.className||'').toString().slice(0,80),
                    src: (e.getAttribute && (e.getAttribute('src')||'').slice(0,40)) || '',
                    w: Math.round(r.width), h: Math.round(r.height)
                  });
                }
              }
              return out.slice(0, 15);
            }"""
        )
        for i in imgs:
            print("  ", i)

        shot = f"/tmp/mc-diag-{p.key}.png"
        await page.screenshot(path=shot, full_page=False)
        print("\nscreenshot:", shot)
        await ctx.close()


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "xhs"))
