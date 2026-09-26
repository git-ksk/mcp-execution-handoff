import {
  HostedWorkerRegistry,
  type HostedWorkerRouteLease
} from "./hosted-worker.js";

export type HostedOperatorBindingErrorCode =
  | "HOSTED_OPERATOR_SESSION_INVALID"
  | "HOSTED_OPERATOR_SESSION_EXPIRED"
  | "HOSTED_OPERATOR_SESSION_MISMATCH"
  | "HOSTED_OPERATOR_VIEWER_STALE";

export class HostedOperatorBindingError extends Error {
  constructor(public readonly code: HostedOperatorBindingErrorCode, message: string) {
    super(message);
    this.name = "HostedOperatorBindingError";
  }
}

/**
 * Structural reference to an operator/viewer session owned by an existing Handoff surface.
 *
 * This is not durable recovery state and does not issue authority. The authoritative operator
 * session implementation remains the existing surface/session manager.
 */
export interface HostedOperatorSessionReference {
  sessionId: string;
  interventionId: string;
  epoch: number;
  principalBinding: string;
  expiresAt: number;
  viewerGeneration: number;
}

export interface HostedOperatorRouteBinding {
  readonly operator: HostedOperatorSessionReference;
  readonly worker: HostedWorkerRouteLease;
}

const SESSION_KEYS = new Set([
  "sessionId",
  "interventionId",
  "epoch",
  "principalBinding",
  "expiresAt",
  "viewerGeneration"
]);

function boundedString(value: unknown, min: number, max: number): value is string {
  return typeof value === "string"
    && value.length >= min
    && value.length <= max
    && !/[\0\r\n]/.test(value);
}

export function parseHostedOperatorSessionReference(value: unknown): HostedOperatorSessionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_INVALID",
      "Invalid hosted operator session reference"
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !SESSION_KEYS.has(key))
    || !boundedString(record.sessionId, 1, 160)
    || !boundedString(record.interventionId, 1, 160)
    || !Number.isSafeInteger(record.epoch) || Number(record.epoch) < 0
    || !boundedString(record.principalBinding, 16, 160)
    || !Number.isSafeInteger(record.expiresAt) || Number(record.expiresAt) < 0
    || !Number.isSafeInteger(record.viewerGeneration) || Number(record.viewerGeneration) <= 0) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_INVALID",
      "Invalid hosted operator session reference"
    );
  }
  return {
    sessionId: record.sessionId as string,
    interventionId: record.interventionId as string,
    epoch: record.epoch as number,
    principalBinding: record.principalBinding as string,
    expiresAt: record.expiresAt as number,
    viewerGeneration: record.viewerGeneration as number
  };
}

function sameSessionIdentity(
  expected: HostedOperatorSessionReference,
  current: HostedOperatorSessionReference
): boolean {
  return expected.sessionId === current.sessionId
    && expected.interventionId === current.interventionId
    && expected.epoch === current.epoch
    && expected.principalBinding === current.principalBinding;
}

function assertSessionLive(session: HostedOperatorSessionReference, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_INVALID",
      "Invalid hosted operator session time"
    );
  }
  if (session.expiresAt <= now) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_EXPIRED",
      "Hosted operator session expired"
    );
  }
}

/**
 * Compose an existing operator session with one current worker route without creating another FSM.
 *
 * The two lifetimes stay independent:
 * - operator TTL / viewer generation come from the surface session manager;
 * - worker connection / worker generation come from HostedWorkerRegistry.
 */
export function bindHostedOperatorSession(
  operatorValue: unknown,
  worker: HostedWorkerRouteLease,
  registry: HostedWorkerRegistry,
  now: number = Date.now()
): HostedOperatorRouteBinding {
  const operator = parseHostedOperatorSessionReference(operatorValue);
  assertSessionLive(operator, now);
  registry.assertCurrent(worker);
  if (operator.interventionId !== worker.interventionId
    || operator.epoch !== worker.epoch
    || operator.principalBinding !== worker.principalBinding) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_MISMATCH",
      "Hosted operator session does not match the worker route"
    );
  }
  return {
    operator: { ...operator },
    worker: { ...worker }
  };
}

/**
 * Revalidate a process-local hosted binding against both authoritative current states.
 *
 * Worker reconnect may rotate only the worker generation while leaving the operator TTL and viewer
 * generation unchanged. Viewer reconnect may rotate only the viewer generation. Neither rotation
 * is accepted by an old binding; the caller must explicitly create a fresh composed binding.
 */
export function assertHostedOperatorBindingCurrent(
  binding: HostedOperatorRouteBinding,
  currentOperatorValue: unknown,
  registry: HostedWorkerRegistry,
  now: number = Date.now()
): void {
  const bound = parseHostedOperatorSessionReference(binding.operator);
  const current = parseHostedOperatorSessionReference(currentOperatorValue);
  assertSessionLive(current, now);

  if (!sameSessionIdentity(bound, current) || bound.expiresAt !== current.expiresAt) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_MISMATCH",
      "Hosted operator session identity changed"
    );
  }
  if (bound.viewerGeneration !== current.viewerGeneration) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_VIEWER_STALE",
      "Hosted operator viewer generation is stale"
    );
  }

  registry.assertCurrent(binding.worker);
  if (binding.worker.interventionId !== current.interventionId
    || binding.worker.epoch !== current.epoch
    || binding.worker.principalBinding !== current.principalBinding) {
    throw new HostedOperatorBindingError(
      "HOSTED_OPERATOR_SESSION_MISMATCH",
      "Hosted operator session no longer matches the worker route"
    );
  }
}
