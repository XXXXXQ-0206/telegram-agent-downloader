const fs = require("fs/promises");

const { chromium } = require("playwright-core");

const config = require("./config");
const { ensureClonedProfile } = require("./edgeProfile");

class BrowserController {
  constructor() {
    this.context = null;
  }

  async getContext() {
    if (this.context) {
      return this.context;
    }

    await fs.access(config.edgeExecutablePath);
    await ensureClonedProfile();

    this.context = await chromium.launchPersistentContext(config.clonedUserDataDir, {
      executablePath: config.edgeExecutablePath,
      headless: config.headless,
      acceptDownloads: true,
      args: [`--profile-directory=${config.sourceProfileDirName}`],
      viewport: { width: 1440, height: 960 },
    });

    this.context.on("close", () => {
      this.context = null;
    });

    return this.context;
  }

  async getPage() {
    const context = await this.getContext();
    const existingPage = context.pages().find((page) => !page.isClosed());
    if (existingPage) {
      return existingPage;
    }

    return context.newPage();
  }

  async close() {
    if (!this.context) {
      return;
    }

    await this.context.close();
    this.context = null;
  }
}

module.exports = {
  BrowserController,
};
