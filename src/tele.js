#!/usr/bin/env node

const path = require("path");

const config = require("./config");
const { BrowserController } = require("./browserController");
const { cloneEdgeProfile } = require("./edgeProfile");
const {
  waitForTelegramLogin,
  downloadMediaByMessageLink,
  downloadSavedMessagesMedia,
} = require("./telegramDownloader");

function printUsage() {
  const invokedName = path.basename(process.argv[1] || "", path.extname(process.argv[1] || ""));
  const commandName = ["tgdl", "telegram-agent-downloader", "tele"].includes(invokedName)
    ? invokedName
    : "tgdl";

  console.log(`Usage:
  ${commandName} <telegram-message-url> [more-urls...]
  ${commandName} --dir <download-dir> <telegram-message-url> [more-urls...]
  ${commandName} saved-messages
  ${commandName} bootstrap-profile
  ${commandName} probe
  ${commandName} serve

Options:
  --dir <path>        Download directory. Default: ${config.downloadsRoot}
                      For saved-messages: Default is ${path.join(config.downloadsRoot, "saved-messages")}
  --filename <name>   Force a filename. Only valid when downloading a single URL.
  --timeout <ms>      Per-job timeout in milliseconds. Default: ${config.jobTimeoutMs}
  --json              Print machine-readable JSON.
  --help              Show this help.

Command aliases:
  tgdl, telegram-agent-downloader, tele`);
}

function parseArgs(argv) {
  const parsed = {
    command: "",
    urls: [],
    downloadDir: "",
    filename: "",
    timeoutMs: config.jobTimeoutMs,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      parsed.command = "help";
      return parsed;
    }

    if (arg === "--json") {
      parsed.json = true;
      continue;
    }

    if (arg === "--dir") {
      parsed.downloadDir = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--filename") {
      parsed.filename = argv[index + 1] || "";
      index += 1;
      continue;
    }

    if (arg === "--timeout") {
      const rawTimeout = argv[index + 1] || "";
      const parsedTimeout = Number.parseInt(rawTimeout, 10);
      if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error(`Invalid --timeout value: ${rawTimeout || "(empty)"}`);
      }

      parsed.timeoutMs = parsedTimeout;
      index += 1;
      continue;
    }

    if (!parsed.command && ["bootstrap-profile", "probe", "serve", "saved-messages", "saved"].includes(arg)) {
      parsed.command = arg;
      continue;
    }

    parsed.urls.push(arg.trim());
  }

  if (!parsed.command) {
    parsed.command = parsed.urls.length ? "download" : "help";
  }

  if (parsed.filename && parsed.urls.length > 1) {
    throw new Error("--filename can only be used with a single URL.");
  }

  if (parsed.filename && ["saved-messages", "saved"].includes(parsed.command)) {
    throw new Error("--filename is not supported for saved-messages export.");
  }

  return parsed;
}

function getSavedFiles(result) {
  if (Array.isArray(result?.savedFiles) && result.savedFiles.length) {
    return result.savedFiles;
  }

  if (result?.savedTo) {
    return [result.savedTo];
  }

  return [];
}

async function runProbe({ json }) {
  const browser = new BrowserController();
  try {
    const page = await browser.getPage();
    const result = await waitForTelegramLogin(page);
    if (json) {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
      return;
    }

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

async function runDownloads({ urls, downloadDir, filename, timeoutMs, json }) {
  if (!urls.length) {
    throw new Error("At least one Telegram message URL is required.");
  }

  let browser = null;
  const results = [];

  const getPage = async () => {
    if (!browser) {
      browser = new BrowserController();
    }

    return browser.getPage();
  };

  try {
    for (let index = 0; index < urls.length; index += 1) {
      const url = urls[index];
      if (!json) {
        console.error(`[${index + 1}/${urls.length}] ${url}`);
      }

      const result = await downloadMediaByMessageLink(
        {
          url,
          downloadDir,
          filename,
          timeoutMs,
        },
        { getPage },
      );

      results.push({
        ok: true,
        url,
        result,
      });

      if (!json) {
        const savedFiles = getSavedFiles(result);
        console.error(`saved ${savedFiles.length} file(s)`);
        for (const savedFile of savedFiles) {
          console.error(`  -> ${savedFile}`);
        }
      }
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, results }, null, 2));
    return;
  }

  for (const item of results) {
    for (const savedFile of getSavedFiles(item.result)) {
      console.log(savedFile);
    }
  }
}

async function runSavedMessagesExport({ downloadDir, timeoutMs, json }) {
  let browser = null;

  const getPage = async () => {
    if (!browser) {
      browser = new BrowserController();
    }

    return browser.getPage();
  };

  try {
    if (!json) {
      console.error("exporting Saved Messages media...");
    }

    const result = await downloadSavedMessagesMedia(
      {
        downloadDir,
        timeoutMs,
      },
      { getPage },
    );

    if (json) {
      console.log(JSON.stringify({ ok: true, result }, null, 2));
      return;
    }

    const savedFiles = getSavedFiles(result);
    console.error(`saved ${savedFiles.length} file(s) from Saved Messages`);
    if (result.failures?.length) {
      console.error(`failed ${result.failures.length} item(s)`);
    }
    for (const savedFile of savedFiles) {
      console.log(savedFile);
    }
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help") {
    printUsage();
    return;
  }

  if (args.command === "bootstrap-profile") {
    const result = await cloneEdgeProfile();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (args.command === "probe") {
    await runProbe(args);
    return;
  }

  if (args.command === "serve") {
    require("./server");
    return;
  }

  if (args.command === "saved-messages" || args.command === "saved") {
    await runSavedMessagesExport(args);
    return;
  }

  await runDownloads(args);
}

run().catch((error) => {
  const wantsJson = process.argv.includes("--json");
  const message = error instanceof Error ? error.message : String(error);

  if (wantsJson) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: message,
        },
        null,
        2,
      ),
    );
  } else {
    console.error(message);
  }

  process.exit(1);
});
