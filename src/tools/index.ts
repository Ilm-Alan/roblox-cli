import { StudioHttpClient } from './studio-client.js';
import { BridgeService, RoutingFailure } from '../bridge-service.js';
import type { PublicStudioPeer } from '../bridge-service.js';
import {
  parseStudioProcessEnvironmentPatch,
  parseStudioWorkingDirectory,
  StudioInstanceManager,
  type ManagedStudioInstance,
  type StudioLaunchSource,
} from '../studio-instance-manager.js';
import { rgbaToJpeg } from '../jpeg-encoder.js';
import { rgbaToPng } from '../png-encoder.js';
import { basename } from 'node:path';

type RawImageCaptureResponse = {
  success?: boolean;
  error?: string;
  width?: number;
  height?: number;
  nativeWidth?: number;
  nativeHeight?: number;
  data?: string;
  instancePath?: string;
  instanceName?: string;
  cameraPreset?: string;
  solidMagenta?: boolean;
  encodedData?: string;
  encodedMimeType?: 'image/jpeg' | 'image/png';
  captureSource?: string;
};

type EncodedViewportCapture = {
  success: true;
  width: number;
  height: number;
  format: 'jpeg' | 'png';
  quality?: number;
  note: string;
  data: string;
  mimeType: string;
  message: string;
  attempts?: number;
} | {
  success: false;
  error: string;
  attempts?: number;
};

type StudioToolResponse = Record<string, unknown> & {
  success?: boolean;
  error?: string;
  message?: string;
  testId?: string;
  testArgs?: unknown;
  players?: unknown;
  playerCount?: number;
  session?: {
    phase?: string;
    testId?: string;
    numPlayers?: number;
    testArgs?: unknown;
    result?: unknown;
    error?: unknown;
  };
};

const MAX_INLINE_IMAGE_BYTES = 6_000_000;
const RUNTIME_LOG_PEER_TIMEOUT_MS = 5_000;
const RUNTIME_LOG_CURSOR_PEER_LIMIT = 64;
const RUNTIME_HEALTH_PEER_TIMEOUT_MS = 2_500;
const CAPTURE_RETRY_ATTEMPTS = 3;
const CAPTURE_RETRY_DELAY_MS = 150;

// Encodes the raw RGBA capture into the requested image format.
// - 'png': lossless — sharpest text/UI, but a busy 3D scene can be large.
// - 'jpeg': default; quality 92 with 4:4:4 chroma (no subsampling) keeps text
//   crisp at ~1/3 the size. The image rides back inline as a CLI result,
//   so JPEG is the safe default for staying under client result-size caps.
function encodeImageFromRgbaResponse(
  response: RawImageCaptureResponse,
  format: 'jpeg' | 'png',
  quality: number,
): { buffer: Buffer; mimeType: string } {
  if (!response.data || response.width === undefined || response.height === undefined) {
    throw new Error('Render response missing data, width, or height');
  }
  const rgbaBuffer = Buffer.from(response.data, 'base64');
  if (format === 'png') {
    return { buffer: rgbaToPng(rgbaBuffer, response.width, response.height), mimeType: 'image/png' };
  }
  return {
    buffer: rgbaToJpeg(rgbaBuffer, response.width, response.height, quality),
    mimeType: 'image/jpeg',
  };
}

