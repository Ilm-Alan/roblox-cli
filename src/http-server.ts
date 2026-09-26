import express from 'express';
import type { ErrorRequestHandler, Express, Response } from 'express';
import http from 'http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { RobloxStudioTools } from './tools/index.js';
import { BridgeService, RequestFailure, RoutingFailure } from './bridge-service.js';
import type { PublicStudioInstance, PublicStudioPeer, RegisterPeerResult } from './bridge-service.js';
import {
  AGENT_COMMAND_PREFIX,
  AGENT_DAEMON_STOP_PATH,
  AGENT_HEALTH_PATH,
  AGENT_PROTOCOL_HEADER,
  AGENT_PROTOCOL_VERSION,
  AGENT_REQUESTS_PREFIX,
  AGENT_SCHEMA_PATH,
  AGENT_STATUS_PATH,
  REQUEST_ID_HEADER,
  agentSchema,
} from './agent-protocol.js';
import { normalizeCommandResult, publicToolErrorBody } from './command-results.js';
import { tokensMatch } from './auth.js';
import { CliCommandError } from './cli-errors.js';
import { createCliCommandHandlers, type CliCommandHandler } from './cli-command-service.js';
import { CLI_COMMANDS } from './commands.js';
import { HTTP_BODY_LIMIT_BYTES } from './http-body-limits.js';
import {
  WebSocketStudioTransport,
  MAX_ACTIVE_STUDIO_SOCKETS,
  MAX_STUDIO_FRAME_BYTES,
  STUDIO_PROTOCOL_VERSION,
  type StudioStatusEvent,
} from './studio-transport.js';

export interface HttpSecurityOptions {
  /** When set, tool-invoking endpoints require this token. */
  authToken?: string;
  /** Where the token came from — used to build a helpful 401 message. */
  authTokenHint?: string;
}

export interface RobloxStudioHttpApp extends Express {
  isPluginConnected(): boolean;
  setConnectorActive(active: boolean): void;
  isConnectorActive(): boolean;
  trackConnectorActivity(): void;
  attachStudioTransport(server: http.Server): void;
  cleanup(): Promise<void>;
}

interface ConnectorConfig {
  name: string;
  version: string;
  /** Build id embedded in the packaged Studio plugin; /ready refuses other builds. Unknown skips the check. */
  buildId?: string;
  /** Graceful daemon shutdown, invoked after an authenticated stop request is answered. */
  stop?: () => void;
}

type PassiveStudioPeer = Omit<PublicStudioPeer, 'peerId'>;
type PassiveStudioInstance = Omit<PublicStudioInstance, 'peers'> & {
  peers: PassiveStudioPeer[];
};

function toPassivePeer(peer: PublicStudioPeer): PassiveStudioPeer {
  return {
    instanceId: peer.instanceId,
    multiplayerGroupId: peer.multiplayerGroupId,
    role: peer.role,
    placeId: peer.placeId,
    placeName: peer.placeName,
    placeKey: peer.placeKey,
    dataModelName: peer.dataModelName,
    isRunning: peer.isRunning,
    pluginVersion: peer.pluginVersion,
    pluginVariant: peer.pluginVariant,
    serverVersion: peer.serverVersion,
    lastActivity: peer.lastActivity,
    connectedAt: peer.connectedAt,
    transportConnected: peer.transportConnected,
    lastInboundAt: peer.lastInboundAt,
    outstandingRequests: peer.outstandingRequests,
    oldestOutstandingMs: peer.oldestOutstandingMs,
    unresponsive: peer.unresponsive,
  };
}

function toPassiveInstance(instance: PublicStudioInstance): PassiveStudioInstance {
  return {
    id: instance.id,
    multiplayerGroupId: instance.multiplayerGroupId,
    placeId: instance.placeId,
    placeName: instance.placeName,
    peers: instance.peers.map(toPassivePeer),
  };
}

function toAgentInstance(
  instance: PublicStudioInstance,
  runtimeHealth?: Record<string, unknown>,
): Record<string, unknown> {
  const now = Date.now();
  return {
    instance_id: instance.id,
    place_id: instance.placeId,
    place_name: instance.placeName,
    ...(instance.multiplayerGroupId === undefined ? {} : { multiplayer_group_id: instance.multiplayerGroupId }),
    roles: instance.peers.map((peer) => peer.role).sort(),
    running: instance.peers.some((peer) => peer.isRunning),
    transport: Object.fromEntries(instance.peers.map((peer) => [peer.role, {
      connected: peer.transportConnected,
      last_inbound_ms_ago: peer.lastInboundAt === undefined ? null : now - peer.lastInboundAt,
      outstanding_requests: peer.outstandingRequests,
      oldest_outstanding_ms: peer.oldestOutstandingMs ?? null,
      unresponsive: peer.unresponsive,
    }])),
    ...(runtimeHealth === undefined ? {} : { runtime_health: runtimeHealth }),
  };
}

function toAgentSession(value: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  return {
    session_id: value.session_id,
    instance_id: value.instance_id,
    ownership: value.ownership,
    source: value.source,
  };
}

