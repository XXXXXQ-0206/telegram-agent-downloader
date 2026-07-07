const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const config = require("./config");
const { ensureAbsoluteDir, ensureDir, sanitizeFilename, sleep } = require("./utils");

const execFileAsync = promisify(execFile);
const MAX_FILENAME_BASE_LENGTH = 96;
const WEBK_URL = "https://webk.telegram.org/";
const WEBK_MESSAGE_ID_OFFSET = 4294967296n;
const SAVED_MESSAGES_MANIFEST_NAME = ".saved-messages-manifest.json";

const LOGIN_HINTS = [
  /log in to telegram/i,
  /log in by qr/i,
  /sign in to telegram/i,
  /scan from mobile/i,
  /link desktop device/i,
  /log in by phone number/i,
];

function parseTelegramMessageUrl(rawUrl) {
  const url = new URL(rawUrl);
  const segments = url.pathname.split("/").filter(Boolean);
  let peer = null;
  let messageIdCandidate = segments.at(-1);
  let isPublicChannelPost = false;
  let publicMirrorUrl = null;
  let webkPeerId = null;

  if (segments[0] === "s" && segments.length >= 3) {
    peer = segments[1];
    messageIdCandidate = segments[2];
    isPublicChannelPost = true;
    publicMirrorUrl = `https://t.me/s/${peer}/${messageIdCandidate}`;
  } else if (segments[0] === "c" && segments.length >= 3) {
    peer = `c/${segments[1]}`;
    messageIdCandidate = segments[2];
    webkPeerId = -Number.parseInt(segments[1], 10);
  } else if (segments.length >= 2) {
    peer = segments[0];
    messageIdCandidate = segments[1];
    isPublicChannelPost = true;
    publicMirrorUrl = `https://t.me/s/${peer}/${messageIdCandidate}`;
  }

  const messageId = Number.parseInt(messageIdCandidate || "", 10);

  if (!peer || !Number.isInteger(messageId) || (peer.startsWith("c/") && !Number.isFinite(webkPeerId))) {
    throw new Error(`Could not parse Telegram message id from URL: ${rawUrl}`);
  }

  return {
    originalUrl: rawUrl,
    host: url.host,
    pathname: url.pathname,
    peer,
    messageId,
    isPublicChannelPost,
    publicMirrorUrl,
    webkPeerId,
  };
}

async function waitForTelegramLogin(page) {
  await page.goto(WEBK_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await sleep(5000);

  const state = await page.evaluate(() => {
    const bodyText = document.body?.innerText || "";
    const normalized = bodyText.replace(/\s+/g, " ").trim();

    return {
      bodySnippet: normalized.slice(0, 400),
      host: window.location.host,
      hash: window.location.hash,
      hasAppImManager: typeof window.appImManager?.openUsername === "function",
    };
  });
  const looksLoggedOut = LOGIN_HINTS.some((pattern) => pattern.test(state.bodySnippet));

  return {
    url: page.url(),
    title: await page.title(),
    bodySnippet: state.bodySnippet,
    host: state.host,
    locationHash: state.hash,
    hasAppImManager: state.hasAppImManager,
    loggedIn: state.hasAppImManager && !looksLoggedOut,
  };
}

function stripHtmlTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
}

function decodeHtmlText(value) {
  const namedEntities = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();

    if (normalized[0] === "#") {
      const isHex = normalized[1] === "x";
      const raw = isHex ? normalized.slice(2) : normalized.slice(1);
      const codePoint = Number.parseInt(raw, isHex ? 16 : 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }

    return Object.prototype.hasOwnProperty.call(namedEntities, normalized)
      ? namedEntities[normalized]
      : match;
  });
}

function normalizeCaptionText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateFilenameBase(filenameBase, maxLength = MAX_FILENAME_BASE_LENGTH) {
  const chars = Array.from(filenameBase);
  if (chars.length <= maxLength) {
    return filenameBase;
  }

  return chars.slice(0, maxLength).join("").trim();
}

function buildCaptionFilename(captionText, fallbackFilename) {
  const fallbackExtension = path.extname(fallbackFilename) || ".mp4";
  const fallbackBase = path.basename(fallbackFilename, fallbackExtension);

  if (!captionText) {
    return sanitizeFilename(`${fallbackBase}${fallbackExtension}`);
  }

  const sanitizedCaption = sanitizeFilename(captionText);
  const trimmedCaption = truncateFilenameBase(sanitizedCaption || fallbackBase);
  const base = trimmedCaption || fallbackBase;
  return sanitizeFilename(`${base}${fallbackExtension}`);
}

async function resolveTargetPath(downloadDir, filename) {
  const parsed = path.parse(filename);
  const safeBaseName = parsed.name || `telegram-media-${Date.now()}`;
  const safeExtension = parsed.ext || ".bin";

  let attempt = 0;
  while (true) {
    const candidateName =
      attempt === 0
        ? `${safeBaseName}${safeExtension}`
        : `${safeBaseName} (${attempt + 1})${safeExtension}`;
    const candidatePath = path.join(downloadDir, candidateName);

    try {
      await fs.promises.access(candidatePath);
      attempt += 1;
    } catch {
      return candidatePath;
    }
  }
}

async function waitForMessageBubble(page, messageId, timeoutMs) {
  const candidateIds = [
    String(messageId),
    (WEBK_MESSAGE_ID_OFFSET + BigInt(messageId)).toString(),
  ];
  let lastError = null;

  for (const candidateId of candidateIds) {
    const bubble = page.locator(`div.bubble[data-mid="${candidateId}"]`).first();
    try {
      await bubble.waitFor({ state: "visible", timeout: timeoutMs });
      return bubble;
    } catch (error) {
      lastError = error;
    }

    const groupedItem = page.locator(`.album-item.grouped-item[data-mid="${candidateId}"]`).first();
    try {
      await groupedItem.waitFor({ state: "visible", timeout: timeoutMs });
      const groupedBubble = groupedItem.locator(
        "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' bubble ')][1]",
      );
      await groupedBubble.waitFor({ state: "visible", timeout: timeoutMs });
      return groupedBubble;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error(`Message bubble ${messageId} was not found.`);
}

async function savePlaywrightDownload(download, downloadDir, preferredFilename) {
  const suggested = preferredFilename || download.suggestedFilename();
  const filename = sanitizeFilename(suggested || `telegram-media-${Date.now()}.bin`);
  const targetPath = await resolveTargetPath(downloadDir, filename);
  await download.saveAs(targetPath);
  return targetPath;
}

async function runPowerShell(command, env = {}) {
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", command],
    {
      env: {
        ...process.env,
        ...env,
      },
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  return stdout;
}

function decodeHtmlAttribute(value) {
  return decodeHtmlText(value);
}

function extensionFromMimeType(mimeType, fallbackExtension) {
  const normalized = String(mimeType || "").toLowerCase();
  if (!normalized) {
    return fallbackExtension;
  }

  const mappedExtensions = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
  };

  return mappedExtensions[normalized] || fallbackExtension;
}

function extensionFromFilename(filename, fallbackExtension) {
  const extension = path.extname(String(filename || ""));
  return extension || fallbackExtension;
}

function extensionFromUrl(value, fallbackExtension) {
  if (!value) {
    return fallbackExtension;
  }

  try {
    const extension = path.extname(new URL(value).pathname);
    return extension || fallbackExtension;
  } catch {
    return fallbackExtension;
  }
}

function buildMediaFilename(target, preferredFilename, captionText, fallbackBase, extension, index, total) {
  const safeExtension = extension || ".bin";
  let baseName = "";

  if (preferredFilename) {
    baseName = path.parse(sanitizeFilename(preferredFilename)).name;
  } else if (captionText) {
    baseName = path.parse(buildCaptionFilename(captionText, `${fallbackBase}${safeExtension}`)).name;
  } else {
    baseName = path.parse(sanitizeFilename(`${fallbackBase}${safeExtension}`)).name;
  }

  const suffix =
    total > 1
      ? ` - ${String(index + 1).padStart(String(total).length, "0")}`
      : "";
  const finalBaseName = truncateFilenameBase(baseName || fallbackBase);
  return sanitizeFilename(`${finalBaseName}${suffix}${safeExtension}`);
}

function summarizeDownloadResult({ mode, finalUrl, captionText, items }) {
  if (!items.length) {
    throw new Error("No media files were downloaded.");
  }

  const uniqueKinds = Array.from(new Set(items.map((item) => item.kind)));
  const kind =
    uniqueKinds.length === 1
      ? uniqueKinds[0]
      : "mixed";

  return {
    kind,
    mode,
    savedTo: items[0].savedTo,
    savedFiles: items.map((item) => item.savedTo),
    mediaCount: items.length,
    finalUrl,
    captionText,
    items,
  };
}

function extractPublicPostHtml(html, target) {
  const anchor = `data-post="${target.peer}/${target.messageId}"`;
  const anchorIndex = html.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`Target post ${target.peer}/${target.messageId} was not found on the public page.`);
  }

  const nextAnchorIndex = html.indexOf('data-post="', anchorIndex + anchor.length);
  return html.slice(
    anchorIndex,
    nextAnchorIndex === -1 ? Math.min(html.length, anchorIndex + 60000) : nextAnchorIndex,
  );
}

