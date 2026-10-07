# roblox-cli

`roblox-cli` is a developer-first, macOS-only command line for driving live
Roblox Studio. It keeps a persistent TypeScript daemon and a generated Luau
plugin, so each command is a small authenticated request rather than a new
MCP session or a new Studio connection.

The public workflow is intentionally small:

```text
roblox open
roblox eval 'return game:GetService("Workspace"):GetFullName()'
roblox logs --follow
roblox screenshot --output artifacts/current.jpg
roblox test play --duration 10
```

`eval` is the deep-access escape hatch. It runs arbitrary Luau in the edit
DataModel or an explicitly selected running server/client peer. `test` adds a
generic Luau runner and unified solo/multiplayer QA scenarios with logs,
screenshots, and input steps.

Scenario steps also support `wait_until`, which repeatedly evaluates a
condition on a selected peer until it is true for the requested number of
consecutive observations:

```json
{
  "steps": [
    {
      "type": "wait_until",
      "target": "client-1",
      "code": "return workspace:GetAttribute('OpeningReady') == true",
      "timeout_ms": 30000,
      "stable_samples": 8,
      "interval_ms": 100
    }
  ]
}
```

`timeout_ms` is a wall-clock deadline, honoured with a small bounded overshoot
by every condition wait (`wait_until` steps, a step's `expect`, and the play
readiness wait). Each poll is raced against the time left, with a 250 ms floor
so a poll started just before the deadline can still answer. A poll still
unanswered at the deadline is abandoned: its bridge waiter ends and Studio is
told to drop it, so nothing stays queued for later steps. A failed wait's
receipt has `timed_out`, `last_evaluation_abandoned`, and a `code` saying why:

- `host_slept`: the Mac slept during the wait (closing the lid sleeps it even
  while a recording or `caffeinate` keeps the display awake), so the deadline
  passed while nothing ran. `host_slept_ms` is a lower bound on the sleep, and
  the wait ends within a second of waking.
- `render_stalled`: the visible view (client-1, else edit) had stopped
  rendering, read from one runtime-health sample taken when the wait failed;
  `render` gives its `seconds_since_frame`.
- `timeout`: neither; the condition never held.

`warnings` on the receipt states the first two in plain words, and a play run
stopped by such a wait reports it as `failure.reason`.

## Install from this developer package

Requirements: macOS, Node.js 22+, Roblox Studio, and Apple's Command Line Tools
(Swift and the macOS SDK, used for native builds and window inspection).

The npm package is not published to a registry; the package metadata supports
local builds and `npm link`.

```bash
npm ci
npm --prefix studio-plugin ci
npm run build
npm link
roblox setup
roblox daemon start
```

`setup` installs the version-matched `RobloxCliStudio.rbxmx` plugin. Nothing
starts at login. The daemon is persistent, loopback-only and authenticated, and
you start it explicitly: `roblox daemon start` detaches it in the background
until `roblox daemon stop`; core commands never spawn it. `roblox daemon run`
is the foreground alternative, and `roblox daemon status` reports its pid, port,
version and log files.

The daemon is required, not a convenience. A Studio plugin can only make
outbound connections, so the edit DataModel and every play server/client peer
dial the daemon. It keeps logs, peer identity, and durable jobs between
commands. While it is stopped, commands fail with `daemon_unavailable`,
`execution: "not_started"`, exit code 3, and `next: "roblox daemon start"`.
Stop asks the daemon over the authenticated loopback boundary
(`POST /v2/daemon/stop`) and waits for the process to exit.

Installs made before this change also have
`~/Library/LaunchAgents/com.roblox.cli.daemon.plist`, which starts the daemon at
login and restarts it after `stop`. Remove it once:

```bash
launchctl bootout "gui/$(id -u)/com.roblox.cli.daemon"
rm ~/Library/LaunchAgents/com.roblox.cli.daemon.plist
```

## Agent protocol

The public agent protocol is version 2. It is intentionally a data protocol,
not an RPC envelope. The caller already knows which command it invoked and the
process exit status already carries command success, so successful stdout is
the command payload itself:

```json
{
  "target": "edit",
  "duration_ms": 4,
  "result": 7,
  "result_type": "number",
  "undo": "recorded"
}
```

