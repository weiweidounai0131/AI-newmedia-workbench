# resources/ —— 打包资源目录

`electron-builder.yml` 将该目录作为 `buildResources`，并通过 `extraResources` 一并打进安装包。

## 首次发布前必须补齐的图标

`electron-builder` 对 macOS（`.dmg`/`.zip`）与 Windows（`.nsis`/`.msi`）**强制要求平台图标**，缺失会导致打包报错。请在首次跑 CI 发布前放入以下文件：

| 文件 | 平台 | 说明 |
|---|---|---|
| `icon.icns` | macOS | 1024×1024 最佳；可由 `icon.png` 经 macOS `iconutil` 或 [electron-icon-maker](https://www.npmjs.com/package/electron-icon-maker) 生成 |
| `icon.ico` | Windows | 含 16/32/48/256 多分辨率；可由 `icon.png` 经 `png2ico` / 在线工具生成 |
| `icon.png` | 通用 | 1024×1024 源图，便于两者派生 |

`electron-builder.yml` 中图标通过 `icon: resources/icon` 自动按平台识别 `.icns`/`.ico`。

> 当前目录暂无图标文件——本地 CI 在补齐前会因缺图标中断，属预期（图标为美术资产，需人工提供，无法在工程中自动生成）。

## 可选

- Windows NSIS 安装背景图 `installerSidebar.bmp`（164×314）等，按 `electron-builder.yml` 的 `nsis` 段扩展。
