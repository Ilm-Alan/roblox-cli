import { Connection } from "../types";

const CURRENT_VERSION = "__VERSION__";
// Hash of the bundled plugin sources; the daemon accepts only its packaged build.
const CURRENT_BUILD_ID = "__BUILD_ID__";
const PLUGIN_VARIANT = "__PLUGIN_VARIANT__";
const BASE_PORT = 58741;

function createConnection(port: number): Connection {
	return {
		port,
		serverUrl: `http://127.0.0.1:${port}`,
		isActive: false,
		consecutiveFailures: 0,
		maxFailuresBeforeError: 50,
		currentRetryDelay: 0.5,
		lastHttpOk: false,
		lastConnectorOk: false,
		connectorWaitStartTime: undefined,
		heartbeatConnection: undefined,
	};
}

const connection = createConnection(BASE_PORT);

function getActiveConnection(): Connection {
	return connection;
}

export = {
	CURRENT_VERSION,
	CURRENT_BUILD_ID,
	PLUGIN_VARIANT,
	BASE_PORT,
	getActiveConnection,
};
