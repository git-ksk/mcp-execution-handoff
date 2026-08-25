import { execFileSync } from "node:child_process";
import test from "node:test";

test("temporary probe: compare repository-build source maps", () => {
  const tsc = process.platform === "win32"
    ? "node_modules/.bin/tsc.cmd"
    : "node_modules/.bin/tsc";
  execFileSync(tsc, ["-p", "tsconfig.json"], {
    stdio: ["ignore", "inherit", "inherit"]
  });
  for (const name of ["websocket-takeover.d.ts.map", "websocket-takeover.js.map"]) {
    const path = `dist/experimental/${name}`;
    const generated = execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim();
    const committed = execFileSync("git", ["rev-parse", `HEAD:${path}`], {
      encoding: "utf8"
    }).trim();
    console.log(`WS_MAP_SHA_${name}=generated:${generated},committed:${committed}`);
  }
});
