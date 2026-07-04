#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const https = require("https");
const { spawnSync } = require("child_process");

const platformMap = {
  linux: "linux",
  darwin: "darwin",
  win32: "windows",
};

const archMap = {
  x64: "x64",
  arm64: "arm64",
};

const os = platformMap[process.platform];
const cpu = archMap[process.arch];

if (!os || !cpu) {
  console.log(`codeweave: unsupported platform ${process.platform}-${process.arch}, skipping`);
  process.exit(0);
}

const pkgDir = path.resolve(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const version = pkg.version;
const isLinux = os === "linux";
const ext = isLinux ? "tar.gz" : "zip";
const assetName = `codeweave-${os}-${cpu}.${ext}`;
const binaryDir = path.join(pkgDir, "binary");
const binaryPath = path.join(binaryDir, process.platform === "win32" ? "opencode.exe" : "opencode");
const archivePath = path.join(binaryDir, assetName);

if (fs.existsSync(binaryPath)) {
  console.log(`codeweave v${version} already installed`);
  process.exit(0);
}

// Skip download — binary is expected to be placed locally during dev builds.
// In production, the binary is distributed via the opencode CLI installer.
console.log(`codeweave v${version} — skipping binary download (use local build)`);
process.exit(0);
