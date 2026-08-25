import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import test from "node:test";

test("temporary probe: emit repository-build source maps", () => {
  const tsc = process.platform === "win32"
    ? "node_modules/.bin/tsc.cmd"
    : "node_modules/.bin/tsc";
  execFileSync(tsc, ["-p", "tsconfig.json"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  for (const name of ["websocket-takeover.d.ts.map", "websocket-takeover.js.map"]) {
    const content = readFileSync(`dist/experimental/${name}`);
    const encoded = gzipSync(content, { level: 9 }).toString("base64");
    console.log(`WS_REPO_MAP_${name}=${encoded}`);
  }
});
