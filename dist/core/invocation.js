import { createHash } from "node:crypto";
function canonicalJson(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
    const object = value;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}
export function digestToolInvocation(toolName, args) {
    return createHash("sha256").update("mcp-execution-handoff/invocation/v1\0").update(toolName).update("\0").update(canonicalJson(args)).digest("hex");
}
//# sourceMappingURL=invocation.js.map