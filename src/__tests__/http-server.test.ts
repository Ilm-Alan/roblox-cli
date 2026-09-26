import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { BridgeService, RequestFailure } from '../bridge-service.js';
import { CliCommandService } from '../cli-command-service.js';
import { createHttpServer } from '../http-server.js';
import type { RobloxStudioHttpApp } from '../http-server.js';
import { RobloxStudioTools } from '../tools/index.js';

const AUTH = { 'X-Studio-Auth': 'test-token' };
const BUILD_ID = '0123456789abcdef';

interface Harness {
  bridge: BridgeService;
  app: RobloxStudioHttpApp;
  url: (path: string) => string;
}

const harnesses: Array<{ app: RobloxStudioHttpApp; server: http.Server }> = [];

async function start({ buildId }: { buildId?: string } = { buildId: BUILD_ID }): Promise<Harness> {
  const bridge = new BridgeService();
  const app = createHttpServer(new RobloxStudioTools(bridge), bridge, undefined,
    { name: 'test', version: '1.0.0', buildId }, { authToken: 'test-token' });
  const server = http.createServer(app).listen(0, '127.0.0.1');
  await once(server, 'listening');
  harnesses.push({ app, server });
  const { port } = server.address() as AddressInfo;
  return { bridge, app, url: (path) => `http://127.0.0.1:${port}${path}` };
}

beforeEach(() => {
  // Version/build rejections are also reported on the daemon's stderr.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const { app, server } of harnesses.splice(0)) {
    await app.cleanup();
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

function readyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    peerId: 'instance:test/server',
    transportPeerId: 'instance:test/server',
    instanceId: 'instance:test',
    role: 'server',
    placeId: 123,
    placeName: 'TestPlace',
    dataModelName: 'TestPlace',
    isRunning: true,
    pluginVersion: '1.0.0',
    pluginVariant: 'main',
    pluginBuildId: BUILD_ID,
    timestamp: 1,
    ...overrides,
  };
}

function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

describe('/ready build identity', () => {
  test('rejects a different or missing plugin build and records every rejection', async () => {
    const { url } = await start();

    const stale = await post(url('/ready'), readyBody({ pluginBuildId: 'ffffffffffffffff' }));
    expect(stale.status).toBe(426);
    expect(await json(stale)).toMatchObject({ success: false, error: 'plugin_build_mismatch', next: 'roblox setup, then reload plugins in Studio' });

    const missing = await post(url('/ready'), readyBody({ pluginBuildId: undefined }));
    expect(missing.status).toBe(426);
    expect(await json(missing)).toMatchObject({ error: 'plugin_build_mismatch' });

    const health = await json(await fetch(url('/v2/health'), { headers: AUTH }));
    expect(health.daemon_build_id).toBe(BUILD_ID);
    expect(health.peerCount).toBe(0);
    expect(health.rejected_connections).toEqual([
      {
        at: expect.any(String), error: 'plugin_build_mismatch', role: 'server', instance_id: 'instance:test',
        place_name: 'TestPlace', plugin_version: '1.0.0', plugin_build_id: 'ffffffffffffffff',
        server_version: '1.0.0', daemon_build_id: BUILD_ID,
      },
      expect.objectContaining({ error: 'plugin_build_mismatch', plugin_build_id: null }),
    ]);

    const status = await json(await fetch(url('/v2/status'), { headers: AUTH }));
    expect(status.daemon_build_id).toBe(BUILD_ID);
    expect(status.rejected_connections).toHaveLength(2);

    const current = await post(url('/ready'), readyBody());
    expect(current.status).toBe(200);
    expect(await json(current)).toMatchObject({ success: true, transportToken: expect.any(String) });
  });

  test('records other rejection paths and keeps only the newest 32', async () => {
    const { url } = await start();
    for (let index = 0; index < 33; index++) {
      const response = await post(url('/ready'), readyBody({ pluginVersion: index === 32 ? '0.9.0' : '1.0.0', role: index === 32 ? 'server' : 'bogus' }));
      expect(response.status).toBe(index === 32 ? 426 : 400);
    }
    const rejected = (await json(await fetch(url('/v2/health'), { headers: AUTH }))).rejected_connections as Array<Record<string, unknown>>;
    expect(rejected).toHaveLength(32);
    expect(rejected[0]).toMatchObject({ error: 'invalid_peer_topology', role: 'bogus' });
    expect(rejected[31]).toMatchObject({ error: 'plugin_version_mismatch', plugin_version: '0.9.0' });
  });

  test('an unknown daemon build skips the check and reports null', async () => {
    const { url } = await start({});
    const ready = await post(url('/ready'), readyBody({ pluginBuildId: undefined }));
    expect(ready.status).toBe(200);
    const health = await json(await fetch(url('/v2/health'), { headers: AUTH }));
    expect(health.daemon_build_id).toBeNull();
    expect(health.rejected_connections).toEqual([]);
    jest.spyOn(RobloxStudioTools.prototype, 'getRuntimeHealth').mockResolvedValue({ peers: {} });
    const status = await json(await fetch(url('/v2/status'), { headers: AUTH }));
    expect(status.daemon_build_id).toBeNull();
    expect(status).not.toHaveProperty('rejected_connections');
  });
});

