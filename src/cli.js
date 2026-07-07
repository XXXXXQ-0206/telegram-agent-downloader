const { cloneEdgeProfile } = require("./edgeProfile");
const { BrowserController } = require("./browserController");
const { waitForTelegramLogin } = require("./telegramDownloader");

async function run() {
  const command = process.argv[2];

  if (command === "bootstrap-profile") {
    const result = await cloneEdgeProfile();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "probe") {
    const browser = new BrowserController();
    try {
      const page = await browser.getPage();
      const result = await waitForTelegramLogin(page);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      await browser.close();
    }
    return;
  }

  throw new Error(
    `Unknown command: ${command || "(empty)"}.\nSupported: bootstrap-profile, probe`,
  );
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
