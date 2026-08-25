import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

test("temporary probe: emit TypeScript 7 source maps", () => {
  execFileSync(process.execPath, [
    "node_modules/typescript/bin/tsc",
    "src/experimental/websocket-takeover.ts",
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
    "dist/experimental",
    "--rootDir",
    "src/experimental",
    "--skipLibCheck",
    "--noUncheckedIndexedAccess",
    "--exactOptionalPropertyTypes",
    "--types",
    "node"
  ]);
  for (const name of ["websocket-takeover.d.ts.map", "websocket-takeover.js.map"]) {
    const content = readFileSync(`dist/experimental/${name}`, "utf8");
    const encoded = Buffer.from(content).toString("base64");
    console.log(`WS_MAP_${name}=${encoded}`);
  }
});