function extractPublicCaptionText(postHtml) {
  const messageTextMatch = postHtml.match(
    /<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/i,
  );

  if (!messageTextMatch) {
    return "";
  }

  const htmlText = stripHtmlTags(messageTextMatch[1]);
  return normalizeCaptionText(decodeHtmlText(htmlText));
}

function extractPublicMediaItems(postHtml, target) {
  const items = [];
  const seen = new Set();

  const addItem = (kind, sourceUrl, fallbackExtension) => {
    if (!sourceUrl || seen.has(sourceUrl)) {
      return;
    }

    seen.add(sourceUrl);
    items.push({
      kind,
      sourceUrl,
      extension: extensionFromUrl(sourceUrl, fallbackExtension),
    });
  };

  for (const match of postHtml.matchAll(/<video[^>]+src="([^"]+)"/gi)) {
    addItem("video", decodeHtmlAttribute(match[1]), ".mp4");
  }

  for (const match of postHtml.matchAll(
    /<(?:a|div)[^>]+(?:tgme_widget_message_photo_wrap|tgme_widget_message_grouped_item)[^>]+style="[^"]*background-image:url\('([^']+)'\)/gi,
  )) {
    addItem("image", decodeHtmlAttribute(match[1]), ".jpg");
  }

  if (!items.length) {
    throw new Error(`Target post ${target.peer}/${target.messageId} does not expose any public media source.`);
  }

  return items;
}

async function fetchPublicTelegramPageHtml(url) {
  return runPowerShell(
    "$ProgressPreference='SilentlyContinue';" +
      "$wc = New-Object System.Net.WebClient;" +
      "$wc.Headers['User-Agent'] = 'Mozilla/5.0';" +
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;" +
      "Write-Output ($wc.DownloadString($env:DOWNLOAD_URL))",
    {
      DOWNLOAD_URL: url,
    },
  );
}

async function saveDirectDownloadToFile(sourceUrl, targetPath) {
  await runPowerShell(
    "$ProgressPreference='SilentlyContinue';" +
      "$wc = New-Object System.Net.WebClient;" +
      "$wc.Headers['User-Agent'] = 'Mozilla/5.0';" +
      "$wc.DownloadFile($env:DOWNLOAD_URL, $env:DOWNLOAD_OUT)",
    {
      DOWNLOAD_URL: sourceUrl,
      DOWNLOAD_OUT: targetPath,
    },
  );
}

async function downloadPublicTelegramVideo(target, job, downloadDir) {
  if (!target.publicMirrorUrl) {
    throw new Error("This message URL cannot be mapped to a public Telegram mirror page.");
  }

  const html = await fetchPublicTelegramPageHtml(target.publicMirrorUrl);
  const postHtml = extractPublicPostHtml(html, target);
  const captionText = extractPublicCaptionText(postHtml);
  const mediaItems = extractPublicMediaItems(postHtml, target);
  const fallbackBase = `telegram-${sanitizeFilename(target.peer.replace(/\//g, "-"))}-${target.messageId}`;
  const downloadedItems = [];

  for (let index = 0; index < mediaItems.length; index += 1) {
    const item = mediaItems[index];
    const filename = buildMediaFilename(
      target,
      job.filename,
      captionText,
      fallbackBase,
      item.extension,
      index,
      mediaItems.length,
    );
    const savedTo = await resolveTargetPath(downloadDir, filename);
    await saveDirectDownloadToFile(item.sourceUrl, savedTo);

    downloadedItems.push({
      index: index + 1,
      kind: item.kind,
      sourceUrl: item.sourceUrl,
      suggestedFilename: filename,
      savedTo,
    });
  }

  return summarizeDownloadResult({
    mode: "public-direct",
    finalUrl: target.publicMirrorUrl,
    captionText,
    items: downloadedItems,
  });
}

async function extractBubbleCaptionText(bubble) {
  return bubble.evaluate((node) => {
    const selectors = [
      ".translatable-message",
      ".text-content",
      ".message .text-content",
      ".bubble-content .text-content",
      ".media-caption",
      ".message",
      ".bubble-content [dir='auto']",
    ];

    for (const selector of selectors) {
      const element = node.querySelector(selector);
      const text = element?.textContent?.replace(/\s+/g, " ").trim();
      if (text) {
        return text;
      }
    }

    return "";
  });
}

function parseTelegramStreamMetadata(rawSourceUrl) {
  if (!rawSourceUrl) {
    return null;
  }

  try {
    const normalized = new URL(rawSourceUrl, WEBK_URL);
    if (!normalized.pathname.startsWith("/stream/")) {
      return null;
    }

    const encodedPayload = normalized.pathname.slice("/stream/".length);
    return JSON.parse(decodeURIComponent(encodedPayload));
  } catch {
    return null;
  }
}

