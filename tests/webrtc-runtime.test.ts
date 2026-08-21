import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

async function runProbe(): Promise<{ code: number | null; output: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/webrtc-runtime-probe.ts"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { if (output.length < 32_768) output += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { if (output.length < 32_768) output += chunk.toString("utf8"); });
  const result = await Promise.race([
    new Promise<number | null>((resolve) => child.once("exit", resolve)),
    new Promise<"timeout">((resolve) => { const timer = setTimeout(() => resolve("timeout"), 12_000); timer.unref(); })
  ]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    return { code: null, output: `${output}\nprobe_timeout` };
  }
  return { code: result, output };
}

test("WebRTC runtime loopback negotiates H264 RTP, DataChannel input and fresh-generation reconnect fencing", { timeout: 15_000 }, async () => {
  const result = await runProbe();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /PROBE_PASS/);
  assert.doesNotMatch(result.output, /PROBE_FAIL/);
});