// Roblox occasionally returns a valid-looking RGBA buffer filled entirely
// with #ff00ff when CaptureService fails to read the rendered viewport. It is
// important to reject this before encoding: otherwise the CLI writes a
// successful screenshot artifact that is not evidence of the game frame.
function isSolidMagentaCapture(response: RawImageCaptureResponse): boolean {
  if (!response.data || response.width === undefined || response.height === undefined) return false;
  const expectedBytes = response.width * response.height * 4;
  if (response.width <= 0 || response.height <= 0 || expectedBytes <= 0) return false;
  const rgbaBuffer = Buffer.from(response.data, 'base64');
  if (rgbaBuffer.length < expectedBytes) return false;
  for (let offset = 0; offset < expectedBytes; offset += 4) {
    if (
      rgbaBuffer[offset] !== 255 ||
      rgbaBuffer[offset + 1] !== 0 ||
      rgbaBuffer[offset + 2] !== 255 ||
      rgbaBuffer[offset + 3] !== 255
    ) {
      return false;
    }
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function copyKnownFields(
  value: unknown,
  fields: Array<[string, string]>,
): Record<string, unknown> {
  const source = objectRecord(value);
  const result: Record<string, unknown> = {};
  for (const [from, to] of fields) {
    if (source[from] !== undefined) result[to] = source[from];
  }
  return result;
}

function publicRuntimeHealth(value: unknown, role: string): Record<string, unknown> {
  const body = objectRecord(value);
  return {
    role,
    ...(typeof body.error === 'string' ? { error: body.error } : {}),
    ...(body.isRunning === undefined ? {} : { is_running: body.isRunning }),
    ...(body.isEditMode === undefined ? {} : { is_edit_mode: body.isEditMode }),
    ...(body.isRunMode === undefined ? {} : { is_run_mode: body.isRunMode }),
    render: copyKnownFields(body.render, [
      ['available', 'available'],
      ['rendering', 'rendering'],
      ['state', 'state'],
      ['secondsSinceFrame', 'seconds_since_frame'],
      ['lastFrameAt', 'last_frame_at'],
      ['frameCount', 'frame_count'],
      ['frameTimeMs', 'frame_time_ms'],
    ]),
    capture: copyKnownFields(body.capture, [
      ['probeRequested', 'probe_requested'],
      ['serviceAvailable', 'service_available'],
      ['callbackFired', 'callback_fired'],
      ['pixelsReadable', 'pixels_readable'],
      ['usable', 'usable'],
      ['solidMagenta', 'solid_magenta'],
      ['pixelProbe', 'pixel_probe'],
      ['width', 'width'],
      ['height', 'height'],
      ['error', 'error'],
    ]),
    readiness: copyKnownFields(body.readiness, [
      ['attribute', 'attribute'],
      ['present', 'present'],
      ['value', 'value'],
      ['fired', 'fired'],
    ]),
  };
}

export class RobloxStudioTools {
  private client: StudioHttpClient;
  private bridge: BridgeService;
  private instanceManager: StudioInstanceManager;
  private managedConnectionAssociations: Promise<void> = Promise.resolve();

  constructor(bridge: BridgeService) {
    this.client = new StudioHttpClient(bridge);
    this.bridge = bridge;
    this.instanceManager = new StudioInstanceManager();
    this.bridge.onPeerRegistered((peer) => {
      const instanceManager = this.instanceManager;
      const association = this.managedConnectionAssociations.then(() =>
        this._associateManagedEditConnection(peer, instanceManager),
      );
      this.managedConnectionAssociations = association.catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        console.warn(
          `[roblox-cli] managed Studio connection association failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    });
  }

  getStudioLifecycleCapabilities() {
    return this.instanceManager.getLifecycleCapabilities();
  }

  private _textResult(body: Record<string, unknown>) {
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  private _parseTextResult(result: unknown): Record<string, unknown> {
    if (
      result === null ||
      typeof result !== 'object' ||
      !('content' in result) ||
      !Array.isArray(result.content)
    ) {
      return {};
    }
    const first = result.content[0];
    if (first === null || typeof first !== 'object' || !('text' in first) || typeof first.text !== 'string') {
      return {};
    }
    try {
      const parsed: unknown = JSON.parse(first.text);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
    } catch {
      return {};
    }
  }

  private _briefRoles(instanceId: string): { roles: string[]; runtimeRoles: string[] } {
    const roles = this._rolesForScope(instanceId);
    return {
      roles,
      runtimeRoles: roles.filter((role) => role === 'server' || /^client-\d+$/.test(role)),
    };
  }

  private _routingErrorData() {
    const instances = this.bridge.getConnectedInstances();
    const multiplayerGroups = this.bridge.getConnectedMultiplayerGroups();
    return {
      instances,
      multiplayerGroups,
      count: instances.length + multiplayerGroups.length,
    };
  }

  private _peerForRoleInScope(instanceId: string, role: string) {
    return this.bridge.getPeersInScope(instanceId).find((peer) => peer.role === role);
  }

  private _requestPeer(
    endpoint: string,
    data: unknown,
    targetPeerId: string,
    timeoutMs?: number,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<StudioToolResponse> {
    return this.client.request(endpoint, data, targetPeerId, timeoutMs, signal, operationId) as Promise<StudioToolResponse>;
  }

  private _request(
    endpoint: string,
    data: unknown,
    instanceId: string,
    role: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) {
    const peer = this._peerForRoleInScope(instanceId, role);
    if (!peer) {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: `Routing scope for instance "${instanceId}" has no role "${role}".`,
        data: this._routingErrorData(),
      });
    }
    return this._requestPeer(endpoint, data, peer.peerId, timeoutMs, signal);
  }

  // Resolve an optional Studio process plus role to one exact Peer and dispatch.
  private async _callSingle(
    endpoint: string,
    data: unknown,
    target: string | undefined,
    instance_id: string | undefined,
    timeoutMs?: number,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<StudioToolResponse> {
    const resolved = this.bridge.resolveTarget({ instance_id, target });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: this._routingErrorData(),
      });
    }
    return this._requestPeer(endpoint, data, resolved.targetPeerId, timeoutMs, signal, operationId);
  }

  // Studio 714+ exposes a plugin-only capture API that returns the visible
  // Studio viewport as a buffer. It is the reliable path for edit-mode local
  // Studio inspection; older CaptureService captures can return a solid-
  // magenta placeholder even while the viewport is visibly rendering. The
  // endpoint is optional so an older installed plugin can continue using the
  // legacy client->edit rbxtemp bridge until the plugin is refreshed. Native
  // macOS fallback belongs to the invoking CLI process, where Screen
  // Recording permission is normally granted; the detached daemon cannot
  // assume that permission.
  private async _captureStudioViewportImage(
    instanceId: string,
    format: 'jpeg' | 'png' = 'jpeg',
    quality?: number,
  ): Promise<RawImageCaptureResponse | undefined> {
    try {
      const response = await this._callSingle(
        '/api/capture-studio-screenshot',
        {},
        'edit',
        instanceId,
      );
      if (
        response.error === undefined &&
        typeof response.data === 'string' &&
        (!isSolidMagentaCapture(response) || response.captureSource !== 'StudioCaptureService')
      ) {
        return response as RawImageCaptureResponse;
      }
    } catch {
      // An older plugin, or an embedded play client, may not expose a usable
      // StudioCaptureService route. The invoking CLI owns the native fallback.
    }
    return undefined;
  }

  // Prefer the first client role in the selected process/group scope for live
  // viewport and input operations; otherwise retain the default Peer's Instance.
  private _resolveRuntime(instance_id?: string): { instanceId: string; clientRole?: string } {
    const resolved = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'A single runtime target is required.',
        data: this._routingErrorData(),
      });
    }
    const client = this.bridge.getPeersInScope(resolved.targetInstanceId)
      .filter((peer) => /^client-\d+$/.test(peer.role))
      .sort((a, b) => a.role.localeCompare(b.role) || a.peerId.localeCompare(b.peerId))[0];
    return {
      instanceId: client?.instanceId ?? resolved.targetInstanceId,
      clientRole: client?.role,
    };
  }

  private _resolveInstanceIdOnly(instance_id?: string): string {
    if (instance_id !== undefined) {
      const resolvedInstanceId = this.bridge.resolveConnectedInstanceId(instance_id);
      if (resolvedInstanceId === undefined) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: `instance_id "${instance_id}" is not connected. Pass a connected top-level or grouped role-suffixed Instance ID.`,
          data: this._routingErrorData(),
        });
      }
      return resolvedInstanceId;
    }

    const resolved = this.bridge.resolveTarget({ target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'multiple_instances_connected',
        message: 'Multiple Studio process scopes are connected. Pass instance_id to disambiguate.',
        data: this._routingErrorData(),
      });
    }
    return resolved.targetInstanceId;
  }

  private _resolveSingleTarget(
    target: string,
    instance_id?: string,
  ): { targetPeerId: string; instanceId: string; role: string } {
    const resolved = this.bridge.resolveTarget({ instance_id, target });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'Pick a specific target role for this tool.',
        data: this._routingErrorData(),
      });
    }
    return {
      targetPeerId: resolved.targetPeerId,
      instanceId: resolved.targetInstanceId,
      role: resolved.targetRole,
    };
  }


  private _rolesForScope(instanceId: string): string[] {
    return this.bridge.getPeersInScope(instanceId).map((peer) => peer.role);
  }


  private _clientRolesForScope(instanceId: string): string[] {
    return this._rolesForScope(instanceId)
      .filter((role) => /^client-\d+$/.test(role))
      .sort((a, b) => Number(a.slice('client-'.length)) - Number(b.slice('client-'.length)));
  }

  private _runtimeTargetsForScope(
    instanceId: string,
  ): { targetPeerId: string; instanceId: string; role: string }[] {
    return this.bridge.getPeersInScope(instanceId)
      .filter((peer) => peer.role === 'server' || /^client-\d+$/.test(peer.role))
      .map((peer) => ({
        targetPeerId: peer.peerId,
        instanceId: peer.instanceId,
        role: peer.role,
      }));
  }

  private async _waitForRuntimeRoles(
    instanceId: string,
    opts: { server?: boolean; clientCount?: number; absentRole?: string; noRuntime?: boolean },
    timeoutSec = 30,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const roles = this._rolesForScope(instanceId);
      const clientRoles = this._clientRolesForScope(instanceId);
      const hasServer = !opts.server || roles.includes('server');
      const hasClients = opts.clientCount === undefined || clientRoles.length >= opts.clientCount;
      const absent = opts.absentRole === undefined || !roles.includes(opts.absentRole);
      const runtimeAbsent = !opts.noRuntime || !roles.some((role) => role === 'server' || /^client-\d+$/.test(role));
      if (hasServer && hasClients && absent && runtimeAbsent) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: this._rolesForScope(instanceId),
      timedOut: true,
    };
  }

  private async _waitForExactClientCount(
    instanceId: string,
    expectedClientCount: number,
    timeoutSec = 30,
    stableMs = 3000,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; extraClients: boolean; clientCount: number }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let exactSince: number | undefined;

    while (Date.now() < deadline) {
      const roles = this._rolesForScope(instanceId);
      const clientCount = this._clientRolesForScope(instanceId).length;
      if (clientCount > expectedClientCount) {
        return { ok: false, roles, timedOut: false, extraClients: true, clientCount };
      }
      if (roles.includes('server') && clientCount === expectedClientCount) {
        exactSince ??= Date.now();
        if (Date.now() - exactSince >= stableMs) {
          return { ok: true, roles, timedOut: false, extraClients: false, clientCount };
        }
      } else {
        exactSince = undefined;
      }
      await sleep(250);
    }

    const roles = this._rolesForScope(instanceId);
    const clientCount = this._clientRolesForScope(instanceId).length;
    return { ok: false, roles, timedOut: true, extraClients: clientCount > expectedClientCount, clientCount };
  }

  private async _waitForRuntimeRolesFresh(
    instanceId: string,
    connectedAfter: number,
    requiredRoles: string[],
    timeoutSec = 60,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean }> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      const peers = this.bridge.getPeersInScope(instanceId);
      const roles = peers.map((peer) => peer.role);
      const freshRoles = new Set(
        peers
          .filter((peer) => peer.connectedAt >= connectedAfter)
          .map((peer) => peer.role),
      );
      if (requiredRoles.every((role) => freshRoles.has(role))) {
        return { ok: true, roles, timedOut: false };
      }
      await sleep(250);
    }
    return {
      ok: false,
      roles: this._rolesForScope(instanceId),
      timedOut: true,
    };
  }


  async focusViewport(
    instancePath?: string,
    from?: number,
    padding?: number,
    angleY?: number,
    instance_id?: string,
  ) {
    if (instancePath !== undefined && (typeof instancePath !== 'string' || instancePath.length === 0)) {
      throw new Error('selection path must be a non-empty instance path when provided');
    }
    if (padding !== undefined && (padding <= 0 || padding > 10)) {
      throw new Error('selection padding must be greater than 0 and at most 10');
    }
    if (angleY !== undefined && (angleY < -89 || angleY > 89)) {
      throw new Error('selection angleY must be between -89 and 89');
    }

    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/focus-viewport', {
      path: instancePath,
      from,
      padding,
      angleY,
    }, clientRole ?? 'edit', instanceId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async executeLuau(code: string, target?: string, instance_id?: string, operation_id?: string, timeoutMs?: number) {
    if (!code) {
      throw new Error('Code is required for execute_luau');
    }
    const response = await this._callSingle('/api/execute-luau', { code }, target || 'edit', instance_id, timeoutMs, undefined, operation_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalServerRuntime(code: string, instance_id?: string, operation_id?: string, timeoutMs?: number) {
    if (!code) {
      throw new Error('Code is required for eval_server_runtime');
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, 'server', instance_id, timeoutMs, undefined, operation_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async evalClientRuntime(code: string, target?: string, instance_id?: string, operation_id?: string, timeoutMs?: number) {
    if (!code) {
      throw new Error('Code is required for eval_client_runtime');
    }
    const clientTarget = target || 'client-1';
    if (!clientTarget.startsWith('client-')) {
      throw new Error(`eval_client_runtime requires target=client-N (got: ${clientTarget})`);
    }
    const response = await this._callSingle('/api/eval-runtime', { code }, clientTarget, instance_id, timeoutMs, undefined, operation_id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response)
        }
      ]
    };
  }

  async getRuntimeLogs(
    instance_id?: string,
    multiplayer_group_id?: string,
    cursor?: string,
    cursor_by_instance?: Record<string, string>,
    tail?: number,
    filter?: string,
    signal?: AbortSignal,
  ) {
    if (instance_id !== undefined && multiplayer_group_id !== undefined) {
      throw new Error('get_runtime_logs accepts only one of instance_id or multiplayer_group_id.');
    }
    if (cursor !== undefined && cursor_by_instance !== undefined) {
      throw new Error('get_runtime_logs accepts only one of cursor or cursor_by_instance.');
    }
    if (tail !== undefined && (!Number.isInteger(tail) || tail < 0)) {
      throw new Error('get_runtime_logs tail must be a non-negative integer.');
    }

    // Discovery may use a cached proxy view, but log fanout must not target peers
    // that the primary has already removed during playtest teardown.
    const refresh = this.bridge.refreshTopologyForRouting(signal);
    if (refresh) await refresh;

    const instances = this.bridge.getInstances();
    const groups = this.bridge.getMultiplayerGroups();
    let selectedGroup = multiplayer_group_id === undefined
      ? undefined
      : groups.find((group) => group.id === multiplayer_group_id);
    let selectedInstanceId = instance_id === undefined
      ? undefined
      : this._resolveInstanceIdOnly(instance_id);

    if (multiplayer_group_id !== undefined && !selectedGroup) {
      throw new RoutingFailure({
        code: 'unrecognized_instance_id',
        message: `multiplayer_group_id "${multiplayer_group_id}" is not connected.`,
        data: this._routingErrorData(),
      });
    }
    if (selectedInstanceId !== undefined && !instances.some((instance) => instance.id === selectedInstanceId)) {
      throw new RoutingFailure({
        code: 'unrecognized_instance_id',
        message: `instance_id "${selectedInstanceId}" is not connected. Pass a connected top-level or grouped role-suffixed Instance ID.`,
        data: this._routingErrorData(),
      });
    }

    if (selectedGroup === undefined && selectedInstanceId === undefined) {
      const groupedInstanceIds = new Set(groups.flatMap((group) => group.instanceIds));
      const standaloneInstanceIds = instances
        .map((instance) => instance.id)
        .filter((id) => !groupedInstanceIds.has(id));
      const scopeCount = groups.length + standaloneInstanceIds.length;
      if (scopeCount === 0) {
        throw new RoutingFailure({
          code: 'unrecognized_instance_id',
          message: 'No Studio plugin is connected.',
          data: this._routingErrorData(),
        });
      }
      if (scopeCount > 1) {
        throw new RoutingFailure({
          code: 'multiple_instances_connected',
          message: 'Multiple Studio process scopes are connected. Pass instance_id or multiplayer_group_id.',
          data: this._routingErrorData(),
        });
      }
      if (groups.length === 1) {
        selectedGroup = groups[0];
      } else {
        selectedInstanceId = standaloneInstanceIds[0];
      }
    }

    if (selectedGroup !== undefined && cursor !== undefined) {
      throw new Error('Use cursor_by_instance when reading a multiplayer group.');
    }
    if (selectedGroup === undefined && cursor_by_instance !== undefined) {
      throw new Error('Use cursor when reading one Instance.');
    }

    type RuntimeLogCursorPayload = {
      version: 1;
      instanceId: string;
      peers: Record<string, number>;
    };
    type RuntimeLogPeerSuccess = {
      peerId: string;
      role: string;
      entries: unknown[];
      nextSince: number;
      droppedSinceCursor: number;
      omittedByTail: number;
    };
    type RuntimeLogPeerError = {
      peerId: string;
      role: string;
      error: string;
    };
    type RuntimeLogGap = { role: string; instance_id: string; dropped: number };
    type RuntimeLogInstanceResult =
      | {
        instanceId: string;
        entries: unknown[];
        dropped: number;
        omittedByTail: number;
        gaps: RuntimeLogGap[];
        nextCursor: string;
        peerErrors?: RuntimeLogPeerError[];
      }
      | {
        instanceId: string;
        error: string;
        nextCursor: string;
        peerErrors: RuntimeLogPeerError[];
      };

    const decodeCursor = (value: string | undefined, instanceId: string): Record<string, number> => {
      if (value === undefined) return {};
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      } catch {
        throw new Error(`get_runtime_logs received an invalid cursor for Instance "${instanceId}".`);
      }
      if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
        throw new Error(`get_runtime_logs received an invalid cursor for Instance "${instanceId}".`);
      }
      const payload = decoded as Record<string, unknown>;
      if (
        payload.version !== 1 ||
        payload.instanceId !== instanceId ||
        typeof payload.peers !== 'object' ||
        payload.peers === null ||
        Array.isArray(payload.peers)
      ) {
        throw new Error(`get_runtime_logs cursor does not belong to Instance "${instanceId}".`);
      }
      const peers = payload.peers as Record<string, unknown>;
      const parsed: Record<string, number> = {};
      for (const [peerId, nextSince] of Object.entries(peers)) {
        if (typeof nextSince !== 'number' || !Number.isInteger(nextSince) || nextSince < 0) {
          throw new Error(`get_runtime_logs received an invalid cursor for Instance "${instanceId}".`);
        }
        parsed[peerId] = nextSince;
      }
      return parsed;
    };

    const encodeCursor = (instanceId: string, peers: Record<string, number>): string => {
      const orderedPeers: Record<string, number> = {};
      for (const peerId of Object.keys(peers).sort()) orderedPeers[peerId] = peers[peerId];
      const payload: RuntimeLogCursorPayload = {
        version: 1,
        instanceId,
        peers: orderedPeers,
      };
      return Buffer.from(JSON.stringify(payload)).toString('base64url');
    };

    const roleRank = (role: string): number => {
      if (role === 'edit') return 0;
      if (role === 'server') return 1;
      const client = /^client-(\d+)$/.exec(role);
      return client ? 2 + Number(client[1]) : Number.MAX_SAFE_INTEGER;
    };

    const entryTimestamp = (entry: unknown): number => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return 0;
      const record = entry as Record<string, unknown>;
      return typeof record.ts === 'number' ? record.ts : 0;
    };

    const publicEntry = (entry: unknown): unknown => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
      const record = entry as Record<string, unknown>;
      const copy: Record<string, unknown> = { ...record };
      delete copy.seq;
      return copy;
    };

    const readInstance = async (
      instanceId: string,
      instanceCursor: string | undefined,
    ): Promise<RuntimeLogInstanceResult> => {
      const peers = this.bridge.getPeers()
        .filter((peer) => peer.instanceId === instanceId)
        .sort((a, b) => roleRank(a.role) - roleRank(b.role) || a.peerId.localeCompare(b.peerId));
      const priorByPeer = decodeCursor(instanceCursor, instanceId);
      const nextByPeer: Record<string, number> = {};
      for (const peer of peers) {
        const prior = priorByPeer[peer.peerId];
        if (prior !== undefined) nextByPeer[peer.peerId] = prior;
      }
      // A Peer absent from this read (reconnecting, or a play DataModel between
      // sessions) keeps its position, so its buffer is not replayed when it
      // returns. Retention is bounded so a long-lived cursor cannot grow forever.
      let retained = Object.keys(nextByPeer).length;
      for (const [peerId, prior] of Object.entries(priorByPeer)) {
        if (retained >= RUNTIME_LOG_CURSOR_PEER_LIMIT) break;
        if (nextByPeer[peerId] !== undefined) continue;
        nextByPeer[peerId] = prior;
        retained++;
      }
      if (peers.length === 0) {
        return {
          instanceId,
          error: 'No connected Peer exists for this Instance.',
          nextCursor: encodeCursor(instanceId, nextByPeer),
          peerErrors: [],
        };
      }

      const reads = await Promise.all(peers.map(async (peer): Promise<RuntimeLogPeerSuccess | RuntimeLogPeerError> => {
        const data: Record<string, unknown> = {};
        const peerSince = priorByPeer[peer.peerId];
        if (peerSince !== undefined) data.since = peerSince;
        if (tail !== undefined) data.tail = tail;
        if (filter !== undefined) data.filter = filter;
        try {
          const responseValue: unknown = await this.client.request(
            '/api/get-runtime-logs',
            data,
            peer.peerId,
            RUNTIME_LOG_PEER_TIMEOUT_MS,
            signal,
          );
          if (typeof responseValue !== 'object' || responseValue === null || Array.isArray(responseValue)) {
            return {
              peerId: peer.peerId,
              role: peer.role,
              error: 'Studio returned an invalid runtime log response.',
            };
          }
          const response = responseValue as Record<string, unknown>;
          if (typeof response.error === 'string') {
            return { peerId: peer.peerId, role: peer.role, error: response.error };
          }
          if (
            !Array.isArray(response.entries) ||
            typeof response.nextSince !== 'number' ||
            typeof response.droppedSinceCursor !== 'number' ||
            typeof response.omittedByTail !== 'number'
          ) {
            return {
              peerId: peer.peerId,
              role: peer.role,
              error: 'Studio returned an invalid runtime log response.',
            };
          }
          return {
            peerId: peer.peerId,
            role: peer.role,
            entries: response.entries,
            nextSince: response.nextSince,
            droppedSinceCursor: response.droppedSinceCursor,
            omittedByTail: response.omittedByTail,
          };
        } catch (error) {
          if (signal?.aborted) throw error;
          return { peerId: peer.peerId, role: peer.role, error: errorMessage(error) };
        }
      }));

      const successful: RuntimeLogPeerSuccess[] = [];
      const peerErrors: RuntimeLogPeerError[] = [];
      for (const read of reads) {
        if ('error' in read) {
          peerErrors.push(read);
        } else {
          successful.push(read);
          nextByPeer[read.peerId] = read.nextSince;
        }
      }
      const nextCursor = encodeCursor(instanceId, nextByPeer);
      if (successful.length === 0) {
        return {
          instanceId,
          error: 'Every connected Peer failed to read its runtime log buffer.',
          nextCursor,
          peerErrors,
        };
      }

      let insertionOrder = 0;
      const merged = successful.flatMap((read) =>
        read.entries.map((entry) => ({
          entry: publicEntry(entry),
          timestamp: entryTimestamp(entry),
          insertionOrder: insertionOrder++,
        }))
      );
      merged.sort((a, b) => a.timestamp - b.timestamp || a.insertionOrder - b.insertionOrder);
      const allEntries = merged.map((item) => item.entry);
      const entries = tail === undefined
        ? allEntries
        : tail === 0
          ? []
          : allEntries.slice(-tail);
      // Each Peer's cursor already moved past entries the merged tail cut, so
      // they are reported as omitted rather than silently skipped.
      let dropped = 0;
      let omittedByTail = allEntries.length - entries.length;
      const gaps: RuntimeLogGap[] = [];
      for (const read of successful) {
        dropped += read.droppedSinceCursor;
        omittedByTail += read.omittedByTail;
        if (read.droppedSinceCursor > 0) gaps.push({ role: read.role, instance_id: instanceId, dropped: read.droppedSinceCursor });
      }
      return {
        instanceId,
        entries,
        dropped,
        omittedByTail,
        gaps,
        nextCursor,
        ...(peerErrors.length > 0 ? { peerErrors } : {}),
      };
    };

    if (selectedGroup) {
      const connectedIds = new Set(instances.map((instance) => instance.id));
      const instanceIds = selectedGroup.instanceIds.filter((id) => connectedIds.has(id));
      const results = await Promise.all(instanceIds.map((instanceId) =>
        readInstance(instanceId, cursor_by_instance?.[instanceId])
      ));
      const nextCursorByInstance: Record<string, string> = {};
      for (const result of results) nextCursorByInstance[result.instanceId] = result.nextCursor;
      return this._textResult({
        multiplayerGroupId: selectedGroup.id,
        instances: results,
        nextCursorByInstance,
      });
    }

    const result = await readInstance(selectedInstanceId as string, cursor);
    if ('error' in result) {
      throw new Error(`get_runtime_logs failed for Instance "${result.instanceId}": ${result.error}`);
    }
    return this._textResult(result);
  }

  // Ask each selected Peer for local render, CaptureService, and readiness
  // facts. A health read is deliberately best-effort: status should identify a
  // stalled Peer instead of becoming another stalled operation.
  async getRuntimeHealth(
    instance_id?: string,
    target?: string,
    exactInstance = false,
    readinessAttribute?: string,
    signal?: AbortSignal,
    probeCapture = true,
  ): Promise<Record<string, unknown>> {
    let instanceId: string;
    let peers: PublicStudioPeer[];
    if (target !== undefined) {
      const resolved = this._resolveSingleTarget(target, instance_id);
      instanceId = resolved.instanceId;
      const peer = this.bridge.getPublicPeers().find((candidate) => candidate.peerId === resolved.targetPeerId);
      peers = peer ? [peer] : [];
    } else {
      instanceId = this._resolveInstanceIdOnly(instance_id);
      peers = this.bridge.getPublicPeers().filter((peer) => exactInstance
        ? peer.instanceId === instanceId
        : this.bridge.getInstanceIdsInScope(instanceId).includes(peer.instanceId));
    }

    const entries = await Promise.all(peers.map(async (peer) => {
      try {
        const response = await this._requestPeer(
          '/api/runtime-health',
          {
            probeCapture,
            ...(readinessAttribute === undefined ? {} : { readinessAttribute }),
          },
          peer.peerId,
          RUNTIME_HEALTH_PEER_TIMEOUT_MS,
          signal,
        );
        return [peer.role, publicRuntimeHealth(response, peer.role)] as const;
      } catch (error) {
        if (signal?.aborted) throw error;
        return [peer.role, {
          role: peer.role,
          error: errorMessage(error),
        }] as const;
      }
    }));

    return {
      instance_id: instanceId,
      peers: Object.fromEntries(entries),
    };
  }

  private _positiveInteger(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number.`);
    }
    return Math.trunc(value);
  }

  private _optionalPositiveInteger(value: unknown, name: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    return this._positiveInteger(value, name);
  }

  private _publicInstanceKey(peer: PublicStudioPeer): string {
    return `${peer.peerId}:${peer.instanceId}:${peer.connectedAt}`;
  }


  private _matchesManagedLaunch(record: ManagedStudioInstance, instance: PublicStudioPeer): boolean {
    if (record.source === 'published_place') {
      return record.placeId !== undefined && instance.placeId === record.placeId;
    }
    // A RunScript baseplate has no stable name: Studio has called its DataModel
    // both "Baseplate" and "Place1". Callers already require an edit Peer that
    // is new since this launch and connected after it, which identifies it.
    if (record.source === 'baseplate') return true;
    if (record.source === 'local_file' && record.localPlaceFile) {
      const expectedName = basename(record.localPlaceFile);
      return instance.placeName === expectedName || instance.dataModelName === expectedName;
    }
    return true;
  }

  private async _associateManagedEditConnection(
    instance: PublicStudioPeer,
    instanceManager: StudioInstanceManager,
  ): Promise<void> {
    if (instance.role !== 'edit') return;
    const candidate = (await instanceManager.pendingLaunches())
      .filter((record) => instance.connectedAt >= record.launchedAt - 1000)
      .filter((record) => this._matchesManagedLaunch(record, instance))
      .sort((a, b) => a.launchedAt - b.launchedAt)[0];
    if (candidate) await instanceManager.attachInstanceId(candidate, instance.instanceId);
  }

  private async _deriveUniverseId(placeId: number): Promise<number> {
    const response = await fetch(`https://apis.roblox.com/universes/v1/places/${placeId}/universe`);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Could not resolve the universe for place_id ${placeId} (${response.status}): ${body}`);
    }
    const data = await response.json() as { universeId?: number };
    if (typeof data.universeId !== 'number' || !Number.isFinite(data.universeId)) {
      throw new Error(`Could not resolve the universe for place_id ${placeId}.`);
    }
    return Math.trunc(data.universeId);
  }

  private async _waitForManagedEditConnection(
    record: ManagedStudioInstance,
    beforeKeys: Set<string>,
    timeoutMs: number,
  ): Promise<PublicStudioPeer | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await this.instanceManager.refresh(record);
      if (record.state === 'failed' || record.state === 'exited' || record.closedAt !== undefined) {
        return undefined;
      }
      const candidates = this.bridge.getPublicPeers()
        .filter((peer) => peer.role === 'edit')
        .filter((instance) => !beforeKeys.has(this._publicInstanceKey(instance)))
        .filter((instance) => instance.connectedAt >= record.launchedAt - 1000)
        .filter((instance) => this._matchesManagedLaunch(record, instance))
        .sort((a, b) => b.connectedAt - a.connectedAt);

      if (candidates[0]) return candidates[0];
      await sleep(500);
    }
    return undefined;
  }

  /** Native pid of the Studio that `roblox open` launched for this instance, while it runs. */
  async managedStudioPid(instanceId: string): Promise<number | undefined> {
    const record = await this.instanceManager.get(instanceId);
    return record && record.closedAt === undefined && record.exitedAt === undefined
      ? record.nativeProcessId ?? record.spawnPid
      : undefined;
  }

  private _managedStatus(record: ManagedStudioInstance): Record<string, unknown> {
    const connected = record.instanceId
      ? this.bridge.getPublicPeers().filter((peer) => peer.instanceId === record.instanceId)
      : [];
    return {
      launch_id: record.recordId,
      instance_id: record.instanceId,
      managed: true,
      state: record.state,
      pid: record.nativeProcessId ?? record.spawnPid,
      process_started_at: record.nativeProcessStartedAt,
      process_running: record.closedAt !== undefined || record.exitedAt !== undefined
        ? false
        : record.processObservationStatus === 'running'
          ? true
          : record.processObservationStatus === 'not_running'
            ? false
            : null,
      process_observation_status: record.processObservationStatus ?? 'unknown',
      last_process_observation_at: record.lastProcessObservationAt
        ? new Date(record.lastProcessObservationAt).toISOString()
        : undefined,
      last_successful_process_observation_at: record.lastSuccessfulProcessObservationAt
        ? new Date(record.lastSuccessfulProcessObservationAt).toISOString()
        : undefined,
      last_process_observation_error: record.lastProcessObservationError,
      consecutive_confirmed_misses: record.consecutiveConfirmedMisses ?? 0,
      source: record.source,
      local_place_file: record.localPlaceFile,
      studio_working_directory: record.studioWorkingDirectory,
      place_id: record.placeId,
      place_version: record.placeVersion,
      launched_at: new Date(record.launchedAt).toISOString(),
      connected_at: record.connectedAt ? new Date(record.connectedAt).toISOString() : undefined,
      failed_at: record.failedAt ? new Date(record.failedAt).toISOString() : undefined,
      exited_at: record.exitedAt ? new Date(record.exitedAt).toISOString() : undefined,
      exit_code: record.exitCode,
      failure_reason: record.failureReason,
      connected: connected.length > 0,
      roles: connected.map((instance) => instance.role).sort(),
    };
  }

  async manageInstance(request: Record<string, unknown>) {
    const action = request.action;
    const instance_id = typeof request.instance_id === 'string' ? request.instance_id : undefined;
    const launch_id = typeof request.launch_id === 'string' ? request.launch_id : undefined;

    if (instance_id && launch_id) {
      throw new Error('manage_instance accepts only one of instance_id or launch_id.');
    }

    if (
      action !== 'launch' &&
      action !== 'close' &&
      action !== 'status'
    ) {
      throw new Error('manage_instance requires action=launch|close|status');
    }

    if (action === 'close' || action === 'status') {
      await this.managedConnectionAssociations;
    }

    if (action === 'status') {
      if (launch_id) {
        const record = await this.instanceManager.getByLaunchId(launch_id);
        if (!record) return this._textResult({ error: 'Launch is not managed.', launch_id });
        return this._textResult(this._managedStatus(record));
      }
      if (instance_id) {
        const record = await this.instanceManager.get(instance_id);
        const connected = this.bridge.getPublicPeers().filter((peer) => peer.instanceId === instance_id);
        if (!record && connected.length === 0) {
          return this._textResult({ error: 'Instance is not connected or managed.', instance_id });
        }
        if (record) return this._textResult(this._managedStatus(record));
        return this._textResult({
          instance_id,
          managed: false,
          state: 'connected',
          place_id: connected[0]?.placeId,
          connected: true,
          roles: connected.map((instance) => instance.role).sort(),
        });
      }
      return this._textResult({
        managed: (await this.instanceManager.list())
          .filter((record) => record.closedAt === undefined)
          .map((record) => this._managedStatus(record)),
        connected: this.bridge.getPublicInstances().map((instance) => ({
          instance_id: instance.id,
          place_id: instance.placeId,
          place_name: instance.placeName,
          roles: instance.peers.map((peer) => peer.role).sort(),
        })),
      });
    }

    if (action === 'close') {
      let record: ManagedStudioInstance | undefined;
      if (launch_id) {
        record = await this.instanceManager.getByLaunchId(launch_id);
        if (!record) return this._textResult({ error: 'Launch is not managed.', launch_id });
        const connectedInstanceId = record.instanceId;
        const closeResult = record.closedAt === undefined
          ? await this.instanceManager.close(record)
          : { status: 'already_closed' as const };
        if (connectedInstanceId) {
          await this.bridge.unregisterInstanceIdEverywhere(connectedInstanceId);
          await sleep(500);
          await this.bridge.unregisterInstanceIdEverywhere(connectedInstanceId);
        }
        return this._textResult({
          ...this._managedStatus(record),
          close_status: closeResult.status,
          message: closeResult.status === 'already_closed'
            ? 'Studio instance was already closed.'
            : 'Studio instance closed.',
        });
      }
      if (instance_id) {
        const recordBeforeClose = await this.instanceManager.get(instance_id);
        const managedClose = await this.instanceManager.closeByInstanceId(instance_id);
        if (managedClose.status !== 'not_found') {
          await this.bridge.unregisterInstanceIdEverywhere(instance_id);
          await sleep(500);
          await this.bridge.unregisterInstanceIdEverywhere(instance_id);
          const closedRecord = managedClose.launchId
            ? await this.instanceManager.getByLaunchId(managedClose.launchId)
            : recordBeforeClose;
          return this._textResult({
            ...(closedRecord ? this._managedStatus(closedRecord) : { instance_id }),
            close_status: managedClose.status,
            message: managedClose.status === 'already_closed'
              ? 'Studio instance was already closed.'
              : 'Studio instance closed.',
          });
        }

        const connected = this.bridge.getPublicPeers().filter((peer) => peer.instanceId === instance_id);
        const edit = connected.find((peer) => peer.role === 'edit');
        if (!edit) {
          return this._textResult({
            error: 'Instance is not connected or managed.',
            instance_id,
          });
        }
        try {
          await this.instanceManager.closeConnectedInstance(edit);
          await sleep(500);
        } catch (error) {
          return this._textResult({
            error: error instanceof Error ? error.message : String(error),
            instance_id,
          });
        }
        await this.bridge.unregisterInstanceIdEverywhere(instance_id);
        return this._textResult({
          instance_id,
          close_status: 'closed',
          message: 'Studio instance closed.',
        });
      } else {
        const active = (await this.instanceManager.list()).filter((entry) => entry.closedAt === undefined);
        if (active.length === 0) {
          return this._textResult({ message: 'No managed Studio instances are active.' });
        }
        if (active.length > 1) {
          return this._textResult({
            error: 'instance_id is required because multiple managed Studio instances are active.',
            managed: active.map((entry) => this._managedStatus(entry)),
          });
        }
        record = active[0];
      }

      if (record.instanceId) await this.bridge.unregisterInstanceIdEverywhere(record.instanceId);
      const closeResult = await this.instanceManager.close(record);
      if (record.instanceId) {
        await sleep(500);
        await this.bridge.unregisterInstanceIdEverywhere(record.instanceId);
      }
      return this._textResult({
        ...this._managedStatus(record),
        close_status: closeResult.status,
        message: closeResult.status === 'already_closed'
          ? 'Studio instance was already closed.'
          : 'Studio instance closed.',
      });
    }

    const source = request.source;
    if (
      source !== 'baseplate' &&
      source !== 'local_file' &&
      source !== 'published_place' &&
      source !== 'place_revision'
    ) {
      throw new Error('manage_instance action=launch requires source=baseplate|local_file|published_place|place_revision');
    }

    const launchSource = source as StudioLaunchSource;
    const placeId = launchSource === 'published_place' || launchSource === 'place_revision'
      ? this._positiveInteger(request.place_id, 'place_id')
      : undefined;
    const placeVersion = launchSource === 'place_revision'
      ? this._positiveInteger(request.place_version, 'place_version')
      : undefined;
    const localPlaceFile = typeof request.local_place_file === 'string' ? request.local_place_file : undefined;
    let studioExecutable: string | undefined;
    if (request.studio_executable !== undefined) {
      if (typeof request.studio_executable !== 'string' || request.studio_executable.length === 0) {
        throw new Error('studio_executable must be a non-empty string when provided.');
      }
      studioExecutable = request.studio_executable;
    }
    const processEnvironment = parseStudioProcessEnvironmentPatch(request.process_environment);
    const studioWorkingDirectory = parseStudioWorkingDirectory(request.studio_working_directory);


    const universeId = launchSource === 'published_place' || launchSource === 'place_revision'
      ? await this._deriveUniverseId(placeId as number)
      : undefined;
    const timeoutMs = this._optionalPositiveInteger(request.timeout_ms, 'timeout_ms') ?? 120000;
    const beforeKeys = new Set(this.bridge.getPublicPeers().map((peer) => this._publicInstanceKey(peer)));

    const record = await this.instanceManager.launch({
      source: launchSource,
      localPlaceFile,
      placeId,
      universeId,
      placeVersion,
      connectionTimeoutMs: timeoutMs,
      studioExecutable,
      processEnvironment,
      studioWorkingDirectory,
    });

    const connected = await this._waitForManagedEditConnection(record, beforeKeys, timeoutMs);
    if (!connected) {
      if (record.state === 'launching') {
        await this.instanceManager.markFailed(record, 'Studio launched, but the Roblox CLI plugin did not connect before timeout.');
      }
      if (record.closedAt === undefined) {
        try {
          await this.instanceManager.close(record);
        } catch {
          // Best effort cleanup; the lifecycle error remains the useful result.
        }
      }
      return this._textResult({
        ...this._managedStatus(record),
        error: record.failureReason ?? 'Studio launched, but the Roblox CLI plugin did not connect before timeout.',
      });
    }

    await this.instanceManager.attachInstanceId(record, connected.instanceId);
    return this._textResult({
      ...this._managedStatus(record),
      message: launchSource === 'place_revision'
        ? `Studio opened place revision ${placeVersion}.`
        : 'Studio opened.',
    });
  }

  async soloPlaytest(action: string, mode?: string, timeout?: number, instance_id?: string) {
    if (action !== 'start' && action !== 'stop' && action !== 'status') {
      throw new Error('solo_playtest requires action=start|stop|status');
    }

    if (action === 'status') {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const { roles, runtimeRoles } = this._briefRoles(instanceId);
      // The edit peer keeps how the last solo playtest ended (the value the
      // game passed to EndTest, or the start failure). The read is bounded so
      // a busy edit peer cannot stall a status inspection.
      let outcome: Record<string, unknown> = {};
      if (roles.includes('edit')) {
        try {
          const editState = await this._request('/api/multiplayer-test-state', {}, instanceId, 'edit', RUNTIME_HEALTH_PEER_TIMEOUT_MS);
          if (editState.soloOutcome !== undefined) outcome = { soloOutcome: editState.soloOutcome };
        } catch (error) {
          outcome = { soloOutcomeError: errorMessage(error) };
        }
      }
      return this._textResult({
        success: true,
        action,
        running: runtimeRoles.length > 0,
        roles,
        ...outcome,
      });
    }

    if (action === 'start') {
      if (mode !== 'play' && mode !== 'run') {
        throw new Error('solo_playtest action=start requires mode=play|run');
      }
      const body = this._parseTextResult(await this.startPlaytest(mode, undefined, instance_id, timeout));
      if (body.success === true && body.runtimeReady !== false) {
        return this._textResult({
          success: true,
          action,
          message: 'Playtest started.',
          roles: Array.isArray(body.roles) ? body.roles : undefined,
        });
      }
      return this._textResult({
        // Keep lifecycle diagnostics on failures; only successful responses are brief.
        ...body,
        success: false,
        action,
        error: body.error ?? 'start_failed',
        message: body.success === true
          ? 'Playtest did not become ready before timeout.'
          : body.message ?? 'Playtest did not start.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    const body = this._parseTextResult(await this.stopPlaytest(instance_id, timeout));
    if (body.success === true && body.runtimeStopped !== false) {
      return this._textResult({
        success: true,
        action,
        message: 'Playtest stopped.',
      });
    }
    return this._textResult({
      ...body,
      success: false,
      action,
      error: body.error ?? 'stop_failed',
      message: body.message ?? 'Playtest did not stop.',
      roles: Array.isArray(body.roles) ? body.roles : undefined,
      recoveryHint: typeof body.recoveryHint === 'string' ? body.recoveryHint : undefined,
    });
  }

  async startPlaytest(mode: string, numPlayers?: number, instance_id?: string, timeout = 60) {
    if (mode !== 'play' && mode !== 'run') {
      throw new Error('mode must be "play" or "run"');
    }
    if (numPlayers !== undefined) {
      throw new Error('start_playtest is single-player only. Use multiplayer_playtest action="start" for multi-client StudioTestService sessions.');
    }
    const data: Record<string, unknown> = { mode };
    const startedAt = Date.now();
    const resolved = this.bridge.resolveTarget({ instance_id, target: undefined });
    if (!resolved.ok) throw new RoutingFailure(resolved.error);
    if (resolved.mode !== 'single') {
      throw new RoutingFailure({
        code: 'target_role_not_present_on_instance',
        message: 'This tool does not support target=all. Pick a specific role or omit target.',
        data: this._routingErrorData(),
      });
    }
    const existingRuntime = this._runtimeTargetsForScope(resolved.targetInstanceId);
    if (existingRuntime.length > 0) {
      const roles = this._rolesForScope(resolved.targetInstanceId);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'Playtest already running.',
            message: 'A playtest is already running for this Studio process scope. Stop the current playtest before starting another.',
            runtimeReady: true,
            timedOut: false,
            roles,
            runtimeRoles: existingRuntime.map((target) => target.role),
          }),
        }],
      };
    }
    const response = await this._requestPeer('/api/start-playtest', data, resolved.targetPeerId);
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      const requiredRoles = mode === 'play' ? ['server', 'client-1'] : ['server'];
      wait = await this._waitForRuntimeRolesFresh(resolved.targetInstanceId, startedAt, requiredRoles, timeout);
    }
    const body = wait
      ? {
        ...response,
        runtimeReady: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(body)
        }
      ]
    };
  }

  async stopPlaytest(instance_id?: string, timeout = 15) {
    // The edit DM's stopPlaytest handler writes a plugin:SetSetting request
    // that StopPlayMonitor reads from inside the play-server DM (the only DM where
    // StudioTestService:EndTest is legal). The cross-DM signal works independently
    // of daemon state, peer-role bookkeeping, or restart cycles.
    const { instanceId } = this._resolveSingleTarget('edit', instance_id);
    let response: Record<string, unknown>;
    let stopRequestError: string | undefined;
    try {
      response = await this._request('/api/stop-playtest', {}, instanceId, 'edit');
    } catch (error) {
      stopRequestError = errorMessage(error);
      response = {
        success: false,
        error: 'Edit stop request failed.',
        detail: stopRequestError,
      };
    }
    let wait: { ok: boolean; roles: string[]; timedOut: boolean } | undefined;
    if (response?.success === true) {
      wait = await this._waitForRuntimeRoles(instanceId, { noRuntime: true }, timeout);
    } else if (this._runtimeTargetsForScope(instanceId).length > 0) {
      wait = {
        ok: false,
        roles: this._rolesForScope(instanceId),
        timedOut: response.timedOut === true,
      };
    }
    const body = wait
      ? {
        ...response,
        runtimeStopped: wait.ok,
        timedOut: wait.timedOut,
        roles: wait.roles,
      }
      : response;
    if (wait && !wait.ok) {
      const runtimeRoles = wait.roles.filter((role) => role === 'server' || /^client-\d+$/.test(role));
      const failureBody = {
        ...body,
        success: false,
        error: 'Playtest teardown did not complete.',
        message: response.stopSignalAccepted === true && typeof response.message === 'string'
          ? response.message
          : response?.success === true
            ? wait.timedOut
              ? 'Stop signal was accepted, but runtime peers did not disconnect before timeout.'
              : 'Stop signal was accepted, but runtime peers are still connected.'
            : 'Edit stop request failed, and runtime peers are still connected.',
        stopSignalAccepted: response?.success === true || response.stopSignalAccepted === true,
        stopRequestError,
        runtimeRoles,
        possibleCause:
          'A game shutdown hook such as BindToClose may be blocking Studio teardown. ' +
          'No runtime hard-stop or synthetic keyboard fallback was attempted.',
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(failureBody) }],
      };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(body) }],
    };
  }

  private async _buildMultiplayerState(instanceId: string): Promise<Record<string, unknown>> {
    const peers = this.bridge.getPublicPeers()
      .filter((peer) => this.bridge.getInstanceIdsInScope(instanceId).includes(peer.instanceId))
      .sort((a, b) => a.role.localeCompare(b.role));
    const multiplayerGroup = this.bridge.getMultiplayerGroups().find((group) =>
      group.instanceIds.includes(instanceId)
    );

    const body: Record<string, unknown> = {
      instanceId,
      multiplayerGroupId: multiplayerGroup?.id,
      peers,
      peerCount: peers.length,
    };

    const edit = peers.find((p) => p.role === 'edit');
    const server = peers.find((p) => p.role === 'server');

    let editState: StudioToolResponse | undefined;
    let serverState: StudioToolResponse | undefined;

    if (edit) {
      try {
        editState = await this._request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        body.edit = editState;
      } catch (err) {
        body.edit = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (server) {
      try {
        serverState = await this._request('/api/multiplayer-test-state', {}, instanceId, 'server');
        body.server = serverState;
      } catch (err) {
        body.server = { error: err instanceof Error ? err.message : String(err) };
      }
    }

    const session = editState?.session;
    const rawPhase = typeof session?.phase === 'string' ? session.phase : undefined;
    const hasRuntime = peers.some((p) => p.role === 'server' || p.role.startsWith('client-'));
    body.phase = rawPhase === 'starting' && hasRuntime ? 'running' : (rawPhase ?? (hasRuntime ? 'running' : 'idle'));
    body.testId = session?.testId;
    body.numPlayers = session?.numPlayers;
    body.testArgs = session?.testArgs ?? serverState?.testArgs;
    body.result = session?.result;
    body.error = session?.error;
    body.soloOutcome = editState?.soloOutcome;
    body.players = serverState?.players ?? [];
    body.playerCount = serverState?.playerCount ?? 0;
    body.clientRoles = this._clientRolesForScope(instanceId);

    return body;
  }

  private async _waitForMultiplayerEditDone(instanceId: string, timeoutSec = 30): Promise<boolean> {
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
      if (!this._rolesForScope(instanceId).includes('edit')) return false;
      try {
        const editState = await this._request('/api/multiplayer-test-state', {}, instanceId, 'edit');
        const phase = editState?.session?.phase;
        if (phase === 'completed' || phase === 'failed') return true;
      } catch {
        // The edit peer may be temporarily busy while Studio tears down.
      }
      await sleep(250);
    }
    return false;
  }

  private async _isMultiplayerTestRunning(instanceId: string): Promise<boolean> {
    return this.bridge.getMultiplayerGroups().some((group) =>
      group.instanceIds.includes(instanceId)
    );
  }

  private async _waitForMultiplayerStart(
    instanceId: string,
    clientCount: number,
    timeoutSec = 30,
    connectedAfter?: number,
  ): Promise<{ ok: boolean; roles: string[]; timedOut: boolean; phase?: string; error?: unknown }> {
    const deadline = Date.now() + timeoutSec * 1000;
    let lastPhase: string | undefined;
    while (Date.now() < deadline) {
      const exact = await this._waitForExactClientCount(instanceId, clientCount, 0.25, 0);
      if (exact.ok || exact.extraClients) {
        if (exact.ok && connectedAfter !== undefined) {
          const peers = this.bridge.getPeersInScope(instanceId);
          const freshRoles = new Set(peers.filter((peer) => peer.connectedAt >= connectedAfter).map((peer) => peer.role));
          const freshClientCount = [...freshRoles].filter((role) => /^client-\d+$/.test(role)).length;
          if (!freshRoles.has('server') || freshClientCount !== clientCount) {
            await sleep(250);
            continue;
          }
        }
        return { ok: exact.ok, roles: exact.roles, timedOut: false, error: exact.extraClients ? `Expected ${clientCount} client(s), but Studio registered ${exact.clientCount}.` : undefined };
      }
      try {
        const remainingMs = Math.max(1, Math.min(1000, deadline - Date.now()));
        const editState = await this._request('/api/multiplayer-test-state', {}, instanceId, 'edit', remainingMs);
        const session = editState?.session;
        if (typeof session?.phase === 'string') {
          lastPhase = session.phase;
        }
        if (session?.phase === 'failed') {
          return { ok: false, roles: this._rolesForScope(instanceId), timedOut: false, phase: session.phase, error: session.error };
        }
      } catch {
        // Keep waiting; normal startup is driven by runtime peers registering.
      }
      await sleep(250);
    }
    return { ok: false, roles: this._rolesForScope(instanceId), timedOut: true, phase: lastPhase };
  }

  async multiplayerPlaytest(
    action: string,
    numPlayers?: number,
    target?: string,
    testArgs?: unknown,
    value?: unknown,
    timeout?: number,
    instance_id?: string,
  ) {
    if (
      action !== 'start' &&
      action !== 'status' &&
      action !== 'add_players' &&
      action !== 'leave_client' &&
      action !== 'end'
    ) {
      throw new Error('multiplayer_playtest requires action=start|status|add_players|leave_client|end');
    }

    const briefState = async (instanceId?: string) => {
      const state = await this._buildMultiplayerState(this._resolveInstanceIdOnly(instanceId));
      const roles = Array.isArray(state.peers)
        ? state.peers.flatMap((peer) =>
            peer !== null && typeof peer === 'object' && 'role' in peer && typeof peer.role === 'string'
              ? [peer.role]
              : [])
        : [];
      return {
        phase: state.phase,
        multiplayerGroupId: typeof state.multiplayerGroupId === 'string' ? state.multiplayerGroupId : undefined,
        roles,
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
        error: typeof state.error === 'string' ? state.error : undefined,
        soloOutcome: state.soloOutcome,
      };
    };

    if (action === 'status') {
      return this._textResult({
        success: true,
        action,
        ...(await briefState(instance_id)),
      });
    }

    if (action === 'start') {
      const body = this._parseTextResult(await this.multiplayerTestStart(numPlayers as number, testArgs, timeout, instance_id));
      const stateValue = body.state;
      const state: Record<string, unknown> = stateValue !== null && typeof stateValue === 'object' && !Array.isArray(stateValue)
        ? { ...stateValue }
        : {};
      const waitValue = body.wait;
      const wait: Record<string, unknown> = waitValue !== null && typeof waitValue === 'object' && !Array.isArray(waitValue)
        ? { ...waitValue }
        : {};
      const launched = body.success === true && body.ready === true;
      const multiplayerGroupId = typeof body.multiplayerGroupId === 'string'
        ? body.multiplayerGroupId
        : typeof body.testId === 'string'
          ? body.testId
          : undefined;
      return this._textResult(launched ? {
        success: true,
        action,
        message: 'Multiplayer playtest started.',
        multiplayerGroupId,
        roles: Array.isArray(body.roles) ? body.roles : undefined,
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? wait.error ?? 'multiplayer_start_not_detected',
        message: body.success === true
          ? 'Multiplayer playtest start was requested, but roblox-cli did not detect the required server/client peers before timeout.'
          : body.message ?? 'Multiplayer playtest did not start.',
        multiplayerGroupId,
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    if (action === 'add_players') {
      const body = this._parseTextResult(await this.multiplayerTestAddPlayers(numPlayers as number, timeout, instance_id));
      const stateValue = body.state;
      const state: Record<string, unknown> = stateValue !== null && typeof stateValue === 'object' && !Array.isArray(stateValue)
        ? { ...stateValue }
        : {};
      const success = body.success === true && body.ready === true;
      return this._textResult(success ? {
        success: true,
        action,
        message: 'Players added.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
        playerCount: typeof state.playerCount === 'number' ? state.playerCount : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? 'add_players_failed',
        message: body.success === true
          ? 'Players did not finish joining before timeout.'
          : body.message ?? 'Players were not added.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    if (action === 'leave_client') {
      const body = this._parseTextResult(await this.multiplayerTestLeaveClient(target ?? 'client-1', timeout, instance_id));
      return this._textResult(body.success === true && body.left === true ? {
        success: true,
        action,
        message: 'Client left.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      } : {
        success: false,
        action,
        error: body.error ?? 'leave_client_failed',
        message: body.message ?? 'Client did not leave.',
        roles: Array.isArray(body.roles) ? body.roles : undefined,
      });
    }

    const body = this._parseTextResult(await this.multiplayerTestEnd(value, timeout, instance_id));
    const multiplayerGroupId = typeof body.multiplayerGroupId === 'string'
      ? body.multiplayerGroupId
      : undefined;
    return this._textResult(body.success === true && body.ended === true ? {
      success: true,
      action,
      multiplayerGroupId,
      message: body.alreadyEnded === true
        ? 'Multiplayer playtest already ended.'
        : (body.teardownConfirmed === false
          ? 'Multiplayer playtest end requested; teardown still in progress. Use multiplayer_playtest action="status" to confirm.'
          : 'Multiplayer playtest ended.'),
      teardownConfirmed: body.teardownConfirmed === true,
    } : {
      success: false,
      action,
      multiplayerGroupId,
      error: body.error ?? 'end_failed',
      message: body.message ?? 'Multiplayer playtest did not end.',
      roles: Array.isArray(body.roles) ? body.roles : undefined,
      editDone: body.editDone === false ? false : undefined,
    });
  }

  async multiplayerTestStart(numPlayers: number, testArgs?: unknown, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const editTarget = this._resolveSingleTarget('edit', instance_id);
    const existingRuntime = this._runtimeTargetsForScope(editTarget.instanceId);
    if (existingRuntime.length > 0) {
      const roles = this._rolesForScope(editTarget.instanceId);
      return this._textResult({
        success: false,
        error: 'Multiplayer playtest already running.',
        message: 'A Studio runtime is already connected for this process scope. End the existing playtest before starting another multiplayer playtest.',
        ready: true,
        timedOut: false,
        roles,
        runtimeRoles: existingRuntime.map((target) => target.role),
      });
    }

    const startedAt = Date.now();
    const response = await this._requestPeer(
      '/api/multiplayer-test-start',
      { numPlayers, testArgs: testArgs ?? {} },
      editTarget.targetPeerId,
    );
    const groupId = typeof response?.testId === 'string' ? response.testId : undefined;
    if (response?.error || response?.success !== true || groupId === undefined) {
      if (groupId !== undefined) await this.bridge.removeMultiplayerGroupEverywhere(groupId);
      return this._textResult({
        ...response,
        error: response?.error ?? 'Multiplayer start did not return a testId.',
      });
    }

    await this.bridge.createMultiplayerGroupEverywhere(groupId, editTarget.instanceId);
    const wait = await this._waitForMultiplayerStart(editTarget.instanceId, numPlayers, timeout ?? 60, startedAt);
    const launched = wait.ok;
    const state = await this._buildMultiplayerState(editTarget.instanceId);
    const success = wait.ok;
    const runtimeStillConnected = this._runtimeTargetsForScope(editTarget.instanceId).length > 0;
    const definitelyFailed = state.phase === 'failed' && !runtimeStillConnected;
    if (definitelyFailed) await this.bridge.removeMultiplayerGroupEverywhere(groupId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          multiplayerGroupId: groupId,
          success,
          ready: wait.ok,
          launched,
          startRequested: true,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
          error: success ? undefined : wait.error ?? 'multiplayer_start_not_detected',
          message: success
            ? 'Multiplayer Studio test started and runtime peers detected.'
            : 'Multiplayer Studio test start was requested, but roblox-cli did not detect the required server/client peers before timeout.',
          startedAt,
        }),
      }],
    };
  }

  async multiplayerTestState(instance_id?: string) {
    const instanceId = this._resolveInstanceIdOnly(instance_id);
    const state = await this._buildMultiplayerState(instanceId);
    return { content: [{ type: 'text', text: JSON.stringify(state) }] };
  }

  async multiplayerTestAddPlayers(numPlayers: number, timeout?: number, instance_id?: string) {
    if (!Number.isInteger(numPlayers) || numPlayers < 1 || numPlayers > 8) {
      throw new Error('numPlayers must be an integer from 1 to 8');
    }
    const serverTarget = this._resolveSingleTarget('server', instance_id);
    const group = this.bridge.getMultiplayerGroups().find((candidate) =>
      candidate.instanceIds.includes(serverTarget.instanceId)
    );
    const scopeInstanceId = group?.controllerInstanceId ?? serverTarget.instanceId;
    const before = this._clientRolesForScope(scopeInstanceId).length;
    const response = await this._requestPeer(
      '/api/multiplayer-test-add-players',
      { numPlayers, timeout: timeout ?? 10 },
      serverTarget.targetPeerId,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForExactClientCount(
      scopeInstanceId,
      before + numPlayers,
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(scopeInstanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          ready: wait.ok,
          timedOut: wait.timedOut,
          wait,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestLeaveClient(target: string = 'client-1', timeout?: number, instance_id?: string) {
    if (!/^client-\d+$/.test(target)) {
      throw new Error(`multiplayer_test_leave_client requires target=client-N (got: ${target})`);
    }
    const clientTarget = this._resolveSingleTarget(target, instance_id);
    const group = this.bridge.getMultiplayerGroups().find((candidate) =>
      candidate.instanceIds.includes(clientTarget.instanceId)
    );
    const scopeInstanceId = group?.controllerInstanceId ?? clientTarget.instanceId;
    const response = await this._requestPeer(
      '/api/multiplayer-test-leave-client',
      {},
      clientTarget.targetPeerId,
    );
    if (response?.error) {
      return { content: [{ type: 'text', text: JSON.stringify(response) }] };
    }
    const wait = await this._waitForRuntimeRoles(
      scopeInstanceId,
      { absentRole: clientTarget.role },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(scopeInstanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          ...response,
          left: wait.ok,
          timedOut: wait.timedOut,
          roles: wait.roles,
          state,
        }),
      }],
    };
  }

  async multiplayerTestEnd(value?: unknown, timeout?: number, instance_id?: string) {
    let serverTarget: { targetPeerId: string; instanceId: string; role: string };
    try {
      serverTarget = this._resolveSingleTarget('server', instance_id);
    } catch (error) {
      const instanceId = this._resolveInstanceIdOnly(instance_id);
      const group = this.bridge.getMultiplayerGroups().find((candidate) =>
        candidate.instanceIds.includes(instanceId)
      );
      const hasRuntime = this._rolesForScope(instanceId).some(
        (role) => role === 'server' || /^client-\d+$/.test(role),
      );
      if (!hasRuntime) {
        if (group) await this.bridge.removeMultiplayerGroupEverywhere(group.id);
        return this._textResult({
          success: true,
          multiplayerGroupId: group?.id,
          ended: true,
          alreadyEnded: true,
          teardownConfirmed: true,
          message: 'No active multiplayer test to end (already ended).',
        });
      }
      throw error;
    }

    const group = this.bridge.getMultiplayerGroups().find((candidate) =>
      candidate.instanceIds.includes(serverTarget.instanceId)
    );
    const scopeInstanceId = group?.controllerInstanceId ?? serverTarget.instanceId;
    const response = await this._requestPeer(
      '/api/multiplayer-test-end',
      { value: value ?? 'ended_by_studio_agent' },
      serverTarget.targetPeerId,
    );
    if (response?.error) {
      return this._textResult({
        ...response,
        multiplayerGroupId: group?.id,
      });
    }
    const editDone = await this._waitForMultiplayerEditDone(scopeInstanceId, timeout ?? 30);
    const wait = await this._waitForRuntimeRoles(
      scopeInstanceId,
      { noRuntime: true },
      timeout ?? 30,
    );
    const state = await this._buildMultiplayerState(scopeInstanceId);
    const result = this._textResult({
      ...response,
      multiplayerGroupId: group?.id,
      ended: response.success === true,
      teardownConfirmed: wait.ok,
      editDone,
      timedOut: wait.timedOut,
      roles: wait.roles,
      state,
    });
    if (wait.ok && group) await this.bridge.removeMultiplayerGroupEverywhere(group.id);
    return result;
  }

  // === Input and capture internals ===

  async simulateMouseInput(action: string, x: number, y: number, button?: string, scrollDirection?: string, target?: string, instance_id?: string) {
    if (!action) {
      throw new Error('action is required for simulate_mouse_input');
    }
    // Default to the running playtest client (where the input pipeline lives)
    // when the caller didn't pick a target; fall back to edit otherwise.
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-mouse-input', {
      action, x, y, button
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  async simulateKeyboardInput(keyCode?: string, action?: string, duration?: number, text?: string, target?: string, instance_id?: string) {
    if (!keyCode && text === undefined) {
      throw new Error('keyCode or text is required for simulate_keyboard_input');
    }
    const { instanceId, clientRole } = this._resolveRuntime(instance_id);
    const response = await this._callSingle('/api/simulate-keyboard-input', {
      keyCode, action, duration, text
    }, target || clientRole || 'edit', instanceId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(response)
      }]
    };
  }

  private async _captureViewportImageOnce(
    instanceId: string,
    targetRole: string,
    format?: string,
    quality?: number,
    maxBytes: number = MAX_INLINE_IMAGE_BYTES,
  ): Promise<EncodedViewportCapture> {
    let response: RawImageCaptureResponse;
    if (targetRole.startsWith('client-')) {
      // Play mode. The running game VM can trigger CaptureScreenshot but can't
      // read the resulting temp texture back (privilege gate). So capture on
      // the client to get the rbxtemp:// id, then read it back in the edit DM —
      // the rbxtemp handle is process-scoped and the edit/plugin identity is
      // allowed to promote it into a readable EditableImage.
      const begin = await this._callSingle('/api/capture-begin', {}, targetRole, instanceId) as { contentId?: string; error?: string };
      if (begin.error) {
        const studioCapture = await this._captureStudioViewportImage(instanceId, format === 'png' ? 'png' : 'jpeg', quality);
        if (studioCapture !== undefined) {
          response = studioCapture;
        } else {
          return { success: false, error: begin.error };
        }
      } else if (!begin.contentId) {
        const studioCapture = await this._captureStudioViewportImage(instanceId, format === 'png' ? 'png' : 'jpeg', quality);
        if (studioCapture !== undefined) {
          response = studioCapture;
        } else {
          return { success: false, error: 'Screenshot capture failed: no content id returned from client.' };
        }
      } else {
        response = await this._callSingle('/api/capture-read', { contentId: begin.contentId }, 'edit', instanceId) as RawImageCaptureResponse;
      }
    } else {
      // Edit mode: capture and read back in the same (edit) context.
      response = await this._callSingle('/api/capture-screenshot', {}, 'edit', instanceId) as RawImageCaptureResponse;
    }

    if (response.error || response.solidMagenta === true || isSolidMagentaCapture(response)) {
      const studioCapture = await this._captureStudioViewportImage(instanceId, format === 'png' ? 'png' : 'jpeg', quality);
      if (studioCapture !== undefined && !studioCapture.error && !isSolidMagentaCapture(studioCapture)) {
        response = studioCapture;
      }
    }

    if (response.error) {
      let text = response.error;
      if (
        targetRole.startsWith('client-') &&
        response.error.includes('Failed to load texture, unexpected format') &&
        await this._isMultiplayerTestRunning(instanceId)
      ) {
        text =
          'Screenshot capture reached the multiplayer client, but Roblox returned a temporary screenshot texture ' +
          'that the edit peer cannot read in StudioTestService multiplayer sessions. Regular solo_playtest capture ' +
          'works because the temporary rbxtemp:// handle is readable from the edit process; multiplayer client handles ' +
          `appear to be scoped to the client process. Raw error: ${response.error}`;
      }
      return { success: false, error: text };
    }

    const w = response.width;
    const h = response.height;
    if (w === undefined || h === undefined) {
      return { success: false, error: 'Screenshot response missing dimensions.' };
    }
    if (response.solidMagenta === true || isSolidMagentaCapture(response)) {
      return {
        success: false,
        error:
          `Roblox CaptureService returned a solid magenta frame (${w}x${h}); ` +
          'the viewport pixels were not available. Restore the Studio window, ensure the target is visible, and retry.',
      };
    }

    const fmt: 'jpeg' | 'png' = format === 'png' ? 'png' : 'jpeg';
    const q = quality === undefined ? 92 : Math.max(1, Math.min(100, Math.floor(quality)));

    if (response.encodedData !== undefined && response.encodedMimeType !== undefined) {
      const buffer = Buffer.from(response.encodedData, 'base64');
      if (buffer.length === 0) {
        return { success: false, error: 'Native Studio window capture returned an empty image.' };
      }
      if (buffer.length > maxBytes) {
        return {
          success: false,
          error:
            `Native Studio window screenshot is ${(buffer.length / 1048576).toFixed(1)}MB, over the ` +
            `${(maxBytes / 1048576).toFixed(1)}MB inline budget. Make the Studio window smaller and retry.`,
        };
      }
      const nativeFormat = response.encodedMimeType === 'image/png' ? 'png' : 'jpeg';
      return {
        success: true,
        width: w,
        height: h,
        format: nativeFormat,
        quality: nativeFormat === 'jpeg' ? q : undefined,
        note: 'Captured the visible Roblox Studio window with the macOS native fallback.',
        data: response.encodedData,
        mimeType: response.encodedMimeType,
        message:
          `Native Studio window capture ${w}x${h}px (${nativeFormat}${nativeFormat === 'jpeg' ? ` q${q}` : ''}). ` +
          'The image includes Studio chrome; use it for visual evidence, not direct input-coordinate mapping.',
      };
    }

    // Cap the inline image size. Measured empirically: an ~8MB image (11MB
      // base64) returns fine, but ~16MB (22MB base64) can close the daemon
    // and drops every Studio registration — a catastrophic failure, not a
    // graceful error. 6MB is in the proven-safe range with comfortable margin.
    // For PNG we refuse (rather than silently dropping the lossless guarantee
    // the caller asked for); for JPEG we step quality down so the call still
    // succeeds.
    const encoded = encodeImageFromRgbaResponse(response, fmt, q);
    let { buffer } = encoded;
    const { mimeType } = encoded;
    let usedQ = q;
    let note = '';

    if (buffer.length > maxBytes) {
      if (fmt === 'png') {
        const mb = (buffer.length / 1048576).toFixed(1);
        return {
          success: false,
          error:
            `PNG screenshot is ${mb}MB, over the ~${(maxBytes / 1048576).toFixed(1)}MB inline image limit. ` +
            `Use the default jpeg format (optionally with a "quality" value) or make the Studio window smaller for a lossless capture.`,
        };
      }
      while (buffer.length > maxBytes && usedQ > 25) {
        usedQ = Math.max(25, usedQ - 20);
        buffer = encodeImageFromRgbaResponse(response, 'jpeg', usedQ).buffer;
      }
      if (buffer.length > maxBytes) {
        return {
          success: false,
          error:
            `JPEG screenshot is still ${(buffer.length / 1048576).toFixed(1)}MB at q${usedQ}, over the ` +
            `${(maxBytes / 1048576).toFixed(1)}MB inline budget. Make the Studio window smaller or capture fewer images per call.`,
        };
      }
      note = ` — auto-reduced to q${usedQ} to fit the inline size limit; enlarge the Studio window or capture a smaller region for finer detail`;
    }

    // Explicit coordinate contract: the image is returned at native viewport
    // resolution whenever it fits the transport cap, so its pixel grid IS the
    // coordinate space simulate_mouse_input expects. Oversized captures are
    // downscaled in Studio before transfer; the message then tells the caller
    // how to map image coordinates back to viewport coordinates.
    const nativeW = response.nativeWidth ?? w;
    const nativeH = response.nativeHeight ?? h;
    const message =
      nativeW !== w || nativeH !== h
        ? `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}, downscaled from the ` +
          `${nativeW}x${nativeH} viewport to fit transport limits. For simulate_mouse_input, multiply x read off ` +
          `this image by ${(nativeW / w).toFixed(4)} and y by ${(nativeH / h).toFixed(4)} to get viewport pixel ` +
          `coordinates ((0,0) at the top-left).`
        : `Screenshot ${w}x${h}px (${fmt}${fmt === 'jpeg' ? ` q${usedQ}` : ''})${note}. ` +
          `For simulate_mouse_input, x/y are pixel coordinates in this exact image with (0,0) at the ` +
          `top-left; it is not downscaled, so use coordinates as you read them off the image.`;

    return {
      success: true,
      width: w,
      height: h,
      format: fmt,
      quality: fmt === 'jpeg' ? usedQ : undefined,
      note,
      data: buffer.toString('base64'),
      mimeType,
      message,
    };
  }

  private async _captureViewportImage(
    instanceId: string,
    targetRole: string,
    format?: string,
    quality?: number,
  ): Promise<EncodedViewportCapture> {
    let last: EncodedViewportCapture = {
      success: false,
      error: 'Screenshot capture failed.',
    };
    // An embedded play client is backed by the native Studio window in local
    // Studio. Once its CaptureService result is magenta, retrying the same
    // broken path only adds seconds before the CLI can use its native fallback.
    // Edit captures retain the short retry window because the plugin route can
    // recover after a renderer tick.
    const maxAttempts = targetRole.startsWith('client-') ? 1 : CAPTURE_RETRY_ATTEMPTS;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      last = await this._captureViewportImageOnce(instanceId, targetRole, format, quality);
      if (last.success) return { ...last, attempts: attempt };

      const retryable = /solid magenta|timed out|callback never fired|temporary screenshot texture/iu.test(last.error);
      if (!retryable || attempt === maxAttempts) {
        return { ...last, attempts: attempt };
      }
      // The plugin waits for a RenderStepped tick before each capture. This
      // small gap also lets CaptureService retire the previous temporary
      // texture before the next attempt.
      await sleep(CAPTURE_RETRY_DELAY_MS);
    }
    return { ...last, attempts: maxAttempts };
  }

  async captureScreenshot(instance_id?: string, format?: string, quality?: number, target?: string) {
    let instanceId: string;
    let targetRole: string;
    if (target !== undefined) {
      const resolved = this.bridge.resolveTarget({ instance_id, target });
      if (!resolved.ok) throw new RoutingFailure(resolved.error);
      if (resolved.mode !== 'single') {
        throw new RoutingFailure({
          code: 'target_role_not_present_on_instance',
          message: 'captureScreenshot requires one edit or client-N target.',
          data: this._routingErrorData(),
        });
      }
      instanceId = resolved.targetInstanceId;
      targetRole = resolved.targetRole;
      if (targetRole !== 'edit' && !targetRole.startsWith('client-')) {
        throw new Error('captureScreenshot target must be edit or client-N.');
      }
    } else {
      const resolved = this._resolveRuntime(instance_id);
      instanceId = resolved.instanceId;
      targetRole = resolved.clientRole ?? 'edit';
    }
    const capture = await this._captureViewportImage(instanceId, targetRole, format, quality);
    if (!capture.success) {
      return this._textResult({
        error: capture.error,
        ...(capture.attempts === undefined ? {} : { capture_attempts: capture.attempts }),
      });
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            width: capture.width,
            height: capture.height,
            format: capture.format,
            mimeType: capture.mimeType,
            ...(capture.attempts === undefined ? {} : { capture_attempts: capture.attempts }),
            ...(capture.quality === undefined ? {} : { quality: capture.quality }),
            message: capture.message,
          }),
        },
        {
          type: 'image',
          data: capture.data,
          mimeType: capture.mimeType,
        },
      ],
    };
  }
}