async function ensureWebkReady(page, timeoutMs) {
  const readyTimeoutMs = Math.min(timeoutMs, 60000);

  await page.goto(WEBK_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForFunction(() => typeof window.appImManager?.openUsername === "function", {
    timeout: readyTimeoutMs,
  });
}

async function openTelegramMessageInWebk(page, target, timeoutMs) {
  await ensureWebkReady(page, timeoutMs);

  const opened = target.peer.startsWith("c/")
    ? await page.evaluate(
        async ({ peerId, lastMsgId }) => {
          try {
            await window.appImManager.setInnerPeer({
              peerId,
              lastMsgId,
            });
            return {
              ok: true,
            };
          } catch (error) {
            const rawMessage =
              error?.message ||
              error?.originalError?.error_message ||
              error?.type ||
              String(error);
            return {
              ok: false,
              error: rawMessage,
            };
          }
        },
        {
          peerId: target.webkPeerId,
          lastMsgId: target.messageId,
        },
      )
    : await page.evaluate(
        async ({ userName, lastMsgId }) => {
          try {
            await window.appImManager.openUsername({ userName, lastMsgId });
            return {
              ok: true,
            };
          } catch (error) {
            const rawMessage =
              error?.message ||
              error?.originalError?.error_message ||
              error?.type ||
              String(error);
            return {
              ok: false,
              error: rawMessage,
            };
          }
        },
        {
          userName: target.peer,
          lastMsgId: target.messageId,
        },
      );

  if (!opened?.ok) {
    if (target.peer.startsWith("c/")) {
      throw new Error(`Unable to open Telegram private channel "${target.peer}": ${opened?.error || "unknown error"}`);
    }

    throw new Error(`Unable to open Telegram username "${target.peer}": ${opened?.error || "unknown error"}`);
  }
  await sleep(3000);
}

async function detectRestrictedChannelPlaceholder(page) {
  return page.evaluate(() => {
    const placeholder = document.querySelector(
      "div.bubble.empty-bubble-placeholder-restricted, div.bubble[data-mid='0']",
    );
    if (!placeholder) {
      return {
        blocked: false,
        reason: "",
      };
    }

    const text = (placeholder.textContent || "").replace(/\s+/g, " ").trim();
    if (!text) {
      return {
        blocked: false,
        reason: "",
      };
    }

    const isRestricted =
      /can't be displayed|can’t be displayed|violated telegram's terms of service|pornographic content/i.test(
        text,
      ) ||
      placeholder.classList.contains("empty-bubble-placeholder-restricted");

    return {
      blocked: isRestricted,
      reason: text,
    };
  });
}

async function inspectWebkBubbleMediaLayout(bubble) {
  return bubble.evaluate((node) => {
    const albumItems = Array.from(node.querySelectorAll(".album-item.grouped-item"));
    return {
      albumItemCount: albumItems.length,
      hasGroupedAlbum: albumItems.length > 0,
      hasAlbumVideoPlaceholders: albumItems.some((item) => item.querySelector("button.video-play")),
    };
  });
}

async function extractWebkInlineMediaItems(bubble) {
  return bubble.evaluate((node) => {
    const uniqueItems = [];
    const seenSources = new Set();
    const mediaElements = Array.from(node.querySelectorAll("video.media-video, img.media-photo"));

    for (const element of mediaElements) {
      const isVideo = element.matches("video.media-video");
      const container =
        element.closest(".grouped-item, .album-item, .attachment, .media-container") || element.parentElement;

      if (!isVideo && container?.querySelector("video.media-video")) {
        continue;
      }

      const sourceCandidates = isVideo
        ? [
            element.currentSrc,
            element.getAttribute("src"),
            ...Array.from(element.querySelectorAll("source"))
              .map((child) => child.getAttribute("src"))
              .filter(Boolean),
          ]
        : [element.currentSrc, element.getAttribute("src")];
      const sourceUrl = sourceCandidates.find(Boolean) || "";

      if (!sourceUrl || seenSources.has(sourceUrl)) {
        continue;
      }

      seenSources.add(sourceUrl);
      uniqueItems.push({
        kind: isVideo ? "video" : "image",
        sourceUrl,
        width: isVideo ? element.videoWidth || 0 : element.naturalWidth || 0,
        height: isVideo ? element.videoHeight || 0 : element.naturalHeight || 0,
      });
    }

    return uniqueItems;
  });
}

async function openWebkAlbumItemInViewer(page, bubble, index, timeoutMs) {
  const item = bubble.locator(".album-item.grouped-item").nth(index);
  await openWebkMediaLocatorInViewer(page, item, `Album item ${index + 1}`, timeoutMs);
}

async function openWebkMediaLocatorInViewer(page, locator, description, timeoutMs) {
  const media = locator.locator(".album-item-media, .media-container, img, video, button.video-play").first();
  const attemptTimeoutMs = Math.min(timeoutMs, 4000);

  const waitForViewerOpen = async () => {
    try {
      await page.waitForFunction(() => !!document.querySelector(".media-viewer-whole.active"), {
        timeout: attemptTimeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  };

  const strategies = [
    async () => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      if (!box) {
        throw new Error(`${description} is not visible and could not be opened.`);
      }

      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        delay: 50,
      });
    },
    async () => {
      await media.click({
        force: true,
        timeout: attemptTimeoutMs,
      });
    },
    async () => {
      await locator.evaluate((node) => {
        const target =
          node.querySelector(".album-item-media, button.video-play, img, video") || node;
        const fire = (type) =>
          target.dispatchEvent(
            new MouseEvent(type, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
          );

        fire("pointerdown");
        fire("mousedown");
        fire("pointerup");
        fire("mouseup");
        fire("click");
      });
    },
  ];

  for (const strategy of strategies) {
    await strategy();
    if (await waitForViewerOpen()) {
      return;
    }
  }

  throw new Error(`${description} could not be opened in Telegram viewer.`);
}

async function waitForActiveMediaViewer(page, timeoutMs) {
  const viewer = page.locator(".media-viewer-whole.active");
  await viewer.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    () => {
      const activeViewer = document.querySelector(".media-viewer-whole.active");
      if (!activeViewer) {
        return false;
      }

       const activeMover =
         activeViewer.querySelector(".media-viewer-mover.active") ||
         activeViewer.querySelector(".media-viewer-aspecter") ||
         activeViewer;

      const hasVideo = Array.from(activeMover.querySelectorAll("video")).some((video) => {
        const sourceCandidates = [
          video.currentSrc,
          video.getAttribute("src"),
          ...Array.from(video.querySelectorAll("source"))
            .map((child) => child.getAttribute("src"))
            .filter(Boolean),
        ];
        return sourceCandidates.some(Boolean);
      });
      if (hasVideo) {
        return true;
      }

      return Array.from(activeMover.querySelectorAll("img")).some((image) => {
        if (image.classList.contains("avatar-photo")) {
          return false;
        }

        const sourceUrl = image.currentSrc || image.getAttribute("src") || "";
        if (!sourceUrl) {
          return false;
        }

        return (image.naturalWidth || 0) >= 32 || (image.naturalHeight || 0) >= 32;
      });
    },
    { timeout: timeoutMs },
  );

  return viewer;
}

async function extractActiveViewerMediaItem(page) {
  return page.evaluate(() => {
    const activeViewer = document.querySelector(".media-viewer-whole.active");
    if (!activeViewer) {
      return null;
    }

    const activeMover =
      activeViewer.querySelector(".media-viewer-mover.active") ||
      activeViewer.querySelector(".media-viewer-aspecter") ||
      activeViewer;

    const videos = Array.from(activeMover.querySelectorAll("video"))
      .map((video) => {
        const sourceCandidates = [
          video.currentSrc,
          video.getAttribute("src"),
          ...Array.from(video.querySelectorAll("source"))
            .map((child) => child.getAttribute("src"))
            .filter(Boolean),
        ];
        const sourceUrl = sourceCandidates.find(Boolean) || "";
        return {
          kind: "video",
          sourceUrl,
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          score: (video.videoWidth || 0) * (video.videoHeight || 0),
        };
      })
      .filter((item) => item.sourceUrl);

    if (videos.length) {
      videos.sort((left, right) => right.score - left.score);
      const selected = videos[0];
      return {
        kind: selected.kind,
        sourceUrl: selected.sourceUrl,
        width: selected.width,
        height: selected.height,
      };
    }

    const images = Array.from(activeMover.querySelectorAll("img"))
      .filter((image) => !image.classList.contains("avatar-photo"))
      .map((image) => {
        const sourceUrl = image.currentSrc || image.getAttribute("src") || "";
        const width = image.naturalWidth || image.width || 0;
        const height = image.naturalHeight || image.height || 0;
        return {
          kind: "image",
          sourceUrl,
          width,
          height,
          score: width * height,
        };
      })
      .filter((item) => item.sourceUrl && item.score > 0);

    if (!images.length) {
      return null;
    }

    images.sort((left, right) => right.score - left.score);
    const selected = images[0];
    return {
      kind: selected.kind,
      sourceUrl: selected.sourceUrl,
      width: selected.width,
      height: selected.height,
    };
  });
}

async function closeActiveMediaViewer(page, timeoutMs) {
  const viewer = page.locator(".media-viewer-whole.active");
  if (!(await viewer.count())) {
    return;
  }

  await page.keyboard.press("Escape");
  await viewer.waitFor({ state: "hidden", timeout: timeoutMs });
}

async function triggerPageBlobDownload(page, absoluteUrl, requestedFilename, timeoutMs) {
  const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
  const metadataPromise = page.evaluate(
    async ({ url, filename }) => {
      const TELEGRAM_STREAM_CHUNK_SIZE = 8 * 1024 * 1024;
      const TELEGRAM_STREAM_PROBE_SIZE = 1024 * 1024;

      const parseContentRangeTotal = (contentRange) => {
        const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(contentRange || "");
        return match ? Number.parseInt(match[1], 10) : 0;
      };

      const parseTelegramStreamSize = (rawUrl) => {
        try {
          const normalizedUrl = new URL(rawUrl, window.location.href);
          if (!normalizedUrl.pathname.startsWith("/stream/")) {
            return 0;
          }

          const encodedPayload = normalizedUrl.pathname.slice("/stream/".length);
          const payload = JSON.parse(decodeURIComponent(encodedPayload));
          const size = Number.parseInt(String(payload?.size || 0), 10);
          return Number.isFinite(size) && size > 0 ? size : 0;
        } catch {
          return 0;
        }
      };

      const fetchCompleteBlob = async () => {
        const normalizedUrl = new URL(url, window.location.href);
        const isTelegramStream = normalizedUrl.pathname.startsWith("/stream/");

        if (!isTelegramStream) {
          const response = await fetch(url, { credentials: "include" });
          if (!response.ok) {
            throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
          }

          return response.blob();
        }

        const initialRange = `bytes=0-${TELEGRAM_STREAM_PROBE_SIZE - 1}`;
        const firstResponse = await fetch(url, {
          credentials: "include",
          headers: { Range: initialRange },
        });
        if (!firstResponse.ok && firstResponse.status !== 206) {
          throw new Error(`fetch failed: ${firstResponse.status} ${firstResponse.statusText}`);
        }

        const contentType = firstResponse.headers.get("content-type") || "application/octet-stream";
        const totalSize =
          parseTelegramStreamSize(url) || parseContentRangeTotal(firstResponse.headers.get("content-range"));
        const firstChunk = await firstResponse.arrayBuffer();

        if (!totalSize || firstResponse.status !== 206 || firstChunk.byteLength >= totalSize) {
          return new Blob([firstChunk], { type: contentType });
        }

        const chunks = [firstChunk];
        const chunkSize = Math.max(firstChunk.byteLength || 0, TELEGRAM_STREAM_CHUNK_SIZE);

        for (let start = firstChunk.byteLength; start < totalSize;) {
          const end = Math.min(totalSize - 1, start + chunkSize - 1);
          const response = await fetch(url, {
            credentials: "include",
            headers: { Range: `bytes=${start}-${end}` },
          });
          if (!response.ok && response.status !== 206) {
            throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
          }

          const chunk = await response.arrayBuffer();
          if (!chunk.byteLength) {
            throw new Error("fetch returned an empty chunk");
          }

          chunks.push(chunk);
          start += chunk.byteLength;
        }

        return new Blob(chunks, { type: contentType });
      };

      const blob = await fetchCompleteBlob();
      if (!blob.size) {
        throw new Error("fetch returned an empty blob");
      }

      const objectUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = objectUrl;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
      }

      return {
        blobSize: blob.size,
        blobType: blob.type,
      };
    },
    {
      url: absoluteUrl,
      filename: requestedFilename,
    },
  );
  const [download, metadata] = await Promise.all([downloadPromise, metadataPromise]);
  const failure = await download.failure();
  if (failure) {
    throw new Error(`Playwright download failed: ${failure}`);
  }

  return {
    download,
    blobType: metadata.blobType,
    blobSize: metadata.blobSize,
  };
}

