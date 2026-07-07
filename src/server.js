const http = require("http");

const config = require("./config");
const { cloneEdgeProfile } = require("./edgeProfile");
const { DownloadService } = require("./downloadService");
const { BrowserController } = require("./browserController");
const { waitForTelegramLogin } = require("./telegramDownloader");
const { getPathname, readJson, sendJson } = require("./http");

const downloadService = new DownloadService();

async function handleRequest(request, response) {
  const method = request.method || "GET";
  const pathname = getPathname(request);

  try {
    if (method === "GET" && pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        queued: downloadService.listJobs().filter((job) => job.status === "queued").length,
        running: downloadService.listJobs().filter((job) => job.status === "running").length,
      });
      return;
    }

    if (method === "POST" && pathname === "/bootstrap-profile") {
      const result = await cloneEdgeProfile();
      sendJson(response, 200, { ok: true, result });
      return;
    }

    if (method === "POST" && pathname === "/probe") {
      const browser = new BrowserController();
      try {
        const page = await browser.getPage();
        const result = await waitForTelegramLogin(page);
        sendJson(response, 200, { ok: true, result });
      } finally {
        await browser.close();
      }
      return;
    }

    if (method === "POST" && (pathname === "/jobs" || pathname === "/download")) {
      const payload = await readJson(request);
      const job = await downloadService.submitJob(payload);
      sendJson(response, 202, { ok: true, job });
      return;
    }

    if (method === "POST" && pathname === "/saved-messages/export") {
      const payload = await readJson(request).catch(() => ({}));
      const job = await downloadService.submitJob({
        ...payload,
        kind: "saved-messages",
      });
      sendJson(response, 202, { ok: true, job });
      return;
    }

    if (method === "GET" && pathname === "/jobs") {
      sendJson(response, 200, { ok: true, jobs: downloadService.listJobs() });
      return;
    }

    if (method === "GET" && pathname.startsWith("/jobs/")) {
      const jobId = pathname.slice("/jobs/".length);
      const job = downloadService.getJob(jobId);
      if (!job) {
        sendJson(response, 404, { ok: false, error: "Job not found." });
        return;
      }

      sendJson(response, 200, { ok: true, job });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Route not found." });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      ok: false,
      error: "Internal server error.",
    });
  }
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response);
});

server.listen(config.serverPort, () => {
  console.log(
    JSON.stringify(
      {
        ok: true,
        port: config.serverPort,
        headless: config.headless,
      },
      null,
      2,
    ),
  );
});
