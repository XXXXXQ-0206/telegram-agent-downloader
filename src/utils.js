const fs = require("fs/promises");
const path = require("path");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureAbsoluteDir(baseDir, targetDir) {
  if (!targetDir) {
    return baseDir;
  }

  if (path.isAbsolute(targetDir)) {
    return targetDir;
  }

  return path.resolve(baseDir, targetDir);
}

function sanitizeFilename(input) {
  return input.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").replace(/\s+/g, " ").trim();
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

module.exports = {
  ensureAbsoluteDir,
  ensureDir,
  sanitizeFilename,
  sleep,
};