function buildWebDownloadFallbackBase(target) {
  return `telegram-${sanitizeFilename(target.peer.replace(/\//g, "-"))}-${target.messageId}`;
}

function buildTelegramDocumentStreamUrl(document) {
  const payload = {
    dcId: document.dc_id,
    location: {
      _: "inputDocumentFileLocation",
      id: document.id,
      access_hash: document.access_hash,
      file_reference: document.file_reference,
    },
    size: document.size,
    mimeType: document.mime_type || "application/octet-stream",
    fileName: document.file_name || "",
  };

  return new URL(`stream/${encodeURIComponent(JSON.stringify(payload))}`, WEBK_URL).href;
}

function normalizeTelegramDocument(document) {
  if (!document) {
    return null;
  }

  return {
    id: document.id,
    access_hash: document.access_hash,
    file_reference: document.file_reference,
    dc_id: document.dc_id,
    mime_type: document.mime_type || "",
    size: Number(document.size || 0),
    w: Number(document.w || 0),
    h: Number(document.h || 0),
    duration: Number(document.duration || 0),
    type: document.type || "",
    file_name: document.file_name || "",
    supportsStreaming: Boolean(document.supportsStreaming),
  };
}

function pickBestTelegramDocument(documents) {
  const normalizedDocuments = documents
    .map((document) => normalizeTelegramDocument(document))
    .filter(Boolean)
    .filter((document) => document.size > 0);

  if (!normalizedDocuments.length) {
    return null;
  }

  normalizedDocuments.sort((left, right) => {
    if (right.size !== left.size) {
      return right.size - left.size;
    }

    const leftPixels = left.w * left.h;
    const rightPixels = right.w * right.h;
    if (rightPixels !== leftPixels) {
      return rightPixels - leftPixels;
    }

    return (right.duration || 0) - (left.duration || 0);
  });

  return normalizedDocuments[0];
}

function getSavedMessagesBaseDir(downloadDir) {
  const root = downloadDir
    ? ensureAbsoluteDir(config.workspaceRoot, downloadDir)
    : path.join(config.downloadsRoot, "saved-messages");
  return root;
}

