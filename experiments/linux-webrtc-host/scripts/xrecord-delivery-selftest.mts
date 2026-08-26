import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";

const root = process.cwd();
const targetBin = "/tmp/mcp-handoff-linux-xrecord-selftest-target";
const recordBin = resolve(root, "dist/native/mcp-handoff-linux-xrecord-delivery-helper");
const xtestBin = resolve(root, "dist/native/mcp-handoff-linux-xtest-helper");
const display = `:${150 + (process.pid % 40)}`;
const env = { DISPLAY: display, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" };
const children: ChildProcessWithoutNullStreams[] = [];

function deadline<T>(label: string, promise: Promise<T>, ms = 5_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
      timer.unref?.();
    })
  ]);
}

function lineReader(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  let buffer = "";
  const queued: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else queued.push(line);
    }
  });
  return () => {
    const line = queued.shift();
    if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolveLine) => waiters.push(resolveLine));
  };
}

function start(executable: string, args: string[] = []): { child: ChildProcessWithoutNullStreams; nextLine: () => Promise<string> } {
  const child = spawn(executable, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  child.once("error", () => undefined);
  return { child, nextLine: lineReader(child) };
}

async function command(child: ChildProcessWithoutNullStreams, nextLine: () => Promise<string>, line: string, expected: string): Promise<void> {
  child.stdin.write(`${line}\n`);
  assert.equal(await deadline(`command ${line}`, nextLine()), expected);
}

async function waitForDisplay(): Promise<void> {
  const end = Date.now() + 5_000;
  while (Date.now() < end) {
    const result = spawnSync("/usr/bin/xdpyinfo", ["-display", display], { env, stdio: "ignore" });
    if (result.status === 0) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("Xvfb readiness timed out");
}

async function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([once(child, "close").catch(() => undefined), new Promise((resolveWait) => setTimeout(resolveWait, 500))]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const xvfb = start("/usr/bin/Xvfb", [display, "-screen", "0", "800x600x24", "-nolisten", "tcp", "-ac"]).child;
try {
  await waitForDisplay();

  const target = start(targetBin);
  assert.ok(target.child.pid);
  const ready = /^READY (\d+)$/.exec(await deadline("target readiness", target.nextLine()));
  assert.ok(ready);
  const windowId = Number(ready[1]);
  assert.equal(Number.isSafeInteger(windowId) && windowId > 0, true);

  const record = start(recordBin);
  assert.equal(await deadline("record readiness", record.nextLine()), "READY 3");
  const xtest = start(xtestBin);
  assert.equal(await deadline("xtest readiness", xtest.nextLine()), "READY 1");

  const x = 300;
  const y = 250;
  await command(record.child, record.nextLine, `ARM ${windowId} ${target.child.pid} ${x} ${y}`, "OK ARM");
  await command(xtest.child, xtest.nextLine, `MOVE ${x} ${y}`, "OK MOVE");
  await command(xtest.child, xtest.nextLine, `DOWN 1 ${x} ${y}`, "OK DOWN");
  await command(record.child, record.nextLine, "WAIT", "OK PRESS");
  assert.equal(await deadline("target press", target.nextLine()), "PRESS");
  await command(xtest.child, xtest.nextLine, "UP 1", "OK UP");
  assert.equal(await deadline("target release", target.nextLine()), "RELEASE");

  process.stdout.write("LINUX_XRECORD_SELFTEST_OK\n");
} finally {
  for (const child of [...children].reverse()) await stop(child);
  await stop(xvfb);
}
