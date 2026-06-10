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

const url = `https://github.com/mhndayesh/CodeWeave/releases/download/v${version}/${assetName}`;
console.log(`codeweave: downloading v${version} (${os}-${cpu})...`);

fs.mkdirSync(binaryDir, { recursive: true });

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { "User-Agent": "codeweave-install" } }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${res.statusCode} ${url}`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (err) => {
      file.close();
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

async function install() {
  await download(url, archivePath);
  console.log("codeweave: extracting...");

  const extractTool = isLinux ? "tar" : "unzip";
  const extractArgs = isLinux ? ["-xzf", archivePath, "-C", binaryDir] : ["-o", archivePath, "-d", binaryDir];

  const result = spawnSync(extractTool, extractArgs, { stdio: "pipe" });
  if (result.status !== 0) {
    throw new Error(`${extractTool} extraction failed: ${result.stderr?.toString() || result.stdout?.toString() || "unknown error"}`);
  }

  try { fs.unlinkSync(archivePath); } catch {}

  if (process.platform !== "win32") {
    fs.chmodSync(binaryPath, 0o755);
  }

  if (!fs.existsSync(binaryPath)) {
    throw new Error(`binary not found after extraction: ${binaryPath}`);
  }

  console.log(`codeweave v${version} ready`);
}

install().catch((err) => {
  console.error(`codeweave: install failed: ${err.message}`);
  process.exit(1);
});
