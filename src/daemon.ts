/** roblox-cli daemon: a persistent local Studio bridge, with no MCP server. */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { authTokenPath, daemonPidPath, pluginAssetName } from './paths.js';
import { resolveAuthToken } from './auth.js';
import { BridgeService } from './bridge-service.js';
import { createHttpServer, listenWithRetry } from './http-server.js';
import { RobloxStudioTools } from './tools/index.js';
import { CLI_COMMANDS } from './commands.js';
import { assertSupportedPlatform } from './daemon-control.js';
import { AGENT_PROTOCOL_VERSION } from './agent-protocol.js';
import { pluginBuildId } from './install-plugin-helpers.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Studio must run the plugin packaged with this daemon; without a built
// plugin (a source checkout before `npm run build`) the build check is off.
const pluginArtifact = new URL(`../studio-plugin/${pluginAssetName()}`, import.meta.url);
const buildId = existsSync(pluginArtifact) ? pluginBuildId(readFileSync(pluginArtifact), pluginAssetName()) : undefined;
assertSupportedPlatform();
const port = Number(process.env.ROBLOX_CLI_PORT ?? 58741);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ROBLOX_CLI_PORT');
const auth = resolveAuthToken();
const bridge = new BridgeService();
const app = createHttpServer(new RobloxStudioTools(bridge), bridge, CLI_COMMANDS,
  { name: 'roblox-cli-daemon', version, buildId, stop: () => void shutdown() },
  {
    authToken: auth.token,
    authTokenHint: auth.source === 'env'
      ? 'The token is the ROBLOX_CLI_AUTH_TOKEN value the daemon was started with.'
      : `The token is in ${authTokenPath()} (or set ROBLOX_CLI_AUTH_TOKEN).`,
  });
const { server, port: boundPort } = await listenWithRetry(app, '127.0.0.1', port, 1);
writeFileSync(daemonPidPath(), String(process.pid), { mode: 0o600 });
app.setConnectorActive(true);
const maintenance = setInterval(() => {
  app.trackConnectorActivity();
  bridge.cleanupOldRequests();
  bridge.cleanupStalePeers();
}, 5000);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try { if (readFileSync(daemonPidPath(), 'utf8') === String(process.pid)) unlinkSync(daemonPidPath()); } catch { /* Already removed. */ }
  clearInterval(maintenance);
  app.setConnectorActive(false);
  bridge.clearAllPendingRequests();
  await app.cleanup();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, shutdown);
console.log(JSON.stringify({ service: 'roblox-cli-daemon', version, buildId: buildId ?? null, port: boundPort, apiVersion: AGENT_PROTOCOL_VERSION }));
