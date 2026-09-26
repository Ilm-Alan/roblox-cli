/** Native tool results are normalized internally before crossing the agent boundary. */
import { RequestFailure, RoutingFailure } from './bridge-service.js';
import type { RequestStatus } from './bridge-service.js';
import { CliCommandError } from './cli-errors.js';
import type { JobProgress } from './test-jobs.js';

export interface ToolInvocationContext {
  signal: AbortSignal;
  requestId?: string;
  job?: JobProgress;
}

export function normalizeCommandResult(raw: any): any {
  if (!raw || typeof raw !== 'object') return { result: raw ?? null };
  if (raw.structuredContent) {
    return { ...raw.structuredContent, ...(raw.isError ? { isError: true } : {}) };
  }
  if (raw.content?.length === 1 && raw.content[0].type === 'text') {
    try {
      const parsed = JSON.parse(raw.content[0].text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...parsed, ...(raw.isError ? { isError: true } : {}) };
      }
      return { result: parsed, ...(raw.isError ? { isError: true } : {}) };
    } catch { /* Human-readable output and binary content retain their original representation. */ }
  }
  return raw;
}

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

/**
 * Shape a plugin eval envelope (`values`/`valueTypes`, one entry per returned
 * value) into the public eval payload. The plugin cannot emit JSON null, so a
 * returned nil arrives as a placeholder whose type is "nil".
 */
export function publicEvaluation(value: unknown): JsonObject {
  const body = asObject(value);
  const types = Array.isArray(body.valueTypes) ? body.valueTypes as unknown[] : [];
  const values = (Array.isArray(body.values) ? body.values as unknown[] : [])
    .map((entry, index) => types[index] === 'nil' ? null : entry);
  return {
    ...(values.length === 1 ? { result: values[0], ...(typeof types[0] === 'string' ? { result_type: types[0] } : {}) } : {}),
    ...(values.length > 1 ? { results: values, result_types: types } : {}),
    ...(Array.isArray(body.output) && body.output.length > 0 ? { output: body.output } : {}),
    ...(typeof body.undo === 'string' ? { undo: body.undo } : {}),
    ...(body.bridge === undefined || body.bridge === 'ok' ? {} : { bridge: body.bridge }),
  };
}

/** The failure message of a plugin eval envelope, or undefined when the Luau ran to completion. */
export function evaluationError(value: unknown): string | undefined {
  const body = asObject(value);
  if (body.error === undefined && body.isError !== true && body.success !== false && body.ok !== false) return undefined;
  const detail = body.error;
  if (typeof detail === 'string') return detail;
  const message = asObject(detail).message;
  return typeof message === 'string' ? message : 'Luau evaluation failed.';
}

/**
 * Request records are a recovery API, not a leak of BridgeService's internal
 * field names. Keep the lifecycle vocabulary explicit, but only expose the
 * data an agent needs to decide whether it can retry or consume a result.
 * An eval operation reports the same payload the live eval command returned.
 */
export function publicRequestStatus(status: RequestStatus, evaluation?: { target: string }): Record<string, unknown> {
  const execution = status.state === 'pending'
    ? 'pending'
    : status.executionOutcome === 'not_executed'
      ? 'not_started'
      : status.executionOutcome === 'error'
        ? 'failed'
        : status.executionOutcome === 'success'
          ? 'success'
          : 'unknown';
  let result: JsonObject = {};
  if (status.response !== undefined && evaluation !== undefined) {
    const response = normalizeCommandResult(status.response);
    const payload = {
      target: evaluation.target,
      duration_ms: (status.settledAt ?? Date.now()) - status.queuedAt,
      ...publicEvaluation(response),
    };
    const failure = evaluationError(response);
    result = failure === undefined
      ? { result: payload }
      : { error: { code: 'evaluation_failed', message: failure.slice(0, 1000), details: payload } };
  } else if (status.response !== undefined) {
    result = { result: normalizeCommandResult(status.response) };
  }
  const error = status.error === undefined ? {} : { error: publicStoredError(status.error) };
  const unavailable = status.resultUnavailable === undefined ? {} : {
    result_unavailable: {
      reason: status.resultUnavailable.reason,
      ...(status.resultUnavailable.bytes === undefined ? {} : { bytes: status.resultUnavailable.bytes }),
      limit_bytes: status.resultUnavailable.limitBytes,
    },
  };
  return {
    state: status.state,
    stage: status.stage,
    execution,
    ...(status.dispatchedAt === undefined ? {} : { dispatched_at: status.dispatchedAt }),
    ...(status.executionStartedAt === undefined ? {} : { execution_started_at: status.executionStartedAt }),
    ...(status.executionCompletedAt === undefined ? {} : { execution_completed_at: status.executionCompletedAt }),
    ...(status.waiterEndedAt === undefined ? {} : { waiter_ended_at: status.waiterEndedAt }),
    ...(status.settledAt === undefined ? {} : { settled_at: status.settledAt }),
    ...result,
    ...error,
    ...unavailable,
  };
}

