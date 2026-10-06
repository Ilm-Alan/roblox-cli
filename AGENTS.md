# Roblox Studio Agent

Keep the connector independently buildable and testable. Do not add an MCP
server or require a project repository at runtime. The public command API is
loopback-only, authenticated, and allowlisted in `src/commands.ts`.

The Studio plugin is generated from `studio-plugin/src` and must be built with
the pinned lockfiles. Keep `PROVENANCE.json` as historical attribution only;
new behavior belongs to this repository and must not be fetched dynamically.

The desktop is shared with the owner. Everything runs with Studio in the
background by default: inspection, screenshots, evaluation, scenario input
(engine-side virtual input) and recording never activate Studio, and nothing
wakes the display except a recording. `--foreground` is the only path that
brings Studio to the front; it exists for full-frame-rate video (Studio renders
at about 15 fps behind another app). It is an explicit opt-in: announce it to
the owner before running it, and never add it to make a run pass.

A playtest job must never outlive whoever follows it or leave its session
owned. Keep the three guarantees in `src/test-jobs.ts`, `src/cli.ts` and
`testPlay`: a followed job is cancelled when its CLI is signalled or its
status lease lapses (only `--detach` runs unattended); a run that fails after
play started still takes its teardown and settles; teardown proves the
runtime stopped from the bridge peer list, and reports cleanup problems in
`cleanup`, apart from the scenario `outcome`.
