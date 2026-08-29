import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export interface WssAcceptanceIngress {
  publicOrigin: string;
  tunnelProcess?: ChildProcess;
}

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.pathname !== "/"
    || url.search
    || url.hash
  ) throw new Error("HANDOFF_WSS_PUBLIC_BASE_URL must be one exact HTTPS origin");
  return url.origin;
}

/**
 * Resolve a physical-iPhone-safe HTTPS ingress without weakening the WSS exact-Origin contract.
 * An explicit public origin wins; otherwise a temporary Cloudflare quick tunnel is created over a
 * loopback-only HTTP origin. Tunnel output is parsed only for the public origin and is not retained.
 */
export async function resolveWssAcceptanceIngress(port: number): Promise<WssAcceptanceIngress> {
  const explicit = process.env.HANDOFF_WSS_PUBLIC_BASE_URL?.trim();
  if (explicit) return { publicOrigin: exactHttpsOrigin(explicit) };

  const executable = process.env.HANDOFF_CLOUDFLARED_EXECUTABLE?.trim() || "cloudflared";
  const child = spawn(executable, [
    "tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate", "--loglevel", "info"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  let buffer = "";
  let settled = false;
  let resolveOrigin!: (origin: string) => void;
  let rejectOrigin!: (error: Error) => void;
  const origin = new Promise<string>((resolve, reject) => {
    resolveOrigin = resolve;
    rejectOrigin = reject;
  });
  const observe = (chunk: Buffer): void => {
    if (settled) return;
    buffer = (buffer + chunk.toString("utf8")).slice(-16 * 1024);
    const match = QUICK_TUNNEL_URL.exec(buffer);
    if (!match) return;
    settled = true;
    resolveOrigin(exactHttpsOrigin(match[0]));
  };
  child.stdout?.on("data", observe);
  child.stderr?.on("data", observe);
  child.once("error", (error) => {
    if (settled) return;
    settled = true;
    rejectOrigin(new Error(`cloudflared quick tunnel failed: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    rejectOrigin(new Error(`cloudflared quick tunnel exited before publishing HTTPS origin (${code ?? signal ?? "unknown"})`));
  });

  const timeout = sleep(15_000).then(() => {
    throw new Error("timed out waiting for cloudflared quick tunnel HTTPS origin");
  });
  try {
    return { publicOrigin: await Promise.race([origin, timeout]), tunnelProcess: child };
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
}

export async function stopWssAcceptanceTunnel(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(1_000).then(() => undefined)
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
