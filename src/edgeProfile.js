const fs = require("fs/promises");
const path = require("path");

const config = require("./config");
const { ensureDir } = require("./utils");

const IGNORED_NAMES = new Set([
  "Cache",
  "Code Cache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "BrowserMetrics",
  "Crashpad",
  "Safe Browsing",
  "OptimizationHints",
  "AutofillStates",
  "SingletonCookie",
  "SingletonLock",
  "SingletonSocket",
  "LOCK",
  "lockfile",
]);

function getSourceProfileDir() {
  return path.join(config.sourceUserDataDir, config.sourceProfileDirName);
}

function getClonedProfileDir() {
  return path.join(config.clonedUserDataDir, config.sourceProfileDirName);
}

function toWorkspaceRelative(targetPath) {
  return path.relative(config.workspaceRoot, targetPath).replace(/\\/g, "/") || ".";
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function shouldCopyPath(sourcePath) {
  return !IGNORED_NAMES.has(path.basename(sourcePath));
}

function isSkippableCopyError(error) {
  return ["EBUSY", "EPERM", "EINVAL"].includes(error.code);
}

async function removeClonedProfileDir(targetDir) {
  try {
    await fs.rm(targetDir, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(error.code)) {
      throw error;
    }
  }

  const parkedDir = `${targetDir}.stale-${Date.now()}`;
  await fs.rename(targetDir, parkedDir);
  fs.rm(parkedDir, { recursive: true, force: true }).catch(() => {});
}

async function copyTree(sourcePath, destinationPath, skippedFiles = []) {
  const sourceStats = await fs.stat(sourcePath);

  if (sourceStats.isDirectory()) {
    await ensureDir(destinationPath);
    const entries = await fs.readdir(sourcePath, { withFileTypes: true });
    for (const entry of entries) {
      const childSource = path.join(sourcePath, entry.name);
      const childDestination = path.join(destinationPath, entry.name);
      if (!shouldCopyPath(childSource)) {
        continue;
      }

      await copyTree(childSource, childDestination, skippedFiles);
    }
    return skippedFiles;
  }

  try {
    await fs.copyFile(sourcePath, destinationPath);
  } catch (error) {
    if (!isSkippableCopyError(error)) {
      throw error;
    }

    skippedFiles.push(sourcePath);
  }

  return skippedFiles;
}

async function cloneEdgeProfile() {
  const sourceProfileDir = getSourceProfileDir();
  const localStatePath = path.join(config.sourceUserDataDir, "Local State");
  const skippedFiles = [];

  if (!(await pathExists(sourceProfileDir))) {
    throw new Error(`Edge profile not found: ${sourceProfileDir}`);
  }

  if (!(await pathExists(localStatePath))) {
    throw new Error(`Edge Local State not found: ${localStatePath}`);
  }

  if (await pathExists(config.clonedUserDataDir)) {
    await removeClonedProfileDir(config.clonedUserDataDir);
  }
  await ensureDir(config.clonedUserDataDir);

  await fs.copyFile(localStatePath, path.join(config.clonedUserDataDir, "Local State"));
  await copyTree(sourceProfileDir, getClonedProfileDir(), skippedFiles);

  return {
    clonedUserDataDir: toWorkspaceRelative(config.clonedUserDataDir),
    clonedProfileDir: toWorkspaceRelative(getClonedProfileDir()),
    sourceProfile: config.sourceProfileDirName,
    skippedFileCount: skippedFiles.length,
    skippedFiles: skippedFiles.map((skippedFile) =>
      path.relative(sourceProfileDir, skippedFile).replace(/\\/g, "/"),
    ),
  };
}

async function ensureClonedProfile() {
  const clonedProfileDir = getClonedProfileDir();

  if (await pathExists(clonedProfileDir)) {
    return {
      clonedUserDataDir: toWorkspaceRelative(config.clonedUserDataDir),
      clonedProfileDir: toWorkspaceRelative(clonedProfileDir),
      sourceProfile: config.sourceProfileDirName,
    };
  }

  return cloneEdgeProfile();
}

module.exports = {
  cloneEdgeProfile,
  ensureClonedProfile,
  getClonedProfileDir,
  getSourceProfileDir,
};