The eval result is the returned Luau value, encoded losslessly. One value is
`result` with its Roblox `typeof` in `result_type`; several are `results` and
`result_types`; none omits both. Roblox values keep their type as `$type`
objects: `{"$type":"Instance","class":"Part","name":"Baseplate","path":"Workspace.Baseplate"}`,
`Vector3`, `Vector2`, `CFrame`, `Color3`, `UDim`, `UDim2`, `EnumItem` and
`BrickColor`. Tables that are not plain arrays or string-keyed objects become
`{"$type":"table","entries":[[key,value],...]}`, cycles become
`{"$type":"cycle"}`, and NaN or infinities become
`{"$type":"number","value":"nan"}`; `roblox schema` describes every form.
Captured `print`/`warn` lines appear only as a non-empty `output` array.
Errors carry tracebacks remapped to `user_code:LINE`. Each edit-mode eval is
one Studio undo step: `undo` is `recorded`, `reverted` (the snippet failed and
its partial changes were rolled back), or `unavailable`. A screenshot response
is direct metadata plus `image: { data, mime_type }` over HTTP; the `roblox`
command writes that binary to a file and prints only its `file`, `mime_type`,
`bytes`, and `sha256`.

Failures have one stable, actionable shape:

```json
{
  "error": {
    "code": "session_required",
    "message": "No active Studio session. Run \"roblox open\" first.",
    "execution": "not_started",
    "retry": "after_fix",
    "next": "roblox open"
  }
}
```

`execution` is present only when it helps decide what to do next:
`not_started` means the operation never reached Studio; `unknown` means it may
have executed and must not be replayed automatically. Unknown outcomes include
the request ID and a recovery command. Request IDs otherwise live in the
`X-Request-ID` response header and retained artifact metadata, not in every
normal result.

A session whose Studio went away fails with `session_disconnected` before
anything runs. `roblox open` then re-attaches when exactly one Studio is
connected (`reattached: true`); with several it names the instance ids to pass
as `--instance-id`, and with none it reports `studio_not_connected`. `roblox
open` also follows Studio when it updates itself mid-launch: the installer
relaunches Studio, and the launch adopts the new process.

`--timeout` on `eval` and `test run` is the Studio execution deadline (default
30 s, at most 3600). Studio refuses a request whose deadline already passed,
and stops waiting for a handler at the deadline, answering
`execution: "unknown"` because the code may still be running; its slot is freed
so later commands are not blocked. A transport that has work outstanding and
has sent nothing for 15 s is `unresponsive` and receives no new requests.

The authenticated loopback HTTP boundary mirrors this shape at
`/v2/commands/{command}`. It returns the payload directly, uses HTTP status
for transport/admission errors, and sends protocol metadata in
`X-Roblox-Agent-Protocol: 2` rather than in the JSON body. The Studio
WebSocket delivery protocol remains separate and retains its request IDs,
acknowledgements, cancellation, and execution phases because those fields are
needed for reliable delivery.

All normal command output is one compact JSON value. `roblox logs --follow`
emits non-empty result objects as newline-delimited JSON and suppresses empty
polls; `--duration SECONDS` and `--until REGEX` bound it, and it always ends
with `{"done":true,"reason":...,"next_cursor":...}` so the caller can resume
(exit 1 if `--until` never matched). Use `roblox schema` or authenticated
`GET /v2/schema` for the complete machine-readable command manifest.

Exit codes follow the error body: `4` when `execution` is `unknown`, `2` for
usage codes (fix the request), `3` for availability codes (daemon,
authentication, session, Studio, plugin build, target, or a request Studio
never took), `1` for any other failure, `0` for success, and `130`, `143` or
`129` when SIGINT, SIGTERM or SIGHUP ends the command (a followed playtest is
cancelled first; see Durable scenarios); `roblox schema` lists the codes under
`exit_code_rules`.
Requests are never automatically replayed. Pass `--request-id ID` on any
command to resubmit safely: the daemon returns the original outcome, or the
pending one, instead of running it again. Code is read from stdin only with
`--stdin` or `-`; code that starts with `--` (a Luau comment) goes after `--`
or in `--code=...`.

Useful forms:

```bash
roblox open                         # attach the sole connected Studio
roblox open baseplate               # open Studio's built-in empty baseplate
roblox open ./Game.rbxl
roblox open 123456789 --revision 42
roblox eval --file scripts/check.luau --target server
roblox eval --file scripts/migrate.luau --timeout 300          # Studio-side deadline
roblox eval 'return workspace.Baseplate' --request-id check-1  # resubmitting never re-runs
roblox logs --tail 100 --cursor CURSOR
roblox logs --follow
roblox logs --follow --until GameReady --duration 120
roblox screenshot --focus Workspace.Model --format png --out evidence/shot
roblox test run --file tests/smoke.luau
roblox test play --players 2 --scenario tests/qa.json --out evidence/qa
roblox test play --readiness-attribute GameReady --ready-timeout 180 --keep-open
roblox record --duration 30 --output evidence/walkthrough.mp4
roblox test play --scenario tests/qa.json --record evidence/gameplay.mp4
roblox test play --scenario tests/qa.json --record evidence/gameplay.mp4 --overwrite  # replace it if this run passes
roblox test play --scenario tests/qa.json --record evidence/demo.mp4 --foreground  # full-rate video; activates Studio
roblox test calibrate                     # report the play viewport crop for a running client
roblox test status
roblox test stop
roblox status
roblox status --capture-probe       # also sample engine capture pixels
roblox status --request-id REQUEST_ID
roblox schema
roblox close                      # detach, or close a Studio owned by open
roblox close --instance-id ID     # close one explicitly selected managed Studio
roblox record-studio start --out evidence/long-run.mp4 --crop viewport
roblox record-studio stop         # finalize the running recorder, uncapped
```

Screenshots always become files. `--out DIR` retains `request.json`, compact
`response.json`, `hashes.json`, and recursively extracted binary artifacts.
`roblox status` reports, per instance and role, `transport` liveness
(`connected`, `last_inbound_ms_ago`, `outstanding_requests`,
`oldest_outstanding_ms`, `unresponsive`) and `runtime_health` (render-loop
freshness and the `OpeningReady` workspace attribute, or a requested readiness
attribute). The CaptureService pixel probe runs only with `--capture-probe`.
Status also carries `daemon_build_id` and, when a plugin was refused,
`rejected_connections`. The daemon accepts only the plugin build it shipped
with: `plugin_build_mismatch` means run `roblox setup` and reload plugins in
Studio. `roblox test status` adds `solo_outcome`, the end of the last solo
playtest. `roblox logs` reports `dropped` (entries evicted since your cursor),
per-role `gaps`, and `omitted_by_tail`; each peer buffers 1 MiB.
Failed or suspicious `test play` runs automatically create an evidence
directory containing the response, `evidence.json`, and any last screenshot,
logs, status, and probe result; the directory is reported as
`evidence_directory`.
All screenshot entry points use one backend pipeline. `--backend auto` prefers
native capture for the embedded Mac play client and engine capture for edit
mode; `--backend native|engine` selects explicitly. Receipts identify the
instance, peer, window, backend, viewport, time and failed fallback attempts.
The CLI starts a private Unix-socket capture worker under the invoking
terminal's Screen Recording permission. Native window capture runs only there,
never in the daemon: the detached daemon usually lacks that permission, and
macOS then refuses `screencapture` with "could not create image from window".
The worker accepts only window captures, never input or Luau, and exits after
five idle minutes with no active jobs. Direct HTTP users need an existing
CLI-started worker for native capture. Missing pixels are reported as capture
failures.

`--crop viewport` briefly adds four calibration markers, removes them, and
captures a clean PNG plus the original window. Only a verified marker rectangle
produces an image-to-input mapping; resize invalidates it. Full-window captures
include Studio chrome and imply no coordinate conversion. Native capture binds
the edit window to the Studio process `roblox open` launched, otherwise to the
window whose title is exactly the place name; it rejects ambiguous window
identity and multiplayer targets beyond the visible client.
Gameplay `passed` and `capture_passed` are separate: missing screenshots cannot
turn a completed purchase into a failed purchase.

`test play` reuses a running test when its mode and player count match. A reused
session is left running, including after failed assertions. A mismatch is an
error; it never silently replaces another test. Set `--readiness-attribute NAME`
to wait for your game's actual interactive state. A result labeled
`validation: "startup_only"` proves that peers started, not that the game loaded.