function getSavedMessagesManifestPath(downloadDir) {
  return path.join(downloadDir, SAVED_MESSAGES_MANIFEST_NAME);
}

async function listSavedMessagesExistingFiles(downloadDir) {
  const entries = await fs.promises.readdir(downloadDir, {
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile() && entry.name !== SAVED_MESSAGES_MANIFEST_NAME)
    .map((entry) => entry.name);
}

function createSavedMessagesManifest(peerId) {
  const timestamp = new Date().toISOString();
  return {
    version: 1,
    peerId,
    createdAt: timestamp,
    updatedAt: timestamp,
    messageEntries: {},
  };
}

async function loadSavedMessagesManifest(downloadDir, peerId) {
  const manifestPath = getSavedMessagesManifestPath(downloadDir);

  try {
    const raw = await fs.promises.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      manifestPath,
      manifest: {
        version: Number(parsed?.version || 1),
        peerId,
        createdAt: parsed?.createdAt || new Date().toISOString(),
        updatedAt: parsed?.updatedAt || parsed?.createdAt || new Date().toISOString(),
        messageEntries:
          parsed && typeof parsed.messageEntries === "object" && parsed.messageEntries
            ? parsed.messageEntries
            : {},
      },
      existed: true,
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {
        manifestPath,
        manifest: createSavedMessagesManifest(peerId),
        existed: false,
      };
    }

    throw new Error(`Unable to read Saved Messages manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function saveSavedMessagesManifest(manifestPath, manifest) {
  manifest.updatedAt = new Date().toISOString();
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function getSavedMessagesKnownMessageIds(manifest) {
  return new Set(
    Object.keys(manifest?.messageEntries || {})
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isInteger(value) && value > 0),
  );
}

function recordSavedMessagesManifestEntry(manifest, item, status) {
  const messageId = Number(item?.messageId || 0);
  if (!messageId) {
    return;
  }

  manifest.messageEntries[String(messageId)] = {
    messageId,
    status,
    kind: item?.kind || "",
    groupedId: item?.groupedId || null,
    savedTo: item?.savedTo || "",
    sourceFileName: item?.sourceFileName || "",
    captionText: item?.captionText || "",
    recordedAt: new Date().toISOString(),
  };
}

function bootstrapSavedMessagesManifest(manifest, mediaMessages, existingFileCount) {
  if (!existingFileCount) {
    return {
      bootstrapped: false,
      bootstrappedExistingCount: 0,
    };
  }

  const assumedExistingMessages = mediaMessages.slice(-Math.min(existingFileCount, mediaMessages.length));
  for (const message of assumedExistingMessages) {
    const messageId = Number(message?.mid || message?.id || 0);
    if (!messageId) {
      continue;
    }

    manifest.messageEntries[String(messageId)] = {
      messageId,
      status: "legacy-existing",
      kind: message?.media?._ === "messageMediaPhoto" ? "image" : getSavedMessageDocumentKind(message?.media?.document),
      groupedId: message?.grouped_id || null,
      savedTo: "",
      sourceFileName: message?.media?.document?.file_name || "",
      captionText: normalizeCaptionText(message?.message || ""),
      recordedAt: new Date().toISOString(),
    };
  }

  return {
    bootstrapped: assumedExistingMessages.length > 0,
    bootstrappedExistingCount: assumedExistingMessages.length,
  };
}

function buildSavedMessageFilename(message, sourceFilename, extension, mediaKind = "", titleText = "") {
  const safeExtension = extension || ".bin";
  const fallbackBase = `saved-message-${message.mid || message.id}`;
  const sanitizedSourceFilename = sanitizeFilename(sourceFilename || "");
  const captionText = normalizeCaptionText(titleText || message.message || "");
  const normalizedMediaKind = String(mediaKind || "").toLowerCase();

  if (normalizedMediaKind === "video" && captionText) {
    return buildCaptionFilename(captionText, `${fallbackBase}${safeExtension}`);
  }

  if (sanitizedSourceFilename) {
    const parsed = path.parse(sanitizedSourceFilename);
    const baseName = truncateFilenameBase(parsed.name || fallbackBase);
    return sanitizeFilename(`${baseName}${safeExtension}`);
  }

  if (captionText) {
    return buildCaptionFilename(captionText, `${fallbackBase}${safeExtension}`);
  }

  return sanitizeFilename(`${fallbackBase}${safeExtension}`);
}

function buildSavedMessagesGroupTitleLookup(messages) {
  const groupedCaptionById = {};

  for (const message of messages) {
    const groupedId = message?.grouped_id;
    const captionText = normalizeCaptionText(message?.message || "");
    if (!groupedId || !captionText) {
      continue;
    }

    const key = String(groupedId);
    if (!groupedCaptionById[key]) {
      groupedCaptionById[key] = captionText;
    }
  }

  return groupedCaptionById;
}

function getSavedMessageTitleText(message, groupedCaptionById = {}) {
  const directCaptionText = normalizeCaptionText(message?.message || "");
  if (directCaptionText) {
    return directCaptionText;
  }

  const groupedId = message?.grouped_id ? String(message.grouped_id) : "";
  return groupedId ? groupedCaptionById[groupedId] || "" : "";
}

function getSavedMessageDocumentKind(document) {
  const mimeType = String(document?.mime_type || "").toLowerCase();
  const explicitType = String(document?.type || "").toLowerCase();

  if (explicitType === "video" || mimeType.startsWith("video/")) {
    return "video";
  }

  if (explicitType === "photo" || mimeType.startsWith("image/")) {
    return "image";
  }

  if (explicitType === "audio" || mimeType.startsWith("audio/")) {
    return "audio";
  }

  return "file";
}

async function fetchSavedMessagesHistoryBatch(page, peerId, offsetId, limit) {
  return page.evaluate(
    async ({ targetPeerId, targetOffsetId, targetLimit }) => {
      const manager = window.appImManager.managers.appMessagesManager;
      const historyPage = await manager.getHistory({
        peerId: targetPeerId,
        limit: targetLimit,
        offsetId: targetOffsetId,
      });
      const messages = [];

      for (const mid of historyPage.history) {
        messages.push(await manager.getMessageByPeer(targetPeerId, mid));
      }

      return {
        count: historyPage.count,
        history: historyPage.history,
        isEnd: historyPage.isEnd,
        offsetIdOffset: historyPage.offsetIdOffset,
        messages,
      };
    },
    {
      targetPeerId: peerId,
      targetOffsetId: offsetId || undefined,
      targetLimit: limit,
    },
  );
}

async function fetchAllSavedMessages(page, peerId, timeoutMs) {
  const messages = [];
  const seenMessageIds = new Set();
  const pageSize = 25;
  const startedAt = Date.now();
  let offsetId = undefined;
  let totalCount = 0;

  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out while enumerating Saved Messages history.");
    }

    const batch = await fetchSavedMessagesHistoryBatch(page, peerId, offsetId, pageSize);
    totalCount = Math.max(totalCount, batch.count || 0);

    for (const message of batch.messages) {
      if (!message) {
        continue;
      }

      const messageId = message.mid || message.id;
      if (!messageId || seenMessageIds.has(messageId)) {
        continue;
      }

      seenMessageIds.add(messageId);
      messages.push(message);
    }

    if (!batch.history.length || batch.isEnd?.top) {
      break;
    }

    offsetId = batch.history[batch.history.length - 1];
  }

  return {
    peerId,
    totalCount,
    messages,
  };
}

async function collectWebkAlbumMessageMedia(page, bubble) {
  return bubble.evaluate(async (node) => {
    const itemMids = Array.from(node.querySelectorAll(".album-item.grouped-item"))
      .map((element) => element.getAttribute("data-mid"))
      .filter(Boolean);
    const peerId = window.appImManager.chat?.peerId;
    const manager = window.appImManager.managers.appMessagesManager;

    const serializeDocument = (document) => {
      if (!document) {
        return null;
      }

      return {
        id: document.id,
        access_hash: document.access_hash,
        file_reference: document.file_reference,
        dc_id: document.dc_id,
        mime_type: document.mime_type || "",
        size: Number(document.size || 0),
        w: Number(document.w || 0),
        h: Number(document.h || 0),
        duration: Number(document.duration || 0),
        type: document.type || "",
        file_name: document.file_name || "",
        supportsStreaming: Boolean(document.supportsStreaming),
      };
    };

    const items = [];
    for (const rawMid of itemMids) {
      const message = await manager.getMessageByPeer(peerId, Number(rawMid));
      items.push({
        rawMid,
        messageId: message?.id || 0,
        kind:
          message?.media?._ === "messageMediaDocument"
            ? "document"
            : message?.media?._ === "messageMediaPhoto"
              ? "photo"
              : "other",
        document: serializeDocument(message?.media?.document),
        altDocuments: Array.isArray(message?.media?.alt_documents)
          ? message.media.alt_documents.map((document) => serializeDocument(document)).filter(Boolean)
          : [],
      });
    }

    return {
      peerId,
      items,
    };
  });
}

async function openSavedMessagesAtMessage(page, peerId, messageId) {
  await page.evaluate(
    async ({ targetPeerId, targetMessageId }) => {
      await window.appImManager.setInnerPeer({
        peerId: targetPeerId,
        lastMsgId: targetMessageId,
      });
    },
    {
      targetPeerId: peerId,
      targetMessageId: messageId,
    },
  );
  await sleep(2000);
}

async function downloadSavedMessageDocument(page, message, job, downloadDir, titleText = "") {
  const document = message.media.document;
  const mediaKind = getSavedMessageDocumentKind(document);
  const sourceUrl = buildTelegramDocumentStreamUrl(document);
  const provisionalExtension = extensionFromFilename(
    document.file_name,
    extensionFromMimeType(document.mime_type, ".bin"),
  );
  const provisionalFilename = buildSavedMessageFilename(
    message,
    document.file_name,
    provisionalExtension,
    mediaKind,
    titleText,
  );
  const { download, blobType, blobSize } = await triggerPageBlobDownload(
    page,
    sourceUrl,
    provisionalFilename,
    job.timeoutMs,
  );
  const finalExtension = extensionFromMimeType(
    blobType,
    extensionFromFilename(document.file_name, provisionalExtension),
  );
  const finalFilename = buildSavedMessageFilename(
    message,
    document.file_name,
    finalExtension,
    mediaKind,
    titleText,
  );
  const savedTo = await savePlaywrightDownload(download, downloadDir, finalFilename);

  return {
    index: 0,
    messageId: message.mid || message.id,
    groupedId: message.grouped_id || null,
    kind: mediaKind,
    sourceUrl,
    suggestedFilename: finalFilename,
    savedTo,
    blobType,
    blobSize,
    width: document.w || 0,
    height: document.h || 0,
    captionText: normalizeCaptionText(titleText || message.message || ""),
    sourceFileName: document.file_name || "",
  };
}

async function downloadSavedMessagePhoto(page, peerId, message, job, downloadDir, titleText = "") {
  const messageId = message.mid || message.id;
  await openSavedMessagesAtMessage(page, peerId, messageId);

  const bubble = await waitForMessageBubble(page, messageId, Math.min(job.timeoutMs, 20000));
  const groupedItem = bubble.locator(`.album-item.grouped-item[data-mid="${messageId}"]`).first();
  const hasGroupedItem = (await groupedItem.count()) > 0;
  const targetLocator = hasGroupedItem ? groupedItem : bubble;
  let viewerOpened = false;

  try {
    await openWebkMediaLocatorInViewer(
      page,
      targetLocator,
      `Saved Message ${messageId}`,
      Math.min(job.timeoutMs, 15000),
    );
    await waitForActiveMediaViewer(page, Math.min(job.timeoutMs, 20000));
    viewerOpened = true;

    const item = await extractActiveViewerMediaItem(page);
    if (!item?.sourceUrl || item.kind !== "image") {
      throw new Error(`Saved Message ${messageId} did not expose a downloadable image in viewer.`);
    }

    const provisionalFilename = buildSavedMessageFilename(message, "", ".bin", "image", titleText);
    const { download, blobType, blobSize } = await triggerPageBlobDownload(
      page,
      item.sourceUrl,
      provisionalFilename,
      job.timeoutMs,
    );
    const finalExtension = extensionFromMimeType(blobType, ".jpg");
    const finalFilename = buildSavedMessageFilename(message, "", finalExtension, "image", titleText);
    const savedTo = await savePlaywrightDownload(download, downloadDir, finalFilename);

    return {
      index: 0,
      messageId,
      groupedId: message.grouped_id || null,
      kind: "image",
      sourceUrl: item.sourceUrl,
      suggestedFilename: finalFilename,
      savedTo,
      blobType,
      blobSize,
      width: item.width,
      height: item.height,
      captionText: normalizeCaptionText(titleText || message.message || ""),
      sourceFileName: "",
    };
  } finally {
    if (viewerOpened) {
      await closeActiveMediaViewer(page, Math.min(job.timeoutMs, 10000)).catch(() => {});
    }
  }
}

async function getSavedMessagesPeerId(page) {
  return page.evaluate(async () => {
    const self = await window.appImManager.managers.appUsersManager.getSelf();
    return self.id;
  });
}

async function downloadSavedMessagesMedia(job, options = {}) {
  const { getPage, onProgress } = options;
  if (typeof getPage !== "function") {
    throw new Error("Saved Messages export requires browser automation but no page provider was configured.");
  }

  const page = await getPage();
  const loginState = await waitForTelegramLogin(page);
  if (!loginState.loggedIn) {
    throw new Error("Saved Messages export is unavailable because the Edge profile is not logged in.");
  }

  const downloadDir = getSavedMessagesBaseDir(job.downloadDir);
  await ensureDir(downloadDir);
  await ensureWebkReady(page, job.timeoutMs);

  const peerId = await getSavedMessagesPeerId(page);
  const history = await fetchAllSavedMessages(page, peerId, Math.min(job.timeoutMs, 120000));
  const mediaMessages = history.messages.filter((message) => message?.media);
  const groupedCaptionById = buildSavedMessagesGroupTitleLookup(history.messages);
  const { manifestPath, manifest, existed: manifestExisted } = await loadSavedMessagesManifest(downloadDir, peerId);
  const existingFiles = await listSavedMessagesExistingFiles(downloadDir);
  let bootstrappedFromFiles = false;
  let bootstrappedExistingCount = 0;

  if (!manifestExisted && existingFiles.length) {
    const bootstrapResult = bootstrapSavedMessagesManifest(manifest, mediaMessages, existingFiles.length);
    bootstrappedFromFiles = bootstrapResult.bootstrapped;
    bootstrappedExistingCount = bootstrapResult.bootstrappedExistingCount;
    await saveSavedMessagesManifest(manifestPath, manifest);
  }

  const knownMessageIds = getSavedMessagesKnownMessageIds(manifest);
  const pendingMediaMessages = mediaMessages.filter((message) => {
    const messageId = Number(message?.mid || message?.id || 0);
    return messageId > 0 && !knownMessageIds.has(messageId);
  });
  const skippedMessages = history.messages
    .filter((message) => !message?.media)
    .map((message) => ({
      messageId: message?.mid || message?.id || 0,
      reason: "text-only",
    }));
  const failures = [];
  const downloadedItems = [];
  const reportProgress = (extra = {}) => {
    if (typeof onProgress !== "function") {
      return;
    }

    onProgress({
      phase: "saved-messages-export",
      totalMessages: history.totalCount || history.messages.length,
      totalMediaMessages: mediaMessages.length,
      pendingMediaMessages: pendingMediaMessages.length,
      alreadyTracked: knownMessageIds.size,
      completed: downloadedItems.length,
      failed: failures.length,
      skipped: skippedMessages.length,
      ...extra,
    });
  };

  reportProgress({
    stage: "enumerated",
  });

  for (const message of pendingMediaMessages) {
    const mediaType = message?.media?._ || "";
    const messageId = message?.mid || message?.id || 0;
    const titleText = getSavedMessageTitleText(message, groupedCaptionById);
    try {
      if (mediaType === "messageMediaDocument" && message.media?.document) {
        const item = await downloadSavedMessageDocument(page, message, job, downloadDir, titleText);
        downloadedItems.push(item);
        recordSavedMessagesManifestEntry(manifest, item, "downloaded");
        await saveSavedMessagesManifest(manifestPath, manifest);
        reportProgress({
          stage: "downloaded",
          messageId,
          mediaType,
          fileName: message.media.document.file_name || "",
        });
        continue;
      }

      if (mediaType === "messageMediaPhoto" && message.media?.photo) {
        const item = await downloadSavedMessagePhoto(page, peerId, message, job, downloadDir, titleText);
        downloadedItems.push(item);
        recordSavedMessagesManifestEntry(manifest, item, "downloaded");
        await saveSavedMessagesManifest(manifestPath, manifest);
        reportProgress({
          stage: "downloaded",
          messageId,
          mediaType,
          fileName: "",
        });
        continue;
      }

      skippedMessages.push({
        messageId,
        reason: `unsupported media type: ${mediaType}`,
      });
      recordSavedMessagesManifestEntry(
        manifest,
        {
          messageId,
          kind: "unsupported",
          groupedId: message?.grouped_id || null,
          savedTo: "",
          sourceFileName: message?.media?.document?.file_name || "",
          captionText: titleText,
        },
        "unsupported",
      );
      await saveSavedMessagesManifest(manifestPath, manifest);
      reportProgress({
        stage: "skipped",
        messageId,
        mediaType,
      });
    } catch (error) {
      failures.push({
        messageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      reportProgress({
        stage: "failed",
        messageId,
        mediaType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (!downloadedItems.length && failures.length) {
    throw new Error(`Saved Messages export failed. First error: ${failures[0].reason}`);
  }

  if (!downloadedItems.length) {
    return {
      kind: "none",
      mode: "saved-messages",
      savedTo: downloadDir,
      savedFiles: [],
      mediaCount: 0,
      finalUrl: `${WEBK_URL}#${peerId}`,
      captionText: "",
      items: [],
      peerId,
      totalMessages: history.totalCount || history.messages.length,
      totalMediaMessages: mediaMessages.length,
      pendingCount: pendingMediaMessages.length,
      alreadyTrackedCount: knownMessageIds.size,
      skippedCount: skippedMessages.length,
      skippedMessages,
      failures,
      manifestPath,
      bootstrappedFromFiles,
      bootstrappedExistingCount,
    };
  }

  const result = summarizeDownloadResult({
    mode: "saved-messages",
    finalUrl: `${WEBK_URL}#${peerId}`,
    captionText: "",
    items: downloadedItems,
  });

  return {
    ...result,
    peerId,
    totalMessages: history.totalCount || history.messages.length,
    totalMediaMessages: mediaMessages.length,
    pendingCount: pendingMediaMessages.length,
    alreadyTrackedCount: knownMessageIds.size,
    skippedCount: skippedMessages.length,
    skippedMessages,
    failures,
    manifestPath,
    bootstrappedFromFiles,
    bootstrappedExistingCount,
  };
}

