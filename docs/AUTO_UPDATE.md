# 自动更新发布说明

应用启动时会检查一次更新。发现新版本后，用户可以选择下载；下载完成后可立即重启安装，也可以在下次退出应用时安装。

## 一次性配置

1. 创建一个 Cloudflare R2 存储桶，并配置一个 HTTPS 公开读取域名，例如 `https://updates.example.com/ai-newmedia-workbench`。
2. 本机调试时，将 `resources/update-source.example.json` 复制为 `resources/update-source.json`，把其中的 `url` 改成该地址。此文件只包含公开读取地址，不含上传密钥，且不会提交到 Git。
3. 在 GitHub 私有仓库的 Actions Secrets 中保存下列值：
   - `UPDATE_SERVER_URL`：上述公开读取地址。
   - `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`：R2 上传凭据与桶名。
   建议创建仅能写入这个更新桶的访问令牌。

## 每次发布

1. 递增 `package.json` 的 `version`，例如从 `0.1.0` 改为 `0.1.1`。
2. 分别构建 macOS 和 Windows 安装包。
3. 上传构建产物中的下列文件到同一个 R2 目录根部：
   - macOS：`.zip`、`latest-mac.yml`、对应的 `.blockmap`；`.dmg` 仅用于首次安装，可按需另存。
   - Windows：NSIS `.exe`、`latest.yml`、对应的 `.blockmap`。
4. 最后上传 `latest-mac.yml` 与 `latest.yml`。这样客户端只会在安装包完整上传后看到新版。

> 不要把 R2 Access Key、Secret、Cloudflare API Token 或 GitHub Token 放入 `update-source.json`、应用代码或发布包。它们只应保存在 GitHub Actions Secrets。
