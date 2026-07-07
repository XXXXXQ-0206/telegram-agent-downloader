# Telegram Agent Downloader

<p align="right">
  <a href="README.zh-CN.md"><img alt="中文 README" src="https://img.shields.io/badge/README-%E4%B8%AD%E6%96%87-blue"></a>
</p>

Agent-friendly local Telegram media downloader powered by Playwright and a
cloned Microsoft Edge profile.

This tool is designed for local use: pass it a Telegram message link, and it
downloads the media that your logged-in Telegram Web session can already view.
It can run as a CLI for one-off jobs or as a tiny local HTTP service for agent
workflows.

## Features

- Downloads media from public Telegram message links.
- Supports logged-in Telegram Web downloads through a cloned Edge profile.
- Handles message albums with multiple photos or videos.
- Supports `https://t.me/<username>/<messageId>` and private
  `https://t.me/c/<channelId>/<messageId>` links.
- Uses message captions as filename bases when available.
- Provides a queued local HTTP API for automation.
- Keeps runtime browser data and downloaded files outside git.

## Requirements

- Windows
- Node.js 22 or newer
- Microsoft Edge
- A Telegram Web session already logged in inside Edge

## Install

```powershell
npm install
npm run bootstrap-profile
npm run probe
```

`bootstrap-profile` copies the selected Edge profile into
`runtime/edge-user-data`. This runtime directory can contain sensitive browser
session data and is intentionally ignored by git.

If you recently logged in to Telegram Web, close Edge before running
`bootstrap-profile` so cookies and session files can be copied cleanly.

## CLI Usage

Run without global linking:

```powershell
node src/tele.js https://t.me/example/123
```

Install local command aliases for development:

```powershell
npm link
tgdl https://t.me/example/123
```

Useful examples:

```powershell
tgdl https://t.me/example/123
tgdl --dir .\downloads\batch https://t.me/example/123 https://t.me/example/124
tgdl --json https://t.me/example/123
tgdl bootstrap-profile
tgdl probe
tgdl serve
```

Options:

- `--dir <path>`: download directory. Defaults to the project `downloads/`
  directory.
- `--filename <name>`: custom filename base for a single message link.
- `--timeout <ms>`: per-job timeout.
- `--json`: print machine-readable JSON.

Do not run multiple CLI downloads against the same `runtime/edge-user-data`
directory at the same time. Use the HTTP service when you need queueing.

## HTTP Service

Start the local service:

```powershell
npm start
```

The default address is `http://127.0.0.1:8787`.

Health check:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

Submit a download job:

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

Check a job:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/jobs/<job-id>
```

## Command Name, npm `@mrgoonie/tele-cli`, And PyPI `tgdl`

This repository is not the npm project installed with
`npm install -g @mrgoonie/tele-cli`, and it is not affiliated with that project
or its maintainers. This project includes `tgdl` and
`telegram-agent-downloader` as the preferred command names. It also keeps
`tele` as a convenience alias for local use.

This repository is also not the PyPI package `tgdl` listed at
`https://getsafety.com/packages/pypi/tgdl`, and it is not affiliated with that
package or its maintainers.

If you also use `@mrgoonie/tele-cli`, prefer one of these approaches:

- Use this project as `tgdl` or `telegram-agent-downloader`.
- Run this project directly with `node src/tele.js`.
- Keep `@mrgoonie/tele-cli`'s global `tele` command installed, and avoid
  relying on this project's `tele` alias.
- If a global `tele` command changes after `npm link` or global install, remove
  the link and use `tgdl` instead.

## Environment Variables

- `EDGE_EXECUTABLE_PATH`: Microsoft Edge executable path.
- `EDGE_USER_DATA_DIR`: Edge user-data directory. Defaults to the standard
  Windows Edge user-data location.
- `EDGE_PROFILE_DIR`: Edge profile directory to clone. Defaults to `Default`.
- `PORT`: HTTP port. Defaults to `8787`.
- `HEADLESS=0`: show the browser window for debugging.
- `JOB_TIMEOUT_MS`: per-job default timeout. Defaults to `900000`.

## Privacy And Clean Releases

The repository is meant to contain source code and documentation only. The
following files and directories must not be committed or published:

- `downloads/`
- `runtime/`
- `node_modules/`
- `.server.pid`
- `.env` files
- logs, browser caches, cookies, local storage, history, manifests, generated
  archives, and package tarballs

Before publishing a release, run:

```powershell
git status --short
git ls-files
npm pack --dry-run
```

`npm pack --dry-run` should only list source files and documentation. It should
not list downloaded media, Telegram saved-message manifests, Edge profile data,
absolute local paths, tokens, cookies, logs, browser history, favorites, or
account/session files.

## Disclaimer

This project is an unofficial local automation tool. It is not affiliated with
Telegram, Microsoft Edge, Playwright, the npm project installed with
`npm install -g @mrgoonie/tele-cli`, or the PyPI package `tgdl` listed at
`https://getsafety.com/packages/pypi/tgdl`.

Use it only for content you have the right, consent, and legal basis to access
and store. Do not use it for non-consensual, underage, exploitative,
copyright-infringing, or otherwise illegal content.

The software is provided as-is, without warranty. The authors and contributors
are not responsible for user-downloaded content, account restrictions,
terms-of-service violations, data loss, or any misuse of the tool.