async function downloadWebkAlbumMedia(page, bubble, target, job, downloadDir, bubbleCaption) {
  const mediaLayout = await inspectWebkBubbleMediaLayout(bubble);
  if (!mediaLayout.albumItemCount) {
    throw new Error(`Target message ${target.peer}/${target.messageId} does not expose any album items in webk.`);
  }

  const fallbackBase = buildWebDownloadFallbackBase(target);
  const downloadedItems = [];
  const albumMessageMedia = await collectWebkAlbumMessageMedia(page, bubble).catch(() => null);

  if (
    albumMessageMedia?.items?.length === mediaLayout.albumItemCount &&
    albumMessageMedia.items.every((item) => item.kind === "document" && item.document)
  ) {
    for (let index = 0; index < albumMessageMedia.items.length; index += 1) {
      const item = albumMessageMedia.items[index];
      const bestDocument = pickBestTelegramDocument([item.document, ...item.altDocuments]);
      if (!bestDocument) {
        throw new Error(`Album item ${index + 1} does not expose a downloadable document.`);
      }

      const sourceUrl = buildTelegramDocumentStreamUrl(bestDocument);
      const provisionalExtension = extensionFromFilename(
        bestDocument.file_name,
        extensionFromMimeType(bestDocument.mime_type, ".bin"),
      );
      const provisionalFilename = buildMediaFilename(
        target,
        job.filename,
        bubbleCaption,
        fallbackBase,
        provisionalExtension,
        index,
        albumMessageMedia.items.length,
      );
      const { download, blobType, blobSize } = await triggerPageBlobDownload(
        page,
        sourceUrl,
        provisionalFilename,
        job.timeoutMs,
      );
      const finalExtension = extensionFromMimeType(
        blobType,
        extensionFromFilename(bestDocument.file_name, provisionalExtension),
      );
      const finalFilename = buildMediaFilename(
        target,
        job.filename,
        bubbleCaption,
        fallbackBase,
        finalExtension,
        index,
        albumMessageMedia.items.length,
      );
      const savedTo = await savePlaywrightDownload(download, downloadDir, finalFilename);

      downloadedItems.push({
        index: index + 1,
        kind: getSavedMessageDocumentKind(bestDocument),
        sourceUrl,
        suggestedFilename: finalFilename,
        savedTo,
        blobType,
        blobSize,
        width: bestDocument.w || 0,
        height: bestDocument.h || 0,
        sourceFileName: bestDocument.file_name || "",
      });
    }

    return summarizeDownloadResult({
      mode: "webk-message-documents",
      finalUrl: page.url(),
      captionText: bubbleCaption,
      items: downloadedItems,
    });
  }

  for (let index = 0; index < mediaLayout.albumItemCount; index += 1) {
    let viewerOpened = false;

    try {
      await openWebkAlbumItemInViewer(page, bubble, index, Math.min(job.timeoutMs, 15000));
      await waitForActiveMediaViewer(page, Math.min(job.timeoutMs, 30000));
      viewerOpened = true;

      const item = await extractActiveViewerMediaItem(page);
      if (!item?.sourceUrl) {
        throw new Error(`Album item ${index + 1} did not expose a downloadable media source in viewer.`);
      }

      const provisionalExtension = item.kind === "video" ? ".mp4" : ".bin";
      const provisionalFilename = buildMediaFilename(
        target,
        job.filename,
        bubbleCaption,
        fallbackBase,
        provisionalExtension,
        index,
        mediaLayout.albumItemCount,
      );
      const { download, blobType, blobSize } = await triggerPageBlobDownload(
        page,
        item.sourceUrl,
        provisionalFilename,
        job.timeoutMs,
      );
      const finalExtension = extensionFromMimeType(
        blobType,
        extensionFromUrl(item.sourceUrl, provisionalExtension),
      );
      const finalFilename = buildMediaFilename(
        target,
        job.filename,
        bubbleCaption,
        fallbackBase,
        finalExtension,
        index,
        mediaLayout.albumItemCount,
      );
      const savedTo = await savePlaywrightDownload(download, downloadDir, finalFilename);
      const streamMetadata = parseTelegramStreamMetadata(item.sourceUrl);

      downloadedItems.push({
        index: index + 1,
        kind: item.kind,
        sourceUrl: item.sourceUrl,
        suggestedFilename: finalFilename,
        savedTo,
        blobType,
        blobSize,
        width: item.width,
        height: item.height,
        sourceFileName: streamMetadata?.fileName || "",
      });
    } finally {
      if (viewerOpened) {
        await closeActiveMediaViewer(page, Math.min(job.timeoutMs, 15000)).catch(() => {});
      }
    }
  }

  return summarizeDownloadResult({
    mode: "webk-viewer",
    finalUrl: page.url(),
    captionText: bubbleCaption,
    items: downloadedItems,
  });
}

