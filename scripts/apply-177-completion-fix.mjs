import { readFileSync, writeFileSync } from "node:fs";

function replaceExactly(path, before, after) {
  const source = readFileSync(path, "utf8");
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`${path}: expected patch context not found`);
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${path}: patch context is not unique`);
  }
  writeFileSync(path, source.slice(0, first) + after + source.slice(first + before.length));
}

replaceExactly(
  "src/browser-takeover/websocket-takeover.ts",
  `      if (message.kind === "ping") {
        await this.runBoundUse(async () => {
          await this.peer.sendControl(
            message.nonce === undefined
              ? { kind: "pong" }
              : { kind: "pong", nonce: message.nonce }
          );
        });
        return;
      }`,
  `      if (message.kind === "ping") {
        await this.runBoundUse(async () => {
          this.notifyObserveOnly(
            message.nonce === undefined
              ? { kind: "pong" }
              : { kind: "pong", nonce: message.nonce }
          );
        });
        return;
      }`
);

replaceExactly(
  "src/browser-takeover/websocket-takeover.ts",
  `  /** Terminal messages are finite, best-effort hints; late outcomes cannot change authority. */
  private notifyTerminal(`,
  `  /** Observe-only feedback must never hold terminal authority cleanup on peer delivery. */
  private notifyObserveOnly(
    message: Extract<WebSocketTakeoverServerMessage, { kind: "pong" }>
  ): void {
    try {
      void Promise.resolve(this.peer.sendControl(message)).catch(() => undefined);
    } catch {
      // Pong delivery is transport feedback only and cannot alter authority state.
    }
  }

  /** Terminal messages are finite, best-effort hints; late outcomes cannot change authority. */
  private notifyTerminal(`
);

replaceExactly(
  "src/browser-takeover/broker.ts",
  `const ALLOW_ALL_WEBRTC_INPUT: WebRtcHumanInputPolicy = Object.freeze({
  tap: true,
  scroll: true,
  text: true,
  key: true
});

export class TakeoverBroker {`,
  `const ALLOW_ALL_WEBRTC_INPUT: WebRtcHumanInputPolicy = Object.freeze({
  tap: true,
  scroll: true,
  text: true,
  key: true
});

type CompletionFinalizationOutcome =
  | "completed"
  | "runtime_revoke_failed"
  | "completion_handler_failed";

export class TakeoverBroker {`
);

replaceExactly(
  "src/browser-takeover/broker.ts",
  `  private readonly completionDelivered = new Set<string>();
  private readonly completionGraceMs: number;`,
  `  private readonly completionDelivered = new Set<string>();
  private readonly completionFinalizations = new Map<string, Promise<CompletionFinalizationOutcome>>();
  private readonly completionGraceMs: number;`
);

replaceExactly(
  "src/browser-takeover/broker.ts",
  `    if (operation === "complete") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (!this.sameOriginMutation(request)) return json(403, { error: "origin_not_allowed" });
      const completionCapability = this.readCompletionCapability(request.headers.get("x-mcp-takeover-completion"));
      if (!completionCapability) return json(404, { error: "takeover_unavailable" });
      const wasNative = this.nativeOnlySessions.has(id);
      const wasWebRtc = this.webRtcOnlySessions.has(id);
      let completion;
      try {
        completion = this.sessions.complete(id, completionCapability, boundPrincipal);
      } catch (error) {
        if (error instanceof TakeoverSessionError) return json(404, { error: "takeover_unavailable" });
        throw error;
      }
      this.nativeOnlySessions.delete(id);
      this.webRtcOnlySessions.delete(id);
      this.webSocketOnlySessions.delete(id);
      this.webSocketRevokeHandlers.delete(id);
      this.nativeTargetProcessIds.delete(id);
      this.nativeTargetWindowIds.delete(id);
      this.webRtcTargetProcessIds.delete(id);
      this.webRtcTargetWindowIds.delete(id);
      this.webRtcInputPolicies.delete(id);
      try {
        if (wasNative) await this.nativeRuntime?.revoke(id);
        if (wasWebRtc) await this.webRtcRuntime?.revoke(id);
      } catch {
        return json(503, { error: "takeover_runtime_revoke_failed", revoked: true });
      }
      if (!this.completionDelivered.has(id)) {
        try {
          await this.hooks.completed?.({
            interventionId: completion.interventionId,
            epoch: completion.epoch
          });
          this.completionDelivered.add(id);
        } catch {
          return json(503, { error: "takeover_completion_handler_failed", revoked: true });
        }
      }
      return json(200, { done: true, alreadyDone: completion.alreadyCompleted });
    }`,
  `    if (operation === "complete") {
      if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
      if (!this.sameOriginMutation(request)) return json(403, { error: "origin_not_allowed" });
      const completionCapability = this.readCompletionCapability(request.headers.get("x-mcp-takeover-completion"));
      if (!completionCapability) return json(404, { error: "takeover_unavailable" });
      const wasNative = this.nativeOnlySessions.has(id);
      const wasWebRtc = this.webRtcOnlySessions.has(id);
      let completion;
      try {
        completion = this.sessions.complete(id, completionCapability, boundPrincipal);
      } catch (error) {
        if (error instanceof TakeoverSessionError) return json(404, { error: "takeover_unavailable" });
        throw error;
      }

      let finalization = this.completionFinalizations.get(id);
      if (!finalization) {
        const started = this.finalizeCompletion(id, completion, wasNative, wasWebRtc);
        let tracked!: Promise<CompletionFinalizationOutcome>;
        tracked = started.finally(() => {
          if (this.completionFinalizations.get(id) === tracked) {
            this.completionFinalizations.delete(id);
          }
        });
        this.completionFinalizations.set(id, tracked);
        finalization = tracked;
      }

      const outcome = await finalization;
      if (outcome === "runtime_revoke_failed") {
        return json(503, { error: "takeover_runtime_revoke_failed", revoked: true });
      }
      if (outcome === "completion_handler_failed") {
        return json(503, { error: "takeover_completion_handler_failed", revoked: true });
      }
      return json(200, { done: true, alreadyDone: completion.alreadyCompleted });
    }`
);

replaceExactly(
  "src/browser-takeover/broker.ts",
  `  private createExperimentalWebSocketSession(
    intervention: TakeoverInterventionRef,`,
  `  private async finalizeCompletion(
    sessionId: string,
    completion: TakeoverCompletionResult,
    wasNative: boolean,
    wasWebRtc: boolean
  ): Promise<CompletionFinalizationOutcome> {
    try {
      if (wasNative) await this.nativeRuntime?.revoke(sessionId);
      if (wasWebRtc) await this.webRtcRuntime?.revoke(sessionId);
    } catch {
      // Keep route ownership until an explicit retry confirms required runtime teardown.
      return "runtime_revoke_failed";
    }

    this.nativeOnlySessions.delete(sessionId);
    this.webRtcOnlySessions.delete(sessionId);
    this.webSocketOnlySessions.delete(sessionId);
    this.webSocketRevokeHandlers.delete(sessionId);
    this.nativeTargetProcessIds.delete(sessionId);
    this.nativeTargetWindowIds.delete(sessionId);
    this.webRtcTargetProcessIds.delete(sessionId);
    this.webRtcTargetWindowIds.delete(sessionId);
    this.webRtcInputPolicies.delete(sessionId);

    if (!this.completionDelivered.has(sessionId)) {
      try {
        await this.hooks.completed?.({
          interventionId: completion.interventionId,
          epoch: completion.epoch
        });
        this.completionDelivered.add(sessionId);
      } catch {
        return "completion_handler_failed";
      }
    }
    return "completed";
  }

  private createExperimentalWebSocketSession(
    intervention: TakeoverInterventionRef,`
);

console.log("applied #177 completion lifecycle patch");
