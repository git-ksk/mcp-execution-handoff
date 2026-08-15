import { createHash } from "node:crypto";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export function digestToolInvocation(toolName: string, args: unknown): string {
  return createHash("sha256").update("mcp-execution-handoff/invocation/v1\0").update(toolName).update("\0").update(canonicalJson(args)).digest("hex");
}