function publicStoredError(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  if (typeof body.code === 'string' && typeof body.message === 'string') {
    return {
      code: body.code,
      message: body.message,
      ...(body.details && typeof body.details === 'object' && !Array.isArray(body.details)
        ? { details: body.details } : {}),
    };
  }
  return value;
}

function publicTopology(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const body = value as Record<string, unknown>;
  const instances = Array.isArray(body.instances) ? body.instances.map((entry) => {
    const instance = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown> : {};
    const peers = instance.peers && typeof instance.peers === 'object' && !Array.isArray(instance.peers)
      ? instance.peers as Record<string, unknown> : {};
    return {
      ...(instance.id === undefined ? {} : { instance_id: instance.id }),
      ...(instance.placeId === undefined ? {} : { place_id: instance.placeId }),
      ...(instance.placeName === undefined ? {} : { place_name: instance.placeName }),
      ...(instance.multiplayerGroupId === undefined ? {} : { multiplayer_group_id: instance.multiplayerGroupId }),
      roles: Object.keys(peers).sort(),
    };
  }) : [];
  const multiplayerGroups = Array.isArray(body.multiplayerGroups) ? body.multiplayerGroups.map((entry) => {
    const group = entry && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown> : {};
    const groupInstances = group.instances && typeof group.instances === 'object' && !Array.isArray(group.instances)
      ? group.instances as Record<string, unknown> : {};
    return {
      ...(group.id === undefined ? {} : { multiplayer_group_id: group.id }),
      ...(group.controllerInstanceId === undefined ? {} : { controller_instance_id: group.controllerInstanceId }),
      instance_ids: Object.keys(groupInstances).sort(),
    };
  }) : [];
  return { instances, multiplayer_groups: multiplayerGroups };
}

export function publicToolErrorBody(name: string, error: unknown): Record<string, unknown> {
  if (error instanceof CliCommandError) {
    return agentError(error.code, error.message, error.outcome, error.details);
  }
  if (error instanceof RoutingFailure) {
    return {
      error: {
        code: error.routingError.code,
        message: error.routingError.message,
        execution: 'not_started',
        retry: 'after_fix',
        details: { topology: publicTopology(error.routingError.data) },
      },
    };
  }
  if (error instanceof RequestFailure) {
    const details = error.details;
    const requestId = details.requestId;
    // Studio reports what happened to the handler when it knows: a handler
    // error is a completed failure the caller can fix and retry, not an
    // unknown outcome that forbids a retry.
    const execution = details.outcome === 'not_executed' || details.executionOutcome === 'not_executed'
      ? 'not_started'
      : details.executionOutcome === 'error'
        ? 'failed'
        : details.executionOutcome === 'success'
          ? 'success'
          : 'unknown';
    return {
      error: {
        code: error.code,
        message: error.message.slice(0, 1000),
        execution,
        retry: execution === 'not_started' || execution === 'failed' ? 'after_fix' : 'never',
        ...(execution === 'unknown' || execution === 'success' ? {
          request_id: requestId,
          next: `roblox status --request-id ${requestId}`,
        } : {}),
        details: {
          stage: details.stage,
          target_peer_id: details.targetPeerId,
          ...(details.transportStage ? { transport_stage: details.transportStage } : {}),
          ...(details.bytes === undefined ? {} : { bytes: details.bytes }),
          ...(details.limitBytes === undefined ? {} : { limit_bytes: details.limitBytes }),
        },
      },
    };
  }
  console.error(`[command:${name}]`, error);
  return {
    error: {
      code: 'command_failed',
      message: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      execution: 'unknown',
      retry: 'never',
    },
  };
}

function agentError(
  code: string,
  message: string,
  outcome: 'success' | 'error' | 'not_executed' | 'unknown',
  details?: Record<string, unknown>,
): Record<string, unknown> {
  const execution = outcome === 'not_executed' ? 'not_started' : outcome === 'unknown' ? 'unknown' : 'failed';
  const { next, ...remaining } = details ?? {};
  return {
    error: {
      code,
      message: message.slice(0, 1000),
      execution,
      retry: execution === 'not_started' ? 'after_fix' : 'never',
      ...(typeof next === 'string' ? { next } : {}),
      ...(Object.keys(remaining).length > 0 ? { details: remaining } : {}),
    },
  };
}
