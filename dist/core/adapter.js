export function defineExecutionAdapter(kind, control) {
    const normalized = kind.trim();
    if (!normalized || normalized.length > 80)
        throw new Error("execution adapter kind must contain 1-80 characters");
    return { kind: normalized, control };
}
//# sourceMappingURL=adapter.js.map