describe('proxied client peers', () => {
  const client = readyBody({ peerId: 'instance:test/client-1', role: 'client-1', isRunning: true });

  async function withServer(): Promise<Harness & { serverToken: string }> {
    const harness = await start();
    const ready = await json(await post(harness.url('/ready'), readyBody()));
    return { ...harness, serverToken: ready.transportToken as string };
  }

  test('/ready requires the server transport token', async () => {
    const { bridge, url, serverToken } = await withServer();

    const anonymous = await post(url('/ready'), client);
    expect(anonymous.status).toBe(401);
    expect(await json(anonymous)).toMatchObject({ error: 'invalid_studio_token' });
    const forged = await post(url('/ready'), client, { 'X-Studio-Token': 'forged' });
    expect(forged.status).toBe(401);
    expect(bridge.getPeerById('instance:test/client-1')).toBeUndefined();

    const owned = await post(url('/ready'), client, { 'X-Studio-Token': serverToken });
    expect(owned.status).toBe(200);
    expect(await json(owned)).not.toHaveProperty('transportToken');
    expect(bridge.getPeerById('instance:test/client-1')?.transportPeerId).toBe('instance:test/server');

    const rejected = (await json(await fetch(url('/v2/health'), { headers: AUTH }))).rejected_connections;
    expect(rejected).toEqual([
      expect.objectContaining({ error: 'invalid_studio_token', role: 'client-1' }),
      expect.objectContaining({ error: 'invalid_studio_token', role: 'client-1' }),
    ]);
  });

  test('/disconnect requires the server transport token; unknown peers stay a no-op', async () => {
    const { bridge, url, serverToken } = await withServer();
    expect((await post(url('/ready'), client, { 'X-Studio-Token': serverToken })).status).toBe(200);

    const anonymous = await post(url('/disconnect'), { peerId: 'instance:test/client-1' });
    expect(anonymous.status).toBe(401);
    expect(await json(anonymous)).toMatchObject({ error: 'invalid_studio_token' });
    const forged = await post(url('/disconnect'), { peerId: 'instance:test/client-1' }, { 'X-Studio-Token': 'forged' });
    expect(forged.status).toBe(401);
    expect(bridge.getPeerById('instance:test/client-1')).toBeDefined();

    const owned = await post(url('/disconnect'), { peerId: 'instance:test/client-1' }, { 'X-Studio-Token': serverToken });
    expect(owned.status).toBe(200);
    expect(bridge.getPeerById('instance:test/client-1')).toBeUndefined();
    expect(bridge.getPeerById('instance:test/server')).toBeDefined();

    const gone = await post(url('/disconnect'), { peerId: 'instance:test/client-1' });
    expect(gone.status).toBe(200);
  });
});

test('unknown or expired request ids are a typed 404 on both status routes', async () => {
  const { url } = await start();
  for (const path of ['/v2/requests/never-issued', '/request-status?requestId=never-issued']) {
    const response = await fetch(url(path), { headers: AUTH });
    expect(response.status).toBe(404);
    expect((await json(response)).error).toMatchObject({ code: 'unknown_request', execution: 'unknown', retry: 'never' });
  }
});

test('status probes capture only when asked', async () => {
  const { bridge, url } = await start();
  expect((await post(url('/ready'), readyBody({ peerId: 'instance:test/edit', transportPeerId: 'instance:test/edit', role: 'edit', isRunning: false }))).status).toBe(200);
  const health = jest.spyOn(RobloxStudioTools.prototype, 'getRuntimeHealth').mockResolvedValue({ peers: {} });

  expect((await fetch(url('/v2/status'), { headers: AUTH })).status).toBe(200);
  expect((await fetch(url('/status?capture_probe=1'), { headers: AUTH })).status).toBe(200);

  expect(health.mock.calls.map((call) => call[5])).toEqual([false, true]);
  expect(bridge.getPendingRequestCount()).toBe(0);
});

test('a request Studio executed and failed maps to 422, not a gateway timeout', async () => {
  const { url } = await start();
  jest.spyOn(CliCommandService.prototype, 'evaluate').mockRejectedValue(new RequestFailure('boom', 'studio_response_error', {
    requestId: 'eval-1', targetPeerId: 'instance:test/edit', stage: 'response_delivery', outcome: 'unknown', executionOutcome: 'error',
  }));
  const response = await post(url('/v2/commands/eval'), { code: 'error("boom")' }, AUTH);
  expect(response.status).toBe(422);
});
