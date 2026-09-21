#!/usr/bin/env python3
"""AI 新媒体工作台专用下载服务。

只暴露工作台当前实际使用的接口：
- /api/settings
- /api/douyin/*
- /api/xhs/*

不加载原 wechat-mp-tools 的公众号、B站、快手、Channels、RSS、转码、
字幕去除、桌面 GUI、更新器等模块，避免为未使用功能安装重量级依赖。
"""

import argparse

from flask import Flask, jsonify, request

from backend.runtime import configure_runtime

configure_runtime()

from backend.config import ensure_dirs, get_settings, save_settings
from backend.douyin import douyin_bp
from backend.xiaohongshu import xhs_bp

app = Flask(__name__)
app.register_blueprint(douyin_bp)
app.register_blueprint(xhs_bp)


@app.get("/health")
def health():
    return jsonify({"ok": True, "service": "newmedia-downloader-lite"})


@app.get("/api/settings")
def settings_get():
    return jsonify(get_settings())


@app.post("/api/settings")
def settings_save():
    data = request.get_json(silent=True) or {}
    settings = get_settings()
    settings.update(data)
    save_settings(settings)
    return jsonify({"message": "设置已保存"})


def main():
    parser = argparse.ArgumentParser(description="AI 新媒体工作台下载服务")
    parser.add_argument("--port", type=int, default=5200)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()

    ensure_dirs()
    print(f"[downloader-lite] http://{args.host}:{args.port}", flush=True)
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True)


if __name__ == "__main__":
    main()