async function downloadWebTelegramVideo(page, target, job, downloadDir) {
  await openTelegramMessageInWebk(page, target, job.timeoutMs);

  if (!page.url().includes("webk.telegram.org")) {
    throw new Error(`The message link did not land on webk.telegram.org. Final URL: ${page.url()}`);
  }

  const restrictedPlaceholder = await detectRestrictedChannelPlaceholder(page);
  if (restrictedPlaceholder.blocked) {
    throw new Error(
      `Telegram Web cannot display @${target.peer}: ${restrictedPlaceholder.reason || "restricted channel"}`,
    );
  }

  const bubble = await waitForMessageBubble(page, target.messageId, Math.min(job.timeoutMs, 45000));
  const bubbleCaption = job.filename ? "" : await extractBubbleCaptionText(bubble);
  const mediaLayout = await inspectWebkBubbleMediaLayout(bubble);
  if (mediaLayout.hasGroupedAlbum) {
    return downloadWebkAlbumMedia(page, bubble, target, job, downloadDir, bubbleCaption);
  }

  const mediaItems = await extractWebkInlineMediaItems(bubble);
  if (!mediaItems.length) {
    throw new Error(`Target message ${target.peer}/${target.messageId} does not expose any downloadable media in webk.`);
  }
  const fallbackBase = buildWebDownloadFallbackBase(target);
  const downloadedItems = [];

  for (let index = 0; index < mediaItems.length; index += 1) {
    const item = mediaItems[index];
    const absoluteSourceUrl = new URL(item.sourceUrl, page.url()).href;
    const streamMetadata = parseTelegramStreamMetadata(item.sourceUrl);
    const provisionalExtension = item.kind === "video" ? ".mp4" : ".bin";
    const provisionalFilename = buildMediaFilename(
      target,
      job.filename,
      bubbleCaption,
      fallbackBase,
      provisionalExtension,
      index,
      mediaItems.length,
    );
    const { download, blobType, blobSize } = await triggerPageBlobDownload(
      page,
      absoluteSourceUrl,
      provisionalFilename,
      job.timeoutMs,
    );
    const finalExtension = extensionFromMimeType(
      blobType,
      extensionFromUrl(absoluteSourceUrl, provisionalExtension),
    );
    const finalFilename = buildMediaFilename(
      target,
      job.filename,
      bubbleCaption,
      fallbackBase,
      finalExtension,
      index,
      mediaItems.length,
    );
    const savedTo = await savePlaywrightDownload(download, downloadDir, finalFilename);

    downloadedItems.push({
      index: index + 1,
      kind: item.kind,
      sourceUrl: absoluteSourceUrl,
      suggestedFilename: finalFilename,
      savedTo,
      blobType,
      blobSize,
      width: item.width,
      height: item.height,
      sourceFileName: streamMetadata?.fileName || "",
    });
  }

  return summarizeDownloadResult({
    mode: "webk-blob",
    finalUrl: page.url(),
    captionText: bubbleCaption,
    items: downloadedItems,
  });
}