Studio stays in the background. Scenario input is engine-side virtual input,
and screenshots and recording capture the Studio window, so a playtest never
needs Studio in front and never takes the desktop from you: no focus helper
runs, and nothing wakes the display except a recording. A window that is
minimized, or a sleeping display, stops Studio rendering; screenshots then fail
with that reason. The play receipt then warns `Studio is not rendering (display
asleep or window minimized); steps that wait on rendering will stall.` whenever
the run's render samples show it, at the end of the run or as `render_fps`
under 1. A stalled view fails a run only through a step that depended on it: a
wait that timed out (`render_stalled`), a failed screenshot, or, at teardown,
a run with a recording or screenshot step (`playtest_suspicious`). A run of
evaluations that all passed still passes, with the warning.

Behind another app Studio throttles its own rendering to about 15 fps. Steps
and screenshots are unaffected, but a video has about that many distinct frames.
Every `test play` receipt, its `recording` receipt and the `record` receipt
report `render_fps`, the rate the visible view (client-1, else edit) actually
rendered at over the run as counted by the plugin, and add a warning to
`warnings` when it is below 25. `--foreground` (on `test play`, `test resume`
and `record`) is the explicit opt-in for a full-rate video: it brings Studio to
the front once, keeps the display awake for the run, and restores the previous
app afterwards unless you switched apps meanwhile. When macOS refuses the
activation (macOS 14+ does while you are working in another app), the command
fails with `foreground_unavailable` before any playtest starts; click Studio or
rerun without `--foreground`. A resumed job keeps the choice of its original
play unless `--foreground` is passed again.

Scenario mouse steps support `move`, `click`, `mouseDown`, and `mouseUp`.
Keyboard steps default to `tap`; prefer `duration_ms`. Legacy keyboard
`duration` means seconds, while legacy wait `duration` means milliseconds and
emits a warning. `press` and `release` do not accept a duration. Held input is
released during cleanup, including cancellation. `stable_samples` counts polls,
not render frames; `interval_ms` controls the polling interval.

`click_gui` resolves a `PlayerGui` path and rejects disabled, clipped or covered
buttons before real input, then verifies `Activated`. `click_world` accepts a
path relative to `game` or a three-number world position and checks projection,
UI occlusion and the world ray. `interact_prompt` checks range, line of sight,
keyboard ownership and the requested prompt's `Triggered` event; optional
`gui_path` identifies its own custom prompt UI. Declare a read-only `expect`
condition to prove a gameplay effect: input delivery alone cannot prove a sale.

## Durable scenarios

```bash
roblox test validate --scenario tests/qa.json
roblox test play --scenario tests/qa.json --detach
roblox test job --job JOB_ID --follow
roblox test cancel --job JOB_ID
roblox test resume --job JOB_ID --detach
```

`test play` admits a disk-backed job and prints its ID immediately. By default
the CLI follows it with short status reads and owns it: SIGINT, SIGTERM or
SIGHUP (a closed terminal, a killed harness) cancels the job with its full
teardown before the CLI exits with `130`, `143` or `129` and the settled
receipt; a second signal stops waiting for that cancel. An explicit
`--timeout` bounds the followed run the same way: when it passes, the CLI
cancels the job. `roblox test job --job ID --follow` only watches: a signal
stops following and leaves the job alone.

The daemon enforces the same rule for a follower that dies without a chance to
cancel (SIGKILL, a crashed shell): every job is attended unless admitted with
`--detach`, and an attended job is cancelled, with full teardown, once 30 s
pass without a status read (`GET /v2/requests/:id`, which every follower
polls). A session is therefore never left owned by a job nobody follows.
`--detach` returns after admission and runs the job unattended until it ends
or `roblox test cancel`; follow it later with `roblox test job --job ID
--follow`. HTTP `POST /v2/commands/test` with `action: play` always returns
202 (`detach: true` for unattended); `action: result, job_id: ID` retrieves the
final receipt. There is no synchronous play request.

Requests, each completed step, earlier attempt receipts and binary artifacts
are retained under `~/Library/Application Support/roblox-cli/test-jobs/ID/`
(or `ROBLOX_CLI_HOME`). Admission and progress are atomically written. Results
have no old 256 KiB workflow cap and survive daemon restarts. These directories
are owner-managed evidence and are not automatically pruned.

