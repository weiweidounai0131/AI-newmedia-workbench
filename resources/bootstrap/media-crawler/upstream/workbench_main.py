#!/usr/bin/env python3
"""AI 新媒体工作台专用 MediaCrawler 入口。

与上游 main.py 的 CLI 使用方式保持兼容，但只加载工作台真正使用的
xhs / dy 两个平台和文件存储，避免 import 数据库、词云、Excel、
其他平台及其依赖。
"""

from __future__ import annotations

import argparse
from typing import Optional

import config
from media_platform.douyin import DouYinCrawler
from media_platform.xhs import XiaoHongShuCrawler
from tools.app_runner import run

crawler: Optional[object] = None


def _as_bool(value: str | bool) -> bool:
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


def configure_from_args(args: argparse.Namespace) -> None:
    if args.platform not in {"dy", "xhs"}:
        raise ValueError(f"工作台运行时仅支持 dy/xhs，收到：{args.platform}")
    if args.save_data_option not in {"json", "jsonl", "csv"}:
        raise ValueError("工作台运行时仅支持 json/jsonl/csv 文件存储")

    config.PLATFORM = args.platform
    config.CRAWLER_TYPE = args.type
    config.KEYWORDS = args.keywords
    config.ENABLE_GET_COMMENTS = _as_bool(args.get_comment)
    config.ENABLE_GET_SUB_COMMENTS = False
    config.HEADLESS = _as_bool(args.headless)
    config.CDP_HEADLESS = config.HEADLESS
    config.SAVE_DATA_OPTION = args.save_data_option
    config.SAVE_DATA_PATH = args.save_data_path
    config.CRAWLER_MAX_NOTES_COUNT = args.crawler_max_notes_count
    config.ENABLE_GET_WORDCLOUD = False
    config.ENABLE_IP_PROXY = False

    specified = [item.strip() for item in args.specified_id.split(",") if item.strip()]
    if args.platform == "dy":
        config.DY_SPECIFIED_ID_LIST = specified
    else:
        config.XHS_SPECIFIED_NOTE_URL_LIST = specified


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="AI 新媒体工作台 MediaCrawler Lite")
    parser.add_argument("--platform", default="xhs", choices=["xhs", "dy"])
    parser.add_argument("--type", default="search", choices=["search", "detail"])
    parser.add_argument("--keywords", default="")
    parser.add_argument("--specified_id", default="")
    parser.add_argument("--save_data_option", default="json", choices=["json", "jsonl", "csv"])
    parser.add_argument("--save_data_path", default="")
    parser.add_argument("--get_comment", default="false")
    parser.add_argument("--headless", default="false")
    parser.add_argument("--crawler_max_notes_count", type=int, default=20)
    return parser.parse_args()


async def main() -> None:
    global crawler
    args = parse_args()
    configure_from_args(args)
    crawler = DouYinCrawler() if args.platform == "dy" else XiaoHongShuCrawler()
    await crawler.start()


async def cleanup() -> None:
    global crawler
    if crawler is None:
        return
    cdp_manager = getattr(crawler, "cdp_manager", None)
    if cdp_manager:
        try:
            await cdp_manager.cleanup(force=True)
        except Exception:
            pass
        return
    browser_context = getattr(crawler, "browser_context", None)
    if browser_context:
        try:
            await browser_context.close()
        except Exception:
            pass


if __name__ == "__main__":
    run(main, cleanup, cleanup_timeout_seconds=15.0)
