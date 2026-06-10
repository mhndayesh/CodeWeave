#!/usr/bin/env node
const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const binaryName = process.platform === "win32" ? "opencode.exe" : "opencode";
const binaryPath = path.join(__dirname, "..", "binary", binaryName);

if (!fs.existsSync(binaryPath)) {
  console.error("");
  console.error("  CodeWeave binary not found.");
  console.error("  Run 'npm install codeweave' again to re-download it.");
  console.error("");
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