const MAX_STUDIO_SESSIONS = 256;
const MAX_REJECTED_CONNECTIONS = 32;

function rejectStudioUpgrade(socket: Duplex, status: number, error: string): void {
  const body = JSON.stringify({ error });
  socket.end(
    `HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n` +
    'Connection: close\r\nContent-Type: application/json\r\n' +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

export function createHttpServer(tools: RobloxStudioTools, bridge: BridgeService, allowedTools?: Set<string>, serverConfig?: ConnectorConfig, security?: HttpSecurityOptions): RobloxStudioHttpApp {
  // Express cannot know about the lifecycle controls attached below.
  const app = express() as unknown as RobloxStudioHttpApp;
  const cliCommands = createCliCommandHandlers(tools, bridge);
  // Aggregate workflows use child bridge requests. Retain the outer operation
  // so the request id printed after an HTTP timeout has a recoverable outcome.
  const workflows = new Map<string, Record<string, unknown>>();
  const workflowLimit = 64;
  const pruneWorkflows = () => {
    for (const [id, receipt] of workflows) {
      if (receipt.state === 'settled' && Date.now() - Number(receipt.settled_at) > 15 * 60_000) workflows.delete(id);
    }
  };
  const workflowStatus = (id: string) => { pruneWorkflows(); return workflows.get(id); };
  const settleWorkflow = (id: string, result: unknown, failed: boolean) => {
    const receipt = workflows.get(id);
    if (!receipt) return;
    receipt.state = 'settled';
    receipt.execution = failed ? 'failed' : 'success';
    receipt.settled_at = Date.now();
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes <= 256 * 1024) receipt.result = result;
    else receipt.result_unavailable = { reason: 'workflow_result_too_large', bytes, limit_bytes: 256 * 1024 };
  };
  // The public API is closed by default. Callers may further narrow it, but
  // cannot widen it beyond the names owned by commands.ts.
  const publicCommands = new Set(
    [...(allowedTools ?? CLI_COMMANDS)].filter((name) => CLI_COMMANDS.has(name)),
  );
  const studioLifecycleCallable = publicCommands.has('open');
  const studioLifecycleCapabilities = studioLifecycleCallable
    ? tools.getStudioLifecycleCapabilities()
    : undefined;
  let connectorActive = false;
  let lastConnectorActivity = 0;
  let connectorStartTime = 0;
  // Peers already reported on stderr for a version/build mismatch.
  const rejectedPluginPeers = new Set<string>();
  // Rejected /ready attempts are otherwise visible only to the plugin, so a
  // stale plugin would look exactly like Studio not being open.
  const rejectedConnections: Record<string, unknown>[] = [];
  const studioTransport = new WebSocketStudioTransport(bridge);
  const transportTokens = new Map<string, string>();
  const boundServers = new Set<http.Server>();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_STUDIO_FRAME_BYTES,
  });
  let closed = false;
  const unsubscribePeerClosed = bridge.onPeerClosed((peer) => {
    transportTokens.delete(peer.peerId);
  });

  const setConnectorActive = (active: boolean) => {
    connectorActive = active;
    if (active) {
      connectorStartTime = Date.now();
      lastConnectorActivity = Date.now();
    } else {
      connectorStartTime = 0;
      lastConnectorActivity = 0;
    }
    studioTransport.refreshStatus();
  };

  const trackConnectorActivity = () => {
    if (connectorActive) {
      const wasConnected = (Date.now() - lastConnectorActivity) < 30000;
      lastConnectorActivity = Date.now();
      if (!wasConnected) studioTransport.refreshStatus();
    }
  };

  const isConnectorActive = () => {
    if (!connectorActive) return false;
    return (Date.now() - lastConnectorActivity) < 30000;
  };

  const eventStatus = (transportPeerId: string): StudioStatusEvent => {
    const peer = bridge.getPeerById(transportPeerId);
    const knownPeer = peer?.transportPeerId === transportPeerId;
    return {
      kind: 'status',
      knownPeer,
      connectorConnected: isConnectorActive(),
      serverVersion: serverConfig?.version,
      pluginVersion: peer?.pluginVersion,
      pluginVariant: peer?.pluginVariant,
    };
  };


  const isPluginConnected = () => {
    return bridge.getPeers().length > 0;
  };

  // -- Origin policy --
  // The Studio plugin is a native HTTP client and never sends an Origin
  // header. Any request that does carry one is a browser request, which the
  // loopback-only CLI intentionally rejects.
  const upgradeStudio = (req: http.IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on('error', () => socket.destroy());
    if (closed) {
      rejectStudioUpgrade(socket, 503, 'server_shutdown');
      return;
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      rejectStudioUpgrade(socket, 400, 'invalid_websocket_url');
      return;
    }
    if (url.pathname !== '/studio') {
      rejectStudioUpgrade(socket, 404, 'unknown_websocket_endpoint');
      return;
    }
    const origin = req.headers.origin;
    if (origin) {
      rejectStudioUpgrade(socket, 403, 'forbidden_origin');
      return;
    }
    if (req.method !== 'GET' || url.searchParams.getAll('protocolVersion').length !== 1
      || url.searchParams.get('protocolVersion') !== String(STUDIO_PROTOCOL_VERSION)) {
      rejectStudioUpgrade(socket, 426, 'studio_protocol_mismatch');
      return;
    }
    const peerId = url.searchParams.get('peerId');
    if (!peerId || url.searchParams.getAll('peerId').length !== 1) {
      rejectStudioUpgrade(socket, 400, 'missing_peer_id');
      return;
    }
    const peer = bridge.getPeerById(peerId);
    if (!peer) {
      rejectStudioUpgrade(socket, 404, 'unknown_peer');
      return;
    }
    if (peer.transportPeerId !== peerId) {
      rejectStudioUpgrade(socket, 403, 'peer_has_no_socket');
      return;
    }
    const token = transportTokens.get(peerId);
    const provided = req.headers['x-studio-token'];
    if (!token || typeof provided !== 'string' || !tokensMatch(provided, token)) {
      rejectStudioUpgrade(socket, 401, 'invalid_studio_token');
      return;
    }
    if (!studioTransport.canOpen(peerId)) {
      rejectStudioUpgrade(socket, 503, 'studio_socket_capacity_reached');
      return;
    }
    webSocketServer.handleUpgrade(req, socket, head, (webSocket) => {
      // ws rejects oversized frames before delivering a message to the adapter.
      webSocket.on('error', (error) => {
        if ('code' in error && error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
          console.error(`[studio-websocket] server_receive frame exceeds limitBytes=${MAX_STUDIO_FRAME_BYTES}`);
        }
      });
      const handle = studioTransport.open(peerId, webSocket, () => eventStatus(peerId));
      if (!handle) webSocket.close(1013, 'studio_socket_capacity_reached');
    });
  };
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || origin === '') {
      next();
      return;
    }
    if (origin) {
      if (req.path.toLowerCase().startsWith('/v2/') || req.path === '/health' || req.path === '/status' || req.path === '/request-status') {
        res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
      }
      res.status(403).json({
        error: {
          code: 'forbidden_origin',
          message: `Cross-origin requests are not allowed from ${origin}. roblox-cli accepts native loopback clients only.`,
          execution: 'not_started',
          retry: 'never',
        },
      });
      return;
    }
    next();
  });

  // -- Shared-secret auth --
  // Tool-invoking and recovery endpoints require the local shared secret.
  // Native plugin bootstrap retains its Origin policy; the duplex /studio
  // upgrade and live-session refresh require a secret bound to the Peer.
  const authToken = security?.authToken;
  const agentCommandPrefix = AGENT_COMMAND_PREFIX.toLowerCase();
  const agentRequestsPrefix = AGENT_REQUESTS_PREFIX.toLowerCase();
  const isAgentEndpoint = (requestPath: string): boolean => {
    const path = requestPath.toLowerCase().replace(/\/+$/, '');
    return path === AGENT_HEALTH_PATH.toLowerCase() || path === AGENT_STATUS_PATH.toLowerCase()
      || path === '/health' || path === '/status' || path === '/request-status'
      || path === AGENT_SCHEMA_PATH.toLowerCase() || path === AGENT_DAEMON_STOP_PATH.toLowerCase()
      || path === agentCommandPrefix || path.startsWith(`${agentCommandPrefix}/`)
      || path === agentRequestsPrefix || path.startsWith(`${agentRequestsPrefix}/`);
  };
  app.use((req, res, next) => {
    if (isAgentEndpoint(req.path)) res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    next();
  });
  const authRequired = (requestPath: string): boolean => {
    // Match Express's default case-insensitive, non-strict route aliases.
    const path = requestPath.toLowerCase().replace(/\/+$/, '');
    return path === '/health' || path === '/status' || path === '/request-status' ||
      isAgentEndpoint(path);
  };
  app.use((req, res, next) => {
    if (!authRequired(req.path)) {
      next();
      return;
    }
    if (!authToken) {
      res.status(503).json({
        error: {
          code: 'auth_unavailable',
          message: 'roblox-cli cannot expose workflow or status endpoints without a local auth token.',
          execution: 'not_started',
          retry: 'after_fix',
        },
      });
      return;
    }
    const headerToken = req.headers['x-studio-auth'];
    const bearer = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined;
    const provided = typeof headerToken === 'string' && headerToken !== '' ? headerToken : bearer;
    if (provided !== undefined && tokensMatch(provided, authToken)) {
      next();
      return;
    }
    res.status(401).json({
      error: {
        code: 'unauthorized',
        message: 'Missing or invalid auth token. Send it as "X-Studio-Auth: <token>" or "Authorization: Bearer <token>". ' +
          (security?.authTokenHint ?? 'The token is in ~/Library/Application Support/roblox-cli/auth-token (or ROBLOX_CLI_AUTH_TOKEN).'),
        execution: 'not_started',
        retry: 'after_fix',
      },
    });
  });

  app.use((req, res, next) => {
    if (!isAgentEndpoint(req.path)) {
      next();
      return;
    }
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    const requested = req.headers[AGENT_PROTOCOL_HEADER.toLowerCase()];
    if (requested !== undefined && (typeof requested !== 'string' || requested !== String(AGENT_PROTOCOL_VERSION))) {
      res.status(426).json({
        error: {
          code: 'protocol_mismatch',
          message: `This daemon speaks Agent Protocol v${AGENT_PROTOCOL_VERSION}.`,
          execution: 'not_started',
          retry: 'after_fix',
          details: { requested: Array.isArray(requested) ? requested.join(',') : requested },
        },
      });
      return;
    }
    next();
  });

  app.use(express.json({ limit: HTTP_BODY_LIMIT_BYTES }));
  app.use(express.urlencoded({ limit: HTTP_BODY_LIMIT_BYTES, extended: true }));
  const handleBodySizeError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (!error || typeof error !== 'object' || !('type' in error) || error.type !== 'entity.too.large') {
      next(error);
      return;
    }
    // raw-body reports the declared length when rejecting before reading, or
    // the received byte count when a streamed/inflated body crosses the cap.
    const bytes = 'received' in error && typeof error.received === 'number' ? error.received
      : 'length' in error && typeof error.length === 'number' ? error.length : undefined;
    if (bytes === undefined) {
      next(error);
      return;
    }
    res.status(413).json({
      error: {
        code: 'request_too_large',
        message: `Request body is ${bytes} bytes; the limit is ${HTTP_BODY_LIMIT_BYTES} bytes.`,
        execution: 'not_started',
        retry: 'after_fix',
        details: { bytes, limit_bytes: HTTP_BODY_LIMIT_BYTES, stage: 'http_receive' },
      },
    });
  };
  app.use(handleBodySizeError);
  const handleRequestBodyError: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (!error || typeof error !== 'object' || !('type' in error) || error.type !== 'entity.parse.failed') {
      next(error);
      return;
    }
    res.status(400).json({
      error: {
        code: 'invalid_json',
        message: 'Request body is not valid JSON.',
        execution: 'not_started',
        retry: 'after_fix',
      },
    });
  };
  app.use(handleRequestBodyError);


  app.get([AGENT_HEALTH_PATH, '/health'], (req, res) => {
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    const peers = bridge.getPublicPeers().map(toPassivePeer);
    const instances = bridge.getPublicInstances().map(toPassiveInstance);
    const multiplayerGroups = bridge.getPublicMultiplayerGroups();
    res.json({
      status: 'ok',
      service: 'roblox-cli-daemon',
      pid: process.pid,
      serverName: serverConfig?.name ?? 'roblox-cli-daemon',
      version: serverConfig?.version,
      serverVersion: serverConfig?.version,
      capabilities: studioLifecycleCallable ? {
          studioLifecycle: {
            protocolVersion: 3,
            endpoint: `${AGENT_COMMAND_PREFIX}/open`,
            ...studioLifecycleCapabilities,
          },
      } : {},
      pluginConnected: peers.length > 0,
      instanceCount: instances.length,
      peerCount: peers.length,
      instances,
      peers,
      multiplayerGroups,
      connectorActive: isConnectorActive(),
      uptime: connectorActive ? Date.now() - connectorStartTime : 0,
      pendingRequests: bridge.getPendingRequestCount(),
      activeWebSockets: studioTransport.activeSocketCount,
      studioSocketCapacity: MAX_ACTIVE_STUDIO_SOCKETS,
      apiVersion: AGENT_PROTOCOL_VERSION,
      commands: [...publicCommands],
      daemon_build_id: serverConfig?.buildId ?? null,
      rejected_connections: rejectedConnections,
    });
  });

  app.get(AGENT_SCHEMA_PATH, (_req, res) => {
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    res.json(agentSchema(publicCommands));
  });

  // Signals cannot stop a detached daemon gracefully on every platform, so the
  // CLI asks over the authenticated loopback boundary and then waits for `pid`.
  const stopDaemon = serverConfig?.stop;
  if (stopDaemon) {
    app.post(AGENT_DAEMON_STOP_PATH, (_req, res) => {
      res.once('finish', stopDaemon);
      res.status(202).json({ stopping: true, pid: process.pid });
    });
  }

  app.post('/ready', (req, res) => {
    const {
      peerId,
      transportPeerId,
      instanceId,
      multiplayerGroupId,
      role,
      placeId,
      placeName,
      placeKey,
      dataModelName,
      isRunning,
      pluginVersion,
      pluginVariant,
      pluginBuildId,
      timestamp,
    } = req.body;
    const requestContext = {
      peerId: typeof peerId === 'string' ? peerId : undefined,
      transportPeerId: typeof transportPeerId === 'string' ? transportPeerId : undefined,
      instanceId: typeof instanceId === 'string' ? instanceId : undefined,
      multiplayerGroupId: typeof multiplayerGroupId === 'string' ? multiplayerGroupId : undefined,
      role: typeof role === 'string' ? role : undefined,
      placeId: typeof placeId === 'number' ? placeId : undefined,
      placeName: typeof placeName === 'string' ? placeName : undefined,
      placeKey: typeof placeKey === 'string' ? placeKey : undefined,
      dataModelName: typeof dataModelName === 'string' ? dataModelName : undefined,
      isRunning: typeof isRunning === 'boolean' ? isRunning : undefined,
      pluginVersion: typeof pluginVersion === 'string' ? pluginVersion : undefined,
      pluginVariant: typeof pluginVariant === 'string' ? pluginVariant : undefined,
      pluginBuildId: typeof pluginBuildId === 'string' ? pluginBuildId : undefined,
      timestamp: typeof timestamp === 'number' ? timestamp : undefined,
    };
    const serverVersion = serverConfig?.version;
    const daemonBuildId = serverConfig?.buildId;
    const reject = (status: number, body: Record<string, unknown> & { error: string }) => {
      rejectedConnections.push({
        at: new Date().toISOString(),
        error: body.error,
        role: requestContext.role ?? null,
        instance_id: requestContext.instanceId ?? null,
        place_name: requestContext.placeName ?? null,
        plugin_version: requestContext.pluginVersion ?? null,
        plugin_build_id: requestContext.pluginBuildId ?? null,
        server_version: serverVersion ?? null,
        daemon_build_id: daemonBuildId ?? null,
      });
      if (rejectedConnections.length > MAX_REJECTED_CONNECTIONS) rejectedConnections.shift();
      if (status === 426 && requestContext.peerId !== undefined && !rejectedPluginPeers.has(requestContext.peerId)) {
        if (rejectedPluginPeers.size >= 256) rejectedPluginPeers.clear();
        rejectedPluginPeers.add(requestContext.peerId);
        console.error(`[plugin-rejected] ${body.error} for ${instanceId}/${role}: ${body.message}`);
      }
      res.status(status).json({ success: false, ...body });
    };

    const missingFields = [
      typeof peerId !== 'string' || peerId === '' ? 'peerId' : undefined,
      typeof transportPeerId !== 'string' || transportPeerId === '' ? 'transportPeerId' : undefined,
      typeof instanceId !== 'string' || instanceId === '' ? 'instanceId' : undefined,
      typeof role !== 'string' || role === '' ? 'role' : undefined,
      typeof placeId !== 'number' || !Number.isFinite(placeId) ? 'placeId' : undefined,
      typeof placeName !== 'string' ? 'placeName' : undefined,
      typeof dataModelName !== 'string' ? 'dataModelName' : undefined,
      typeof isRunning !== 'boolean' ? 'isRunning' : undefined,
      typeof pluginVersion !== 'string' || pluginVersion === '' ? 'pluginVersion' : undefined,
      typeof pluginVariant !== 'string' || pluginVariant === '' ? 'pluginVariant' : undefined,
      typeof timestamp !== 'number' || !Number.isFinite(timestamp) ? 'timestamp' : undefined,
    ].filter((field): field is string => !!field);
    if (missingFields.length > 0) {
      reject(400, {
        error: 'missing_ready_fields',
        message: `/ready missing required field(s): ${missingFields.join(', ')}`,
        missingFields,
        request: requestContext,
      });
      return;
    }
    if (multiplayerGroupId !== undefined && (typeof multiplayerGroupId !== 'string' || multiplayerGroupId === '')) {
      reject(400, {
        error: 'invalid_multiplayer_group_id',
        message: 'multiplayerGroupId must be a non-empty string when provided.',
        request: requestContext,
      });
      return;
    }

    if (!serverVersion) {
      reject(503, {
        error: 'server_version_unavailable',
        message: 'The roblox-cli daemon cannot accept Studio connections without a configured version.',
        request: requestContext,
      });
      return;
    }
    if (pluginVersion !== serverVersion) {
      reject(426, {
        error: 'plugin_version_mismatch',
        message: `Studio plugin v${pluginVersion} does not match roblox-cli daemon v${serverVersion}.`,
        pluginVersion,
        serverVersion,
        request: requestContext,
      });
      return;
    }
    if (daemonBuildId !== undefined && pluginBuildId !== daemonBuildId) {
      reject(426, {
        error: 'plugin_build_mismatch',
        message: `Studio plugin build ${requestContext.pluginBuildId ?? '(none)'} does not match roblox-cli daemon build ${daemonBuildId}.`,
        next: 'roblox setup, then reload plugins in Studio',
        pluginBuildId: requestContext.pluginBuildId,
        daemonBuildId,
        request: requestContext,
      });
      return;
    }

    const isClientRole = role === 'client' || /^client-[1-9]\d*$/.test(role);
    const isProxiedPeer = transportPeerId !== peerId;
    if (
      (isProxiedPeer && !isClientRole) ||
      (!isProxiedPeer && isClientRole) ||
      (!isClientRole && role !== 'edit' && role !== 'server')
    ) {
      reject(400, {
        error: 'invalid_peer_topology',
        message: 'Transport Peers must use the edit or server role; client Peers must use a distinct server transport Peer.',
        request: requestContext,
      });
      return;
    }

    if (isProxiedPeer) {
      const transportOwner = bridge.getPeerById(transportPeerId);
      const sameInstance = transportOwner?.instanceId === instanceId;
      const sameMultiplayerGroup = typeof multiplayerGroupId === 'string'
        && transportOwner?.multiplayerGroupId === multiplayerGroupId;
      if (
        !transportOwner ||
        transportOwner.peerId !== transportPeerId ||
        transportOwner.transportPeerId !== transportPeerId ||
        transportOwner.role !== 'server' ||
        (!sameInstance && !sameMultiplayerGroup)
      ) {
        reject(409, {
          error: 'transport_peer_unavailable',
          message: 'A client Peer requires a registered server transport Peer in the same Instance or explicit MultiplayerGroup.',
          request: requestContext,
        });
        return;
      }
      // Only the server plugin that owns the transport may register the
      // client Peers it proxies.
      const providedToken = req.headers['x-studio-token'];
      const serverToken = transportTokens.get(transportPeerId);
      if (typeof providedToken !== 'string' || serverToken === undefined || !tokensMatch(providedToken, serverToken)) {
        reject(401, {
          error: 'invalid_studio_token',
          message: 'A client Peer must be registered with the X-Studio-Token of its server transport Peer.',
          peerId,
          instanceId,
        });
        return;
      }
    }

    // A previously issued transport credential proves ownership of this Peer
    // session. Do not let a second local caller re-register the same identity
    // and obtain the WebSocket credential. Reconnects remain allowed after the
    // old socket has gone away because the plugin presents the same credential.
    if (!isProxiedPeer && transportTokens.has(peerId)) {
      const providedToken = req.headers['x-studio-token'];
      const expectedToken = transportTokens.get(peerId);
      if (typeof providedToken !== 'string' || expectedToken === undefined || !tokensMatch(providedToken, expectedToken)) {
        reject(401, {
          error: 'studio_session_auth_required',
          message: 'An already-connected Studio Peer must present its current transport token to refresh the session.',
          peerId,
          instanceId,
        });
        return;
      }
    }
    if (closed || (!isProxiedPeer && !transportTokens.has(peerId) && transportTokens.size >= MAX_STUDIO_SESSIONS)) {
      reject(503, { error: closed ? 'server_shutdown' : 'studio_session_capacity_reached' });
      return;
    }

    let result: RegisterPeerResult;
    try {
      result = bridge.registerPeer({
        peerId,
        transportPeerId,
        instanceId,
        multiplayerGroupId,
        role,
        placeId,
        placeName,
        placeKey: typeof placeKey === 'string' ? placeKey : undefined,
        dataModelName,
        isRunning,
        pluginVersion,
        pluginVariant,
        serverVersion,
      });
    } catch (err) {
      reject(500, {
        error: 'ready_registration_exception',
        message: err instanceof Error ? err.message : String(err),
        request: requestContext,
      });
      return;
    }

    if (!result.ok) {
      reject(409, {
        error: result.error.code,
        message: result.error.message,
        request: requestContext,
        existing: result.error.existing,
      });
      return;
    }
    let transportToken: string | undefined;
    if (!isProxiedPeer) {
      transportToken = transportTokens.get(peerId) ?? randomBytes(32).toString('hex');
      transportTokens.set(peerId, transportToken);
    }
    studioTransport.refreshStatus(transportPeerId);

    res.json({
      success: true,
      assignedRole: result.assignedRole,
      peerId: result.peerId,
      instanceId: result.instanceId,
      multiplayerGroupId: result.multiplayerGroupId,
      serverVersion,
      ...(!isProxiedPeer ? { protocolVersion: STUDIO_PROTOCOL_VERSION, transportToken } : {}),
    });
  });


  app.post('/disconnect', (req, res) => {
    const { peerId } = req.body;

    if (typeof peerId === 'string' && peerId !== '') {
      // A proxied client Peer has no credential of its own; its server
      // transport Peer's credential authorizes its disconnect.
      const transportPeerId = bridge.getPeerById(peerId)?.transportPeerId;
      const isProxiedPeer = transportPeerId !== undefined && transportPeerId !== peerId;
      if (isProxiedPeer || transportTokens.has(peerId)) {
        const providedToken = req.headers['x-studio-token'];
        const expectedToken = transportTokens.get(isProxiedPeer ? transportPeerId : peerId);
        if (typeof providedToken !== 'string' || expectedToken === undefined || !tokensMatch(providedToken, expectedToken)) {
          res.status(401).json({
            success: false,
            error: isProxiedPeer ? 'invalid_studio_token' : 'studio_session_auth_required',
            message: isProxiedPeer
              ? 'A client Peer must be disconnected with the X-Studio-Token of its server transport Peer.'
              : 'An already-connected Studio Peer must present its current transport token to disconnect.',
            peerId,
          });
          return;
        }
      }
      bridge.unregisterPeer(peerId);
    }
    res.json({ success: true });
  });

  app.get([AGENT_STATUS_PATH, '/status'], async (req, res) => {
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    const peers = bridge.getPublicPeers().map(toPassivePeer);
    const instances = bridge.getPublicInstances();
    const session = cliCommands.service.sessionSnapshot();
    // The capture probe screenshots every peer; plain status polls stay cheap.
    const captureProbe = req.query.capture_probe === '1';
    const runtimeHealthByInstance = new Map<string, Record<string, unknown>>();
    await Promise.all(instances.map(async (instance) => {
      try {
        const health = await tools.getRuntimeHealth(instance.id, undefined, true, undefined, undefined, captureProbe);
        const healthPeers = health.peers;
        if (healthPeers && typeof healthPeers === 'object' && !Array.isArray(healthPeers)) {
          runtimeHealthByInstance.set(instance.id, healthPeers as Record<string, unknown>);
        }
      } catch (error) {
        runtimeHealthByInstance.set(instance.id, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }));
    res.json({
      connected: peers.length > 0,
      connector_active: isConnectorActive(),
      server_version: serverConfig?.version,
      daemon_build_id: serverConfig?.buildId ?? null,
      uptime_ms: connectorActive ? Date.now() - connectorStartTime : 0,
      pending_requests: bridge.getPendingRequestCount(),
      instances: instances.map((instance) => toAgentInstance(instance, runtimeHealthByInstance.get(instance.id))),
      ...(session === undefined ? {} : { session: toAgentSession(session) }),
      ...(rejectedConnections.length === 0 ? {} : { rejected_connections: rejectedConnections }),
    });
  });


  app.get(['/studio', '/events'], (_req, res) => {
    res.setHeader('Upgrade', 'websocket');
    res.status(426).json({ error: 'studio_websocket_required', protocolVersion: STUDIO_PROTOCOL_VERSION });
  });




  app.post('/response', (_req, res) => {
    res.setHeader('Upgrade', 'websocket');
    res.status(426).json({ error: 'studio_websocket_required', protocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  const sendRequestStatus = (res: Response, requestId: string) => {
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    res.setHeader(REQUEST_ID_HEADER, requestId);
    const status = cliCommands.service.jobs.status(requestId) ?? workflowStatus(requestId)
      ?? cliCommands.service.requestStatus(requestId);
    if (status === undefined) {
      res.status(404).json({
        error: {
          code: 'unknown_request',
          message: `No request ${requestId} is known to this daemon: it never existed, expired from retention, or predates a daemon restart.`,
          execution: 'unknown',
          retry: 'never',
        },
      });
      return;
    }
    res.json(status);
  };

  app.get('/request-status', (req, res) => {
    res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
    const requestId = req.query.requestId;
    if (typeof requestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId) || requestId === '.' || requestId === '..') {
      res.status(400).json({
        error: {
          code: 'invalid_request_id',
          message: 'requestId must be a safe request identifier of at most 128 characters.',
          execution: 'not_started',
          retry: 'after_fix',
        },
      });
      return;
    }
    sendRequestStatus(res, requestId);
  });

  app.get(`${AGENT_REQUESTS_PREFIX}/:requestId`, (req, res) => {
    const requestId = req.params.requestId;
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(requestId) || requestId === '.' || requestId === '..') {
      res.status(400).json({
        error: {
          code: 'invalid_request_id',
          message: 'request_id must contain only letters, numbers, dots, underscores, colons, or hyphens.',
          execution: 'not_started',
          retry: 'after_fix',
        },
      });
      return;
    }
    sendRequestStatus(res, requestId);
  });


  app.use(`${AGENT_COMMAND_PREFIX}/*`, (req, res, next) => {
    trackConnectorActivity();
    next();
  });

  // Only the five CLI workflow handlers are ever registered as public HTTP
  // commands; bridge internals are not addressable by name.
  const commandHandlers: Record<string, CliCommandHandler> = cliCommands.handlers;
  for (const [toolName, handler] of Object.entries(commandHandlers)) {
    if (!publicCommands.has(toolName)) continue;

    app.post(`${AGENT_COMMAND_PREFIX}/${toolName}`, async (req, res) => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const suppliedRequestId = req.headers['x-request-id'];
      res.setHeader(AGENT_PROTOCOL_HEADER, String(AGENT_PROTOCOL_VERSION));
      if (suppliedRequestId !== undefined && (typeof suppliedRequestId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(suppliedRequestId))) {
        res.status(400).json({
          error: {
            code: 'invalid_request_id',
            message: 'X-Request-ID must contain only letters, numbers, dots, underscores, colons, or hyphens, and be at most 128 characters.',
            execution: 'not_started',
            retry: 'after_fix',
          },
        });
        return;
      }
      const requestId = typeof suppliedRequestId === 'string' ? suppliedRequestId : randomBytes(16).toString('hex');
      res.setHeader(REQUEST_ID_HEADER, requestId);
      if (toolName === 'test' && req.body?.action === 'play' && req.body.background !== false) {
        try {
          const job = cliCommands.service.submitTest(req.body, requestId);
          res.status(202).json({ accepted: true, ...job as Record<string, unknown>, next: `roblox status --request-id ${requestId}` });
        } catch (error) { res.status(commandErrorStatus(error)).json(publicToolErrorBody(toolName, error)); }
        return;
      }
      if (toolName === 'open' || toolName === 'test') {
        pruneWorkflows();
        if (workflows.has(requestId)) {
          res.status(409).json({ error: { code: 'duplicate_request', message: 'This workflow request id already exists. Query its status; it was not replayed.', execution: 'not_started', retry: 'never' } });
          return;
        }
        if (workflows.size >= workflowLimit) {
          const settled = [...workflows].find(([, receipt]) => receipt.state === 'settled');
          if (settled) workflows.delete(settled[0]);
          else {
            res.status(503).json({ error: { code: 'workflow_capacity', message: 'Too many active workflows.', execution: 'not_started', retry: 'after_fix' } });
            return;
          }
        }
        workflows.set(requestId, { state: 'pending', execution: 'pending', command: toolName, execution_started_at: Date.now() });
      }
      req.once('aborted', abort);
      res.once('close', abort);
      try {
        if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
          throw new CliCommandError('invalid_body', 'Command body must be a JSON object.');
        }
        const result = normalizeCommandResult(await handler(tools, req.body, {
          signal: controller.signal,
          requestId,
        }));
        const body = result as Record<string, unknown> | undefined;
        settleWorkflow(requestId, result, body?.passed === false || body?.error !== undefined);
        res.json(result);
      } catch (error) {
        const status = commandErrorStatus(error);
        const body = publicToolErrorBody(toolName, error);
        settleWorkflow(requestId, body, true);
        res.status(status).json(body);
      } finally {
        req.removeListener('aborted', abort);
        res.removeListener('close', abort);
      }
    });
  }

  // Keep unknown v2 agent routes JSON-shaped as well. Express's default HTML
  // 404 is hostile to an agent and makes an old/new daemon mismatch opaque.
  app.use((req, res, next) => {
    if (!isAgentEndpoint(req.path)) {
      next();
      return;
    }
    res.status(404).json({
      error: {
        code: 'unknown_agent_route',
        message: `No Agent Protocol v${AGENT_PROTOCOL_VERSION} route matches ${req.method} ${req.path}.`,
        execution: 'not_started',
        retry: 'never',
      },
    });
  });


  app.isPluginConnected = isPluginConnected;
  app.setConnectorActive = setConnectorActive;
  app.isConnectorActive = isConnectorActive;
  app.trackConnectorActivity = trackConnectorActivity;
  app.attachStudioTransport = (server) => {
    if (closed) throw new Error('Cannot attach a closed Studio transport');
    if (boundServers.has(server)) return;
    boundServers.add(server);
    server.on('upgrade', upgradeStudio);
    server.once('close', () => {
      boundServers.delete(server);
      server.removeListener('upgrade', upgradeStudio);
    });
  };
  app.cleanup = async () => {
    if (closed) return;
    closed = true;
    for (const server of boundServers) server.removeListener('upgrade', upgradeStudio);
    boundServers.clear();
    unsubscribePeerClosed();
    transportTokens.clear();
    studioTransport.close();
    webSocketServer.close();
  };

  return app;
}

function commandErrorStatus(error: unknown): number {
  if (error instanceof CliCommandError) return error.statusCode;
  if (error instanceof RoutingFailure) return 400;
  if (error instanceof RequestFailure) {
    if (error.code === 'request_too_large') return 413;
    if (error.details.outcome === 'not_executed') return 503;
    // Studio ran the request and it failed: not a gateway timeout.
    if (error.details.executionOutcome === 'error') return 422;
    return 504;
  }
  return 500;
}

/**
 * Attempt to bind an Express app to a port, using an explicit http.Server
 * so that EADDRINUSE errors are properly caught.
 */
export async function listenWithRetry(
  app: express.Express,
  host: string,
  startPort: number,
  maxAttempts: number = 5
): Promise<{ server: http.Server; port: number }> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const server = await bindPort(app, host, port);
      return { server, port };
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'EADDRINUSE'
      ) {
        console.error(`Port ${port} in use, trying next...`);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`All ports ${startPort}-${startPort + maxAttempts - 1} are in use. Stop some Roblox Studio instances and retry.`);
}

function bindPort(app: express.Express, host: string, port: number): Promise<http.Server> {
  const { promise, resolve, reject } = Promise.withResolvers<http.Server>();
  const server = http.createServer(app);
  const onError = (err: NodeJS.ErrnoException) => {
    server.removeListener('error', onError);
    reject(err);
  };
  server.once('error', onError);
  server.listen(port, host, () => {
    server.removeListener('error', onError);
    try {
      if ('attachStudioTransport' in app && typeof app.attachStudioTransport === 'function') {
        app.attachStudioTransport(server);
      }
      resolve(server);
    } catch (error) {
      server.close();
      reject(error);
    }
  });
  return promise;
}
