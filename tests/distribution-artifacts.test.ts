import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

async function sourceModules(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const modules: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      modules.push(...await sourceModules(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) modules.push(fullPath);
  }
  return modules;
}

test(
  "fresh checkout contains the emitted dist closure for every source module",
  async () => {
    const sourceFiles = await sourceModules("src");
    assert.ok(sourceFiles.length > 0);

    const missing: string[] = [];
    for (const sourceFile of sourceFiles) {
      const relative = path.relative("src", sourceFile).replace(/\.ts$/, "");
      for (const suffix of [".js", ".js.map", ".d.ts", ".d.ts.map"] as const) {
        const output = path.join("dist", `${relative}${suffix}`);
        try {
          await access(output);
        } catch {
          missing.push(output);
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      "Run npm run build and commit every emitted dist artifact before merging source modules"
    );
  }
);