async function downloadMediaByMessageLink(job, options = {}) {
  const { getPage } = options;
  const target = parseTelegramMessageUrl(job.url);
  const downloadDir = job.downloadDir
    ? ensureAbsoluteDir(config.workspaceRoot, job.downloadDir)
    : config.downloadsRoot;
  await ensureDir(downloadDir);

  let publicAttemptError = null;

  if (target.isPublicChannelPost) {
    try {
      return await downloadPublicTelegramVideo(target, job, downloadDir);
    } catch (error) {
      publicAttemptError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (typeof getPage !== "function") {
    if (publicAttemptError) {
      throw new Error(
        `Public direct mode failed: ${publicAttemptError.message}; Web Telegram fallback requires browser automation but no page provider was configured.`,
      );
    }

    throw new Error("Web Telegram fallback requires browser automation but no page provider was configured.");
  }

  const page = await getPage();

  const loginState = await waitForTelegramLogin(page);
  if (!loginState.loggedIn) {
    if (publicAttemptError) {
      throw new Error(
        `Public direct mode failed: ${publicAttemptError.message}; Web Telegram fallback is unavailable because the Edge profile is not logged in.`,
      );
    }

    throw new Error("Web Telegram fallback is unavailable because the Edge profile is not logged in.");
  }

  try {
    return await downloadWebTelegramVideo(page, target, job, downloadDir);
  } catch (error) {
    const webError = error instanceof Error ? error : new Error(String(error));
    if (publicAttemptError) {
      throw new Error(
        `Public direct mode failed: ${publicAttemptError.message}; Web Telegram fallback failed: ${webError.message}`,
      );
    }

    throw webError;
  }
}

module.exports = {
  downloadMediaByMessageLink,
  downloadSavedMessagesMedia,
  downloadPublicTelegramVideo,
  parseTelegramMessageUrl,
  waitForTelegramLogin,
  buildCaptionFilename,
  buildMediaFilename,
  buildSavedMessageFilename,
  buildSavedMessagesGroupTitleLookup,
  getSavedMessageTitleText,
};
