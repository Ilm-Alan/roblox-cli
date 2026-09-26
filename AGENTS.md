# Roblox Studio Agent

Keep the connector independently buildable and testable. Do not add an MCP
server or require a project repository at runtime. The public command API is
loopback-only, authenticated, and allowlisted in `src/commands.ts`.

The Studio plugin is generated from `studio-plugin/src` and must be built with
the pinned lockfiles. Keep `PROVENANCE.json` as historical attribution only;
new behavior belongs to this repository and must not be fetched dynamically.

The desktop is shared with the owner. Inspection, including screenshots and
client evaluation, must not activate Studio. Interactive play scenarios and
recording may require foreground use; announce that use before running them.
