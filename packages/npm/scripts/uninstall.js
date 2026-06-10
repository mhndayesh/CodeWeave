#!/usr/bin/env node
const fs = require("fs");
const path = require("path");

const binaryDir = path.resolve(__dirname, "..", "binary");

if (fs.existsSync(binaryDir)) {
  fs.rmSync(binaryDir, { recursive: true, force: true });
  console.log("codeweave: binary removed");
}