`roblox test cancel` interrupts a running `wait`, `wait_until`, readiness wait
or `--duration` at once, lets an in-flight native action answer (aborting it
would leave its outcome unknown), then runs the normal teardown: the recorder is
finalized, held input released, and the playtest stopped and verified. It
returns once the job has settled, or after 30 s with the current state. A
`--keep-open` or reused playtest stays running, so its job can resume. Cancel
does not roll back game state. Daemon interruption produces `unknown`, never
automatic replay. Resume requires the original live
peer identities and a satisfied scenario `resume_when`. An interrupted mutating
step advances only when its declared `expect` proves completion; otherwise
resume refuses. Read-only steps may be repeated, and interrupted waits retain
their remaining duration when a receipt exists. Each resume is a new attempt
with its own operation IDs. Starting a new job on an owned
session is refused until the earlier job settles or is explicitly cancelled.
Cancelling an interrupted job whose original playtest is gone ends it
(`cleanup_runtime_gone`) instead of leaving the session owned; a cancel that
arrives while a resume is validating stops that resume.

A job always settles once its run returns, whatever happened: a failure after
play started (a recorder that cannot start, a lost transport mid-step) skips
the remaining steps and still takes the teardown, so the job ends `failed`
(with `execution: "unknown"` when a step's effect is uncertain) and releases
the session instead of holding it as `unknown`.

The play receipt separates what the scenario did from how teardown went.
`outcome` (`passed`, `steps_passed`, `steps_total`) is the scenario's own
verdict. `cleanup` reports `runtime` (`stopped`, `kept_open`, `still_running`),
the `stop` attempts, `input_release`, `warnings` and `failures`. Teardown
stops the playtest through the edit DataModel, retries once, then asks the
play server itself to `EndTest`; after each attempt it watches the bridge peer
list, and `runtime: "stopped"` means the server and clients are gone, not that
a stop RPC answered. A stop RPC that timed out while the runtime still went
away is a warning; a runtime left running, held input in a live runtime, or a
requested video that never finalized is a failure. Top-level `passed` is
`outcome.passed`, not `suspicious`, and `cleanup.passed`; `failure.code` is
`playtest_failed`, `playtest_suspicious` or `cleanup_failed` accordingly. A
`playtest_failed` run stopped by a timed-out wait whose cause is known adds
`failure.reason`: `render_stalled` or `host_slept`.

Local validation expands all reusable actions and rejects invalid fields,
units, names and structures before admission. Luau behavior, target availability
and gameplay conditions are checked against the live runtime. Before a job sends
input or starts play, edit-side preflight compiles every declared Luau snippet
and validates keyboard enums. Reusable actions
use typed data substitution, never interpolation into source code:

```json
{
  "actions": {
    "check": {
      "parameters": ["expected"],
      "steps": [{"type":"eval", "target":"client-1",
        "code":"return workspace:GetAttribute('Count') == args.expected",
        "args":{"expected":{"$param":"expected"}}}]
    }
  },
  "steps": [{"type":"use", "name":"first check", "action":"check",
    "args":{"expected":3}}]
}
```

## Native diagnostics

```bash
roblox test diagnose --checks ui,prompts,readiness,counts
roblox test diagnose --checks performance --duration 10
```

Diagnostics report overflowing text, clipped controls, button blockers, nearby
prompt anchors and input styles, readiness, instance counts and mean/p95/max
frame time. A viewport change invalidates a performance sample. UI findings or
a false configured readiness attribute fail the check. Prompt anchors do not
pretend to be the rectangle of arbitrary custom prompt UI. These are measurable
checks, not an automated artistic verdict; inspect the pixels too.

The reproducible desktop fixture pass is `python3 tests/native/acceptance.py
--out PATH --restart-daemon`. It requires an existing live client with a character,
sends real input, temporarily controls the camera, and removes its fixtures in
cleanup. It writes `PATH/report.json` with every check it made and its
evidence, plus each job's result.

Older non-job workflow receipts remain memory-bound (64 operations, 15 minutes,
256 KiB). Generic transport errors are `unknown` and include the original
request/job ID; no mutating command is automatically retried.
`doctor` labels its verdict as connector installation health and separately
reports whether Studio is connected; it does not claim game readiness.

## Recording

On macOS 15+, `record` captures a continuous H.264 MP4 of the Studio window with
application audio and without microphone input. The native helper is compiled
by `npm run build`. Output reports measured duration, dimensions, and audio
track count; capture requests 30 frames per second, and `render_fps` (when the
daemon is attached) says how many of those Studio actually rendered. The output must not already
exist. Screen Recording permission applies to the invoking terminal. A recording failure is reported as a failure, never as a
successful collection of sparse still frames.

`record --duration SECONDS` is a fixed-length capture and is capped at 600
seconds. Use the explicit start/stop form when a workflow should own the length
of its own video:

```bash
roblox record-studio start --out evidence/walkthrough.mp4 [--duration SECONDS] [--crop viewport]
roblox record-studio stop
```

`start` returns as soon as capture has actually begun. Without `--duration` it
records until `stop`, bounded only by a 24-hour runaway cap. `stop` signals the running recorder from
any roblox-cli process and returns the same measured receipt. Both forms bind
the recorder to one window identity before capture starts: with one Studio
window the match is automatic, and with more than one the CLI refuses rather
than recording an arbitrary window.

`roblox test play --scenario FILE --record FILE.mp4` runs a scenario and records
it under one clock. The video starts after the playtest reaches readiness,
before the first step, and is stopped when the scenario completes, so it covers
the moment gameplay began through the end of the scenario. The play receipt adds
a top-level `recording` object (file, measured `duration_seconds`, `width`,
`height`, `audio_tracks`, `stop_reason`, `render_fps`, and the viewport calibration) plus
`timeline`, and writes a `timeline.json` sidecar next to the video. Every
retained step receipt carries `started_at_ms` and `ended_at_ms` offsets measured
from the start of the recording, so a reviewer can seek to the frame in which a
step happened. A recording that cannot start fails the run (its steps are
skipped and the playtest is still stopped), and one that cannot be finalized
fails it on cleanup: a requested video is not optional evidence.

An existing `--record` file is refused with `output_exists` (exit 2) before
any job is admitted. `--overwrite` allows it: the recorder always writes a
fresh sibling (`NAME.recording-XXXXXXXX.mp4`), and only a finalized video of a
passing run replaces the file, in one rename. Otherwise the previous file
survives, the new video keeps its sibling name, and `cleanup.warnings` says
where it is.

`--record` records the play client viewport, not the whole Studio window with
chrome. The four-marker calibration used by `screenshot --crop viewport` is
derived once, before the first step, and applied to every recorded frame; the
calibration receipt is reported beside the video. A capture that trails the
marker frame (a background Studio renders slowly) is retaken up to four
times, and a window or viewport that moves while it is measured (a playtest's
view settles by a pixel just after it starts) is measured again up to three
times. Calibration failure is never silent: the run records the full window
and says so in `recording.calibration.verified == false` with the reason,
which names what changed. `roblox test calibrate` reports the same crop for a
running client without capturing a still.

Recording from inside a playtest job is started by the terminal-owned capture
worker rather than by the daemon. Screen Recording permission belongs to the
responsible application, and the detached daemon has only what its starter had,
often nothing, so a recorder spawned there is refused by ScreenCaptureKit. The
worker already exists for screenshot capture and holds that permission.

A recording of a sleeping display is not a recording: ScreenCaptureKit accepts
the stream and then fails its first sample buffer. The recorder asserts the
display awake (and reports that explicitly when it cannot) rather than returning
a video of nothing.

`roblox status` and `roblox test status` report whether a recording is active,
which file it is writing, and how long it has been running.

Large or sensitive values stay out of stdout only when the caller chooses to
retain them; the daemon itself does not expose a generic proxy or raw command
escape hatch.

## Local state

```text
~/Library/Application Support/roblox-cli/
~/Library/Logs/roblox-cli/          # daemon.log, daemon.error.log
```

`ROBLOX_CLI_HOME`, `ROBLOX_CLI_LOG_DIR`, `ROBLOX_CLI_PORT`,
`ROBLOX_CLI_AUTH_TOKEN`, `ROBLOX_CLI_PLUGINS_DIR`, and
`ROBLOX_CLI_STUDIO_EXE` are the supported overrides. No game project
repository is required at runtime.

## Development

```bash
npm run clean
npm run typecheck
npm test
npm run build
npm run check:package
```

The root lockfile and `studio-plugin/package-lock.json` are authoritative, and
the plugin toolchain is pinned exactly. The generated plugin must come from
`studio-plugin/src`; setup never fetches code dynamically. A full build cleans
generated output first and stamps the plugin with a content build id.
`check:package` verifies that the private runtime package contains the daemon,
native helpers, and generated plugin without development sources, and installs
the shipped plugin into a temporary folder to prove it is well-formed.
`PROVENANCE.json` records historical attribution only.
