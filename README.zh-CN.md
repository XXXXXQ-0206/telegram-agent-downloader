# Telegram Agent Downloader

<p align="right">
  <a href="README.md"><img alt="English README" src="https://img.shields.io/badge/README-English-blue"></a>
</p>

一个适合 agent 调用的本地 Telegram 媒体下载工具，基于 Playwright 和克隆出来的 Microsoft Edge profile。

这个工具面向本地使用：把 Telegram 消息链接传给它，它会下载你当前 Telegram Web 登录态本来就能查看的媒体。你可以把它当作一次性 CLI 工具使用，也可以启动一个很轻量的本地 HTTP 服务，交给 agent 或脚本调度。

## 功能

- 下载公开 Telegram 消息链接里的媒体。
- 通过克隆的 Edge profile 下载需要登录才能访问的媒体。
- 支持一条消息里包含多张图片或多个视频的相册。
- 支持 `https://t.me/<username>/<messageId>` 和私有 `https://t.me/c/<channelId>/<messageId>` 链接。
- 能在可用时把消息正文作为文件名基础。
- 提供带队列的本地 HTTP API，便于自动化调用。
- 默认把浏览器运行数据和下载文件排除在 git 之外。

## 要求

- Windows
- Node.js 22 或更新版本
- Microsoft Edge
- Edge 里已经登录过 Telegram Web

## 安装

```powershell
npm install
npm run bootstrap-profile
npm run probe
```

`bootstrap-profile` 会把选中的 Edge profile 复制到 `runtime/edge-user-data`。这个运行目录可能包含敏感的浏览器会话数据，因此已被 git 忽略。

如果你刚登录过 Telegram Web，建议先关闭 Edge，再运行 `bootstrap-profile`，这样 cookie 和会话文件更容易完整复制。

## CLI 用法

不安装全局命令，直接运行：

```powershell
node src/tele.js https://t.me/example/123
```

开发时安装本地命令别名：

```powershell
npm link
tgdl https://t.me/example/123
```

常用示例：

```powershell
tgdl https://t.me/example/123
tgdl --dir .\downloads\batch https://t.me/example/123 https://t.me/example/124
tgdl --json https://t.me/example/123
tgdl bootstrap-profile
tgdl probe
tgdl serve
```

参数：

- `--dir <path>`：下载目录。默认使用项目里的 `downloads/` 目录。
- `--filename <name>`：为单条消息指定文件名基础。
- `--timeout <ms>`：单个任务的超时时间。
- `--json`：输出机器可读 JSON。

不要同时启动多个 CLI 下载进程去使用同一个 `runtime/edge-user-data` 目录。需要排队时，请使用 HTTP 服务。

## HTTP 服务

启动本地服务：

```powershell
npm start
```

默认地址是 `http://127.0.0.1:8787`。

健康检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

提交下载任务：

```powershell
$body = @{
  url = "https://t.me/example/123"
  downloadDir = ".\\downloads"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8787/download `
  -ContentType "application/json" `
  -Body $body
```

查询任务：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/jobs/<job-id>
```

## 命令名、npm 的 `tele` 与 PyPI 的 `tgdl`

这个仓库不是 npm 上名为 `tele` 的那个包，也与它没有关联。本项目推荐使用 `tgdl` 或 `telegram-agent-downloader` 作为命令名，同时保留 `tele` 作为本地使用时的方便别名。

这个仓库也不是 Safety 页面 `https://getsafety.com/packages/pypi/tgdl` 所列的 PyPI `tgdl` 包，并且与该包及其维护者没有关联。

如果你还需要使用另一个会安装 `tele` 命令的 npm 包，可以这样处理：

- 使用本项目的 `tgdl` 或 `telegram-agent-downloader` 命令。
- 直接运行 `node src/tele.js`。
- 保留另一个包全局安装的 `tele` 命令，不依赖本项目的 `tele` 别名。
- 如果执行 `npm link` 或全局安装后，系统里的 `tele` 命令被替换，可以移除链接，改用 `tgdl`。

## 环境变量

- `EDGE_EXECUTABLE_PATH`：Microsoft Edge 可执行文件路径。
- `EDGE_USER_DATA_DIR`：Edge 用户数据目录。默认使用 Windows 标准 Edge 用户数据路径。
- `EDGE_PROFILE_DIR`：要克隆的 Edge profile 目录。默认是 `Default`。
- `PORT`：HTTP 端口。默认是 `8787`。
- `HEADLESS=0`：显示浏览器窗口，便于调试。
- `JOB_TIMEOUT_MS`：单任务默认超时时间。默认是 `900000`。

## 隐私与干净发布

仓库只应该包含源码和文档。以下文件和目录不要提交，也不要发布：

- `downloads/`
- `runtime/`
- `node_modules/`
- `.server.pid`
- `.env` 文件
- 日志、浏览器缓存、cookie、本地存储、历史记录、清单、生成的压缩包和 package tarball

发布前建议运行：

```powershell
git status --short
git ls-files
npm pack --dry-run
```

`npm pack --dry-run` 应该只列出源码和文档。不应出现下载的媒体、Telegram Saved Messages 清单、Edge profile 数据、本机绝对路径、token、cookie、日志、浏览器历史、收藏夹或账号会话文件。

## 免责声明

本项目是非官方的本地自动化工具，不隶属于 Telegram、Microsoft Edge、Playwright，也不是 npm 上名为 `tele` 的包，更不是 Safety 页面 `https://getsafety.com/packages/pypi/tgdl` 所列的 PyPI `tgdl` 包。

请只把它用于你有权访问、有权保存，并且符合法律与同意要求的内容。不要把它用于非自愿、未成年人、剥削性、侵权或其他违法内容。

本软件按原样提供，不作任何担保。作者和贡献者不对用户下载的内容、账号限制、服务条款违规、数据丢失或任何误用负责。
