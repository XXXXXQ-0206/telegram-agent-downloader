const os = require("os");
const path = require("path");

const workspaceRoot = path.resolve(__dirname, "..");
const runtimeRoot = path.join(workspaceRoot, "runtime");
const clonedUserDataDir = path.join(runtimeRoot, "edge-user-data");
const downloadsRoot = path.join(workspaceRoot, "downloads");

module.exports = {
  workspaceRoot,
  runtimeRoot,
  clonedUserDataDir,
  downloadsRoot,
  edgeExecutablePath:
    process.env.EDGE_EXECUTABLE_PATH ||
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  sourceUserDataDir:
    process.env.EDGE_USER_DATA_DIR ||
    path.join(
      os.homedir(),
      "AppData",
      "Local",
      "Microsoft",
      "Edge",
      "User Data",
    ),
  sourceProfileDirName: process.env.EDGE_PROFILE_DIR || "Default",
  headless: process.env.HEADLESS !== "0",
  serverPort: Number.parseInt(process.env.PORT || "8787", 10),
  jobTimeoutMs: Number.parseInt(process.env.JOB_TIMEOUT_MS || "900000", 10),
};
