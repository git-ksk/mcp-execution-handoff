import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

test("temporary probe: emit TypeScript 7 source maps", () => {
  const tsc = process.platform === "win32"
    ? "node_modules/.bin/tsc.cmd"
    : "node_modules/.bin/tsc";
  execFileSync(tsc, [
    "src/experimental/websocket-takeover.ts",
    "--ignoreConfig",
    "--target",
    "ES2022",
    "--module",
    "NodeNext",
    "--moduleResolution",
    "NodeNext",
    "--strict",
    "--declaration",
    "--declarationMap",
    "--sourceMap",
    "--outDir",
    "dist",
    "--rootDir",
    "src",
    "--skipLibCheck",
    "--noUncheckedIndexedAccess",
    "--exactOptionalPropertyTypes",
    "--types",
    "node"
  ], { stdio: ["ignore", "inherit", "inherit"] });
  for (const name of ["websocket-takeover.d.ts.map", "websocket-takeover.js.map"]) {
    const content = readFileSync(`dist/experimental/${name}`);
    const encoded = gzipSync(content, { level: 9 }).toString("base64");
    console.log(`WS_GZIP_MAP_${name}=${encoded}`);
  }
});
