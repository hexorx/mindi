import { readFile } from "node:fs/promises";
import { writeBuildInfo } from "./build-info.js";
const [path, revision] = process.argv.slice(2);
if (!path || revision === undefined || process.argv.length !== 4)
  throw Error("Usage: write-build-info output-path source-revision");
const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
await writeBuildInfo(path, manifest.version, revision);
