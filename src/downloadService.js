const crypto = require("crypto");

const config = require("./config");
const { BrowserController } = require("./browserController");
const { ensureClonedProfile } = require("./edgeProfile");
const { downloadMediaByMessageLink, downloadSavedMessagesMedia } = require("./telegramDownloader");

class DownloadService {
  constructor() {
    this.browser = new BrowserController();
    this.jobs = new Map();
    this.queue = [];
    this.processing = false;
  }

  listJobs() {
    return Array.from(this.jobs.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  async submitJob(payload) {
    const kind = payload?.kind === "saved-messages" ? "saved-messages" : "url";

    if (kind === "url" && (!payload || typeof payload.url !== "string" || !payload.url.trim())) {
      throw new Error("A non-empty url field is required.");
    }

    const job = {
      id: crypto.randomUUID(),
      kind,
      status: "queued",
      url: kind === "url" ? payload.url.trim() : "",
      downloadDir: payload.downloadDir || "",
      filename: payload.filename || "",
      timeoutMs:
        Number.isInteger(payload.timeoutMs) && payload.timeoutMs > 0
          ? payload.timeoutMs
          : config.jobTimeoutMs,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      progress: null,
      result: null,
      error: null,
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    void this.drainQueue();

    return job;
  }

  async drainQueue() {
    if (this.processing) {
      return;
    }

    this.processing = true;

    try {
      while (this.queue.length) {
        const jobId = this.queue.shift();
        const job = this.jobs.get(jobId);
        if (!job) {
          continue;
        }

        await this.runJob(job);
      }
    } finally {
      this.processing = false;
    }
  }

  async runJob(job) {
    job.status = "running";
    job.startedAt = new Date().toISOString();

    try {
      const downloader = job.kind === "saved-messages"
        ? downloadSavedMessagesMedia
        : downloadMediaByMessageLink;
      job.result = await downloader(job, {
        getPage: async () => {
          await ensureClonedProfile();
          return this.browser.getPage();
        },
        onProgress: (progress) => {
          job.progress = {
            updatedAt: new Date().toISOString(),
            ...progress,
          };
        },
      });
      job.status = "completed";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.finishedAt = new Date().toISOString();
      await this.browser.close();
    }
  }
}

module.exports = {
  DownloadService,
};
