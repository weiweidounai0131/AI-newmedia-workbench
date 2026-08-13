# 自动更新发布说明

应用启动时会检查一次更新。发现新版本后，用户可以选择下载；下载完成后可立即重启安装，也可以在下次退出应用时安装。

## 一次性配置

1. 创建一个 Cloudflare R2 存储桶和一个阿里云 OSS Bucket，并分别配置 HTTPS 公开读取地址。Cloudflare 是优先节点，OSS 是国内自动兜底节点。
2. 本机调试时，将 `resources/update-source.example.json` 复制为 `resources/update-source.json`，分别填入 `url`（Cloudflare）和 `fallbackUrl`（OSS）。应用会先在 6 秒内探测 Cloudflare；超时或不可用则自动转到 OSS。下载过程若 Cloudflare 中断，也会自动从 OSS 重试。
3. 在 GitHub 私有仓库的 Actions Secrets 中保存下列值：
   - `UPDATE_SERVER_URL`：Cloudflare 公开读取地址。
   - `R2_ACCOUNT_ID`、`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`、`R2_BUCKET`：R2 上传凭据与桶名。
   - `ALIYUN_OSS_ACCESS_KEY_ID`、`ALIYUN_OSS_ACCESS_KEY_SECRET`、`ALIYUN_OSS_BUCKET`、`ALIYUN_OSS_REGION`：OSS 发布专用 RAM 用户凭据、桶名和地域。
   建议两个发布账号均只拥有对应更新桶的最小权限。

## 每次发布

1. 递增 `package.json` 的 `version`，例如从 `0.1.0` 改为 `0.1.1`。
2. 分别构建 macOS 和 Windows 安装包。
3. 上传构建产物中的下列文件到 Cloudflare R2 与阿里云 OSS 的同一目录根部：
   - macOS：`.zip`、`latest-mac.yml`、对应的 `.blockmap`；`.dmg` 仅用于首次安装，可按需另存。
   - Windows：NSIS `.exe`、`latest.yml`、对应的 `.blockmap`。
4. 最后上传 `latest-mac.yml` 与 `latest.yml`。这样客户端只会在安装包完整上传后看到新版；两个节点必须保持同一版本。

> 不要把 R2 Access Key、Secret、Cloudflare API Token 或 GitHub Token 放入 `update-source.json`、应用代码或发布包。它们只应保存在 GitHub Actions Secrets。
