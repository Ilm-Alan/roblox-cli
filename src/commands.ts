/**
 * The only command names reachable through the authenticated agent API.
 * Everything else in the bridge is an implementation detail of one of these
 * five workflows. This is intentionally a Set so the daemon rejects unknown
 * names before they can reach Studio.
 */
export const CLI_COMMAND_NAMES = ['open', 'eval', 'logs', 'screenshot', 'test'] as const;
export const CLI_COMMANDS = new Set<string>(CLI_COMMAND_NAMES);
