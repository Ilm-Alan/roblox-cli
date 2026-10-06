/**
 * The agent-facing protocol is deliberately smaller than the daemon's
 * delivery protocol. A caller already knows which command it invoked, and the
 * process exit status already carries the command-level success bit. Normal
 * responses therefore contain only useful command data.
 */
import { CLI_COMMAND_NAMES } from './commands.js';

export const AGENT_PROTOCOL_VERSION = 2 as const;
export const AGENT_ROOT_PATH = `/v${AGENT_PROTOCOL_VERSION}`;
export const AGENT_COMMANDS_PATH = `${AGENT_ROOT_PATH}/commands`;
export const AGENT_COMMAND_PREFIX = AGENT_COMMANDS_PATH;
export const AGENT_SCHEMA_PATH = `${AGENT_ROOT_PATH}/schema`;
export const AGENT_HEALTH_PATH = `${AGENT_ROOT_PATH}/health`;
export const AGENT_STATUS_PATH = `${AGENT_ROOT_PATH}/status`;
export const AGENT_REQUESTS_PREFIX = `${AGENT_ROOT_PATH}/requests`;
export const AGENT_DAEMON_STOP_PATH = `${AGENT_ROOT_PATH}/daemon/stop`;
export const AGENT_PROTOCOL_HEADER = 'X-Roblox-Agent-Protocol';
export const REQUEST_ID_HEADER = 'X-Request-ID';

export const AGENT_COMMAND_NAMES = CLI_COMMAND_NAMES;

/** Every `roblox test` mode the CLI parser accepts. */
export const CLI_TEST_MODES = ['run', 'play', 'status', 'stop', 'validate', 'job', 'cancel', 'resume', 'diagnose', 'calibrate'] as const;

/** Error codes that exit 2: the caller must fix its request. */
export const USAGE_ERROR_CODES = [
  'usage_error', 'invalid_argument', 'invalid_scenario', 'invalid_json', 'invalid_request_id',
  'invalid_capture_backend', 'invalid_crop', 'test_mode_required',
  'request_too_large', 'artifact_failed', 'output_exists', 'unknown_agent_route', 'multiple_sessions',
] as const;

/** Error codes that exit 3: something the command needs was unavailable before execution. */
export const AVAILABILITY_ERROR_CODES = [
  'daemon_unavailable', 'auth_unavailable', 'unauthorized', 'protocol_unavailable', 'protocol_mismatch',
  'session_required', 'session_disconnected', 'studio_not_connected', 'plugin_build_mismatch',
  'target_role_not_present', 'foreground_unavailable', 'recording_unavailable', 'workflow_capacity',
  'local_command_failed', 'request_disconnected', 'request_timeout',
] as const;

type JsonObject = Record<string, unknown>;

const EXECUTION_TIMEOUT_MS = {
  type: 'integer', minimum: 1000, maximum: 3600000, default: 30000,
  description: 'Studio execution deadline. When it passes the plugin stops waiting and the command fails with execution "unknown"; Luau that already started may still be running.',
};

const DROPPED_LOGS = {
  dropped: { type: 'integer', minimum: 0, description: 'Entries evicted from Studio log buffers after your cursor and before this read: a gap in the stream.' },
  omitted_by_tail: { type: 'integer', minimum: 0, description: 'Matching entries skipped because of tail.' },
  gaps: {
    type: 'array',
    description: 'Per-peer breakdown of dropped entries.',
    items: {
      type: 'object',
      required: ['role', 'instance_id', 'dropped'],
      properties: { role: { type: 'string' }, instance_id: { type: 'string' }, dropped: { type: 'integer', minimum: 1 } },
    },
  },
};

const COMMAND_SPECS: Record<(typeof AGENT_COMMAND_NAMES)[number], JsonObject> = {
  open: {
    description: 'Attach to or launch a Roblox Studio session.',
    method: 'POST',
    endpoint: `${AGENT_COMMAND_PREFIX}/open`,
    idempotency: 'attach is idempotent; launching is not automatically retried',
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['open', 'status', 'close'], default: 'open' },
        source: { type: 'string', enum: ['attach', 'baseplate', 'file', 'place', 'revision'], default: 'attach' },
        path: { type: 'string' },
        place_id: { type: 'integer', minimum: 1 },
        revision: { type: 'integer', minimum: 1 },
        instance_id: { type: 'string' },
        session_id: { type: 'string' },
        timeout_ms: { type: 'integer', minimum: 1, maximum: 300000 },
      },
    },
    forms: {
      attach: 'roblox open',
      baseplate: 'roblox open baseplate',
      file: 'roblox open PATH',
      place: 'roblox open PLACE_ID',
      revision: 'roblox open PLACE_ID --revision VERSION',
    },
    response: {
      type: 'object',
      required: ['session'],
      properties: {
        session: { $ref: '#/$defs/session' },
        launch: { type: 'object' },
        idempotent: { type: 'boolean' },
        reattached: { type: 'boolean', description: 'attach replaced a disconnected session with the only connected edit Studio.' },
      },
    },
    errors: ['session_required', 'multiple_sessions', 'instance_not_found', 'open_failed', 'studio_not_connected'],
  },
  eval: {
    description: 'Execute arbitrary Luau against the edit DataModel or a running server/client.',
    method: 'POST',
    endpoint: `${AGENT_COMMAND_PREFIX}/eval`,
    idempotency: 'never automatically retry; arbitrary Luau may mutate Studio',
    request: {
      type: 'object',
      additionalProperties: false,
      required: ['code'],
      properties: {
        code: { type: 'string' },
        source: { type: 'string', enum: ['argument', 'file', 'stdin'] },
        target: { type: 'string', pattern: '^(edit|server|client-[1-9][0-9]*)$', default: 'edit' },
        instance_id: { type: 'string' },
        session_id: { type: 'string' },
        timeout_ms: EXECUTION_TIMEOUT_MS,
      },
    },
    response: {
      type: 'object',
      required: ['target', 'duration_ms'],
      description: 'No returned value: neither result nor results. One value: result and result_type. Several values (including trailing nils): results and result_types, without result.',
      properties: {
        target: { type: 'string' },
        duration_ms: { type: 'integer', minimum: 0 },
        result: { $ref: '#/$defs/luau_value' },
        result_type: { type: 'string', description: 'Luau typeof of result.' },
        results: { type: 'array', items: { $ref: '#/$defs/luau_value' }, minItems: 2 },
        result_types: { type: 'array', items: { type: 'string' }, minItems: 2 },
        output: { type: 'array', items: { type: 'string' }, minItems: 1 },
      },
    },
    errors: ['session_required', 'session_disconnected', 'evaluation_failed', 'target_role_required', 'multiple_instances_connected'],
  },
  logs: {
    description: 'Read runtime logs with a resumable cursor.',
    method: 'POST',
    endpoint: `${AGENT_COMMAND_PREFIX}/logs`,
    idempotency: 'safe to repeat; advance the returned cursor only after consuming the batch',
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['auto', 'instance', 'group'], default: 'auto' },
        cursor: { type: 'string' },
        cursor_by_instance: { type: 'object', additionalProperties: { type: 'string' } },
        tail: { type: 'integer', minimum: 0, maximum: 10000, default: 100 },
        filter: { type: 'string' },
        instance_id: { type: 'string' },
        session_id: { type: 'string' },
      },
    },
    response: {
      oneOf: [
        {
          type: 'object',
          required: ['scope', 'instance_id', 'entries', 'next_cursor'],
          properties: {
            scope: { const: 'instance' },
            instance_id: { type: 'string' },
            entries: { type: 'array', items: { type: 'object' } },
            next_cursor: { type: 'string' },
            peer_errors: { type: 'array', items: { type: 'object' } },
            ...DROPPED_LOGS,
          },
        },
        {
          type: 'object',
          required: ['scope', 'instances'],
          properties: {
            scope: { const: 'group' },
            multiplayer_group_id: { type: 'string' },
            instances: { type: 'array', items: { type: 'object' } },
            next_cursor_by_instance: { type: 'object', additionalProperties: { type: 'string' } },
            ...DROPPED_LOGS,
          },
        },
      ],
    },
    stream: {
      format: 'ndjson',
      rule: 'With --follow, emit only non-empty batches; the cursor is advanced internally and a batch replaces the cursor kind it carries. --duration SECONDS bounds the follow; --until REGEX stops after a batch with an entry message matching REGEX (exit 1 if --duration elapses first). The stream always ends with {"done":true,"reason":"duration"|"until"|"interrupted"} plus next_cursor or next_cursor_by_instance for resuming; SIGINT exits 130 after that line.',
    },
    errors: ['session_required', 'session_disconnected', 'invalid_argument', 'target_role_required'],
  },
  screenshot: {
    description: 'Capture the current Studio or playtest viewport.',
    method: 'POST',
    endpoint: `${AGENT_COMMAND_PREFIX}/screenshot`,
    idempotency: 'safe to repeat; each call captures a new frame',
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target: { type: 'string', pattern: '^(edit|client-[1-9][0-9]*)$' },
        focus: { type: 'string' },
        backend: { type: 'string', enum: ['auto', 'engine', 'native'], default: 'auto' },
        crop: { type: 'string', enum: ['viewport'], description: 'Opt-in marker-calibrated native viewport PNG; includes original window image.' },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        instance_id: { type: 'string' },
        session_id: { type: 'string' },
      },
    },
    response: {
      type: 'object',
      required: ['width', 'height', 'format'],
      properties: {
        width: { type: 'integer', minimum: 1 },
        height: { type: 'integer', minimum: 1 },
        format: { type: 'string', enum: ['png', 'jpeg'] },
        quality: { type: 'integer', minimum: 1, maximum: 100 },
        image: {
          type: 'object',
          description: 'HTTP callers receive base64 image data; the CLI replaces this with file metadata.',
          required: ['data', 'mime_type'],
          properties: { data: { type: 'string' }, mime_type: { type: 'string' } },
        },
        file: { type: 'string' },
        mime_type: { type: 'string' },
        bytes: { type: 'integer', minimum: 0 },
        sha256: { type: 'string' },
        capture_attempts: { type: 'integer', minimum: 1 },
      },
    },
    errors: ['session_required', 'session_disconnected', 'screenshot_failed', 'target_role_required'],
  },
  test: {
    description: 'Run Luau assertions or deterministic solo/multiplayer playtest scenarios.',
    method: 'POST',
    endpoint: `${AGENT_COMMAND_PREFIX}/test`,
    idempotency: 'run and play are not automatically retried; status is safe to repeat',
    request: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['run', 'play', 'status', 'stop', 'cancel', 'resume', 'result', 'validate', 'diagnose', 'calibrate'] },
        code: { type: 'string' },
        source: { type: 'string', enum: ['argument', 'file', 'stdin'] },
        target: { type: 'string', pattern: '^(edit|server|client-[1-9][0-9]*)$' },
        mode: { type: 'string', enum: ['play', 'run'] },
        players: { type: 'integer', minimum: 1, maximum: 8 },
        duration_ms: { type: 'integer', minimum: 0, maximum: 86400000 },
        scenario: {
          type: 'object',
          description: 'Strictly preflighted named steps and reusable parameterized actions. Native inputs support GUI, world and prompt targeting. Declare expect to prove gameplay effects and resume_when to allow conservative recovery.',
          properties: {
            version: { type: 'integer', enum: [1] },
            description: { type: 'string' },
            actions: { type: 'object', description: 'Named {parameters: string[], steps: object[]} actions; typed substitutions use {$param: name}.' },
            resume_when: { type: 'object', description: 'Read-only condition required before resume; the original runtime identity must also match.' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['wait', 'eval', 'wait_until', 'logs', 'screenshot', 'keyboard', 'mouse', 'click_gui', 'click_world', 'interact_prompt', 'diagnose', 'use'] },
                  target: { type: 'string', pattern: '^(edit|server|client-[1-9][0-9]*)$' },
                  code: { type: 'string' },
                  name: { type: 'string' },
                  args: { type: 'object' },
                  expect: { type: 'object', description: 'Read-only Luau condition with target, timeout_ms, interval_ms, stable_samples.' },
                  position: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                  gui_path: { type: 'array', items: { type: 'string' } },
                  checks: { type: 'array', items: { type: 'string' } },
                  backend: { type: 'string', enum: ['auto', 'engine', 'native'] },
                  crop: { type: 'string', enum: ['viewport'] },
                  duration_ms: { type: 'number', minimum: 0 },
                  interval_ms: { type: 'integer', minimum: 10, maximum: 10000 },
                  stable_samples: { type: 'integer', minimum: 1, maximum: 600 },
                  path: { type: 'array', items: { type: 'string' }, description: 'click_gui: child names relative to PlayerGui; native targeting converts the core UI origin and device cutouts to screen pixels and verifies Activated.' },
                  key_code: { type: 'string' },
                  action: { type: 'string' },
                  duration: { type: 'number', minimum: 0, description: 'Seconds for a keyboard tap, never for press/release.' },
                  timeout_ms: { type: 'integer', minimum: 1, maximum: 300000 },
                  stable_frames: { type: 'integer', minimum: 1, maximum: 600, default: 1 },
                },
                required: ['type'],
              },
            },
          },
        },
        readiness_attribute: { type: 'string' },
        timeout_ms: { ...EXECUTION_TIMEOUT_MS, description: `run: ${EXECUTION_TIMEOUT_MS.description}` },
        timeout: { type: 'integer', minimum: 1, maximum: 300, default: 60, description: 'play: seconds allowed for playtest start, stop and the readiness wait.' },
        record: { type: 'string', description: 'Absolute path for one continuous MP4 of the play client viewport, started with the playtest and stopped when the scenario ends. Pair with --scenario. An existing file is refused with output_exists before any job starts unless overwrite is true. Calibration failure falls back to a full-window recording and is reported explicitly; a timeline.json sidecar is written next to the video.' },
        overwrite: { type: 'boolean', default: false, description: 'play with record: replace an existing record file. The new video is moved into place in one rename only after it finalized and the run passed; otherwise the old file survives and the new video stays beside it.' },
        keep_open: { type: 'boolean' },
        test_args: { type: 'object' },
        detach: { type: 'boolean', default: false, description: 'play/resume: run unattended. An attended job (the default) is cancelled, with full teardown, when nobody has read its status (GET /v2/requests/:id) for 30 s.' },
        foreground: { type: 'boolean', default: false, description: 'Opt in to bringing Studio to the front for a full-frame-rate capture. Studio otherwise stays in the background, where input, screenshots and recording all work but Studio renders at about 15 fps. Fails before play with foreground_unavailable when macOS refuses the activation.' },
        job_id: { type: 'string' },
        checks: { type: 'array', items: { type: 'string', enum: ['ui', 'prompts', 'performance', 'readiness', 'counts'] } },
        blockers: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
        instance_id: { type: 'string' },
        session_id: { type: 'string' },
      },
    },
    forms: {
      run: 'roblox test run CODE [--timeout SECONDS]',
      play: 'roblox test play --duration SEC | --scenario FILE [--record FILE.mp4 [--overwrite]] [--foreground] | --keep-open [--ready-timeout SECONDS] [--detach]',
      status: 'roblox test status',
      stop: 'roblox test stop',
      validate: 'roblox test validate --scenario FILE',
      job: 'roblox test job --job ID [--follow]',
      cancel: 'roblox test cancel --job ID — interrupts waits at once, lets an in-flight action answer, then stops the recorder and the playtest; returns once the job settles (bounded at 30 s).',
      resume: 'roblox test resume --job ID [--detach]',
      diagnose: 'roblox test diagnose --checks ui,prompts,performance --duration 10',
      calibrate: 'roblox test calibrate',
    },
    response: {
      type: 'object',
      description: 'play returns HTTP 202 with job_id, state and progress; GET /v2/requests/:id reconnects and renews an attended job\'s lease. result returns the durable complete receipt: passed is the overall verdict, outcome is what the scenario did, cleanup is how teardown went. Gameplay passed and capture_passed are independent.',
      properties: {
        passed: { type: 'boolean', description: 'play: outcome.passed, not suspicious, and cleanup.passed.' },
        outcome: {
          type: 'object',
          description: 'play: the scenario verdict (startup, readiness, recording start, every step, duration), independent of teardown.',
          properties: { passed: { type: 'boolean' }, steps_passed: { type: 'integer' }, steps_total: { type: 'integer' }, error: { type: 'object' } },
        },
        cleanup: {
          type: 'object',
          description: 'play: teardown. runtime is stopped only when the bridge peer list shows the server and clients gone; a stop request that failed while the runtime still went away is a warning, a runtime left running is a failure.',
          properties: {
            passed: { type: 'boolean' },
            runtime: { type: 'string', enum: ['stopped', 'kept_open', 'still_running', 'unverified'] },
            stop: { type: 'object', properties: { confirmed: { type: 'boolean' }, attempts: { type: 'array' }, remaining: { type: 'array', items: { type: 'string' } } } },
            input_release: { type: 'object' },
            warnings: { type: 'array', items: { type: 'string' } },
            failures: { type: 'array', items: { type: 'string' } },
            deadlines: { type: 'array' },
          },
        },
        capture_passed: { type: 'boolean' },
        capture_requested: { type: 'boolean' },
        job_id: { type: 'string' },
        state: { type: 'string', enum: ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'unknown'] },
        next_step: { type: 'integer' },
        total_steps: { type: 'integer' },
        in_flight: { type: 'object' },
        mode: { type: 'string' },
        result: {},
        failure: { type: 'object' },
        suspicious: { type: 'boolean' },
        render_fps: { type: 'number', description: 'play: frames per second the visible Studio view (client-1, else edit) actually rendered during the run, measured by the plugin. Also on the recording receipt.' },
        warnings: { type: 'array', items: { type: 'string' }, description: 'play: scenario warnings, plus a warning when render_fps is below 25 (Studio throttles a window that is not frontmost; pass --foreground for a full-rate video).' },
        evidence_directory: { type: 'string' },
        runtime_health: { type: 'object' },
        solo_outcome: {
          type: 'object',
          description: 'status: the edit Studio report of the last solo playtest start.',
          properties: {
            phase: { type: 'string' }, mode: { type: 'string' }, ok: { type: 'boolean' }, result: {}, error: {},
            started_at: {}, completed_at: {},
          },
        },
        evidence: {
          type: 'object',
          description: 'Failure/suspicion evidence captured before playtest teardown.',
          properties: {
            screenshot: { type: 'object' },
            logs: {},
            status: {},
            probe: {},
          },
        },
      },
    },
    errors: ['test_mode_required', 'playtest_failed', 'playtest_suspicious', 'cleanup_failed', 'assertion_failed', 'output_exists', 'job_conflict', 'session_required', 'session_disconnected'],
  },
};

/**
 * Return a fresh manifest so callers cannot mutate the shared command specs.
 * The manifest is intentionally requestable rather than repeated in every
 * command response.
 */
export function agentSchema(allowedCommands?: Iterable<string>): JsonObject {
  const allowed = allowedCommands === undefined
    ? new Set<string>(AGENT_COMMAND_NAMES)
    : new Set(allowedCommands);
  const commands = Object.fromEntries(
    AGENT_COMMAND_NAMES
      .filter((name) => allowed.has(name))
      .map((name) => [name, structuredClone(COMMAND_SPECS[name])]),
  );
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:roblox-cli-agent:v2',
    manifest_version: 1,
    $defs: {
      session: {
        type: 'object',
        required: ['session_id', 'instance_id', 'ownership', 'source', 'opened_at', 'connected', 'roles'],
        properties: {
          session_id: { type: 'string' },
          instance_id: { type: 'string' },
          ownership: { type: 'string', enum: ['attached', 'managed'] },
          source: { type: 'string' },
          place_id: { type: 'integer', minimum: 1 },
          place_name: { type: 'string' },
          multiplayer_group_id: { type: 'string' },
          opened_at: { type: 'string', format: 'date-time' },
          connected: { type: 'boolean' },
          roles: { type: 'array', items: { type: 'string' } },
        },
      },
      luau_value: {
        description: 'JSON encoding of one Luau value. nil is null; booleans, strings and finite numbers are plain JSON; a table with keys 1..n (or empty) is an array; a table with only string keys is an object; every other value is an object tagged by "$type" (see tagged).',
        oneOf: [
          { type: 'null' }, { type: 'boolean' }, { type: 'string' }, { type: 'number' },
          { type: 'array', items: { $ref: '#/$defs/luau_value' } },
          { type: 'object', description: 'A string-keyed table, or a "$type"-tagged value.' },
        ],
        tagged: {
          number: '{"$type":"number","value":"nan"|"inf"|"-inf"}',
          table: '{"$type":"table","entries":[[key,value],...]} for mixed or non-string keys',
          cycle: '{"$type":"cycle"} where a table contains itself',
          truncated: '{"$type":"truncated","reason":"depth"|"size"}: nesting deeper than 10, or more than 2000 encoded nodes',
          Instance: '{"$type":"Instance","class","name","path"} with path from GetFullName()',
          Vector3: '{"$type":"Vector3","x","y","z"}',
          Vector2: '{"$type":"Vector2","x","y"}',
          CFrame: '{"$type":"CFrame","position":[x,y,z],"components":[12 numbers]}',
          Color3: '{"$type":"Color3","r","g","b","hex"}',
          UDim: '{"$type":"UDim","scale","offset"}',
          UDim2: '{"$type":"UDim2","x":{"scale","offset"},"y":{"scale","offset"}}',
          EnumItem: '{"$type":"EnumItem","enum","name","value"}',
          BrickColor: '{"$type":"BrickColor","name","number"}',
          other: '{"$type":typeof(value),"tostring":tostring(value)}',
        },
      },
      error: {
        type: 'object',
        required: ['code', 'message'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          execution: { type: 'string', enum: ['not_started', 'unknown', 'failed', 'success'] },
          retry: { type: 'string', enum: ['after_fix', 'never'] },
          request_id: { type: 'string' },
          next: { type: 'string' },
          details: { type: 'object' },
        },
      },
    },
    protocol: {
      name: 'roblox-cli-agent',
      version: AGENT_PROTOCOL_VERSION,
      root: AGENT_ROOT_PATH,
      command_endpoint: `${AGENT_COMMAND_PREFIX}/{command}`,
      schema_endpoint: AGENT_SCHEMA_PATH,
      status_endpoint: AGENT_STATUS_PATH,
      health_endpoint: AGENT_HEALTH_PATH,
      daemon_stop_endpoint: AGENT_DAEMON_STOP_PATH,
    },
    transport: {
      command_method: 'POST',
      content_type: 'application/json',
      stdin: 'read only for eval/test run code given as --stdin or a positional "-"',
      stdout: 'one JSON value per command; logs --follow uses newline-delimited JSON',
      stderr: 'diagnostics only; never parse stderr as command data',
      exit_status: 'authoritative command status; see exit_codes',
      response_headers: {
        [AGENT_PROTOCOL_HEADER]: 'protocol version',
        [REQUEST_ID_HEADER]: 'request correlation and recovery identifier',
      },
    },
    success: 'The JSON body is the command payload itself. There is no response envelope.',
    failure: {
      shape: '{ error: { code, message [, execution, retry, next, details] } }',
      execution: {
        not_started: 'The operation did not reach Studio and is safe to reconsider after fixing the cause.',
        unknown: 'The operation may have executed; do not replay mutations automatically.',
        failed: 'Studio received the operation and it completed with a command-level failure.',
        success: 'Studio reported the operation as completed; do not replay it.',
      },
    },
    status: {
      method: 'GET',
      endpoint: AGENT_STATUS_PATH,
      query: {
        capture_probe: { type: 'string', enum: ['1'], description: 'Run the runtime-health capture probe on runtime peers (roblox status --capture-probe). Omitted by default because it samples rendered frames.' },
      },
      response: {
        type: 'object',
        required: ['connected', 'connector_active', 'instances'],
        properties: {
          connected: { type: 'boolean' },
          connector_active: { type: 'boolean' },
          server_version: { type: 'string' },
          daemon_build_id: { type: ['string', 'null'], description: 'Build id of the plugin bundled with this daemon; a Studio plugin with another build id is rejected. null when unknown.' },
          uptime_ms: { type: 'integer', minimum: 0 },
          pending_requests: { type: 'integer', minimum: 0 },
          instances: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                runtime_health: {
                  type: 'object',
                  description: 'Per-peer render, CaptureService, and readiness diagnostics when runtime peers are connected; capture probe results only with capture_probe=1.',
                },
                transport: {
                  type: 'object',
                  description: 'Per-role Studio connection liveness. unresponsive: requests are outstanding and nothing arrived from Studio for over 15 s.',
                  additionalProperties: {
                    type: 'object',
                    properties: {
                      connected: { type: 'boolean' },
                      last_inbound_ms_ago: { type: 'integer', minimum: 0 },
                      outstanding_requests: { type: 'integer', minimum: 0 },
                      oldest_outstanding_ms: { type: 'integer', minimum: 0 },
                      unresponsive: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
          session: { type: 'object' },
          rejected_connections: {
            type: 'array',
            description: 'Present only when non-empty: the most recent (up to 32) Studio connections the daemon refused, e.g. plugin_build_mismatch.',
            items: {
              type: 'object',
              properties: {
                at: { type: 'string', format: 'date-time' }, error: { type: 'string' }, role: { type: 'string' },
                instance_id: { type: 'string' }, place_name: { type: 'string' }, plugin_version: { type: 'string' },
                plugin_build_id: { type: 'string' }, server_version: { type: 'string' }, daemon_build_id: { type: 'string' },
              },
            },
          },
        },
      },
    },
    request_status: {
      method: 'GET',
      execution: ['pending', 'not_started', 'unknown', 'success', 'failed', 'stopped'],
      endpoint: `${AGENT_REQUESTS_PREFIX}/{request_id}`,
      not_found: 'HTTP 404 { error: { code: "unknown_request", execution: "unknown", retry: "never" } }: the id is unknown or expired, so its outcome cannot be recovered.',
      response: {
        oneOf: [
          {
            type: 'object', required: ['job_id', 'state', 'phase', 'execution', 'next_step', 'total_steps'],
            properties: {
              job_id: { type: 'string' },
              state: { type: 'string', enum: ['queued', 'running', 'cancelling', 'cancelled', 'completed', 'failed', 'unknown'] },
              phase: { type: 'string' }, execution: { type: 'string' },
              next_step: { type: 'integer' }, total_steps: { type: 'integer' },
              completed_steps: { type: 'array' }, in_flight: { type: 'object' },
              directory: { type: 'string' }, result_file: { type: 'string' },
            },
          },
          {
            type: 'object',
            required: ['state', 'stage', 'execution'],
            description: 'A settled eval operation carries the live eval payload (result/result_type or results/result_types).',
            properties: {
              state: { type: 'string' },
              stage: { type: 'string' },
              execution: { type: 'string' },
              result: {},
              error: {},
              result_unavailable: { type: 'object' },
            },
          },
        ],
      },
    },
    exit_codes: {
      '0': 'completed successfully',
      '1': 'the operation or assertion failed, or any error not classified below',
      '2': 'invalid usage: the request must be fixed (see exit_code_rules.usage_codes)',
      '3': 'something required was unavailable before execution: daemon, authentication, protocol, session, Studio, plugin build, target role, foreground or recording (see exit_code_rules.availability_codes)',
      '4': 'outcome unknown (error.execution is "unknown"); inspect the request status before retrying',
      '130': 'interrupted',
    },
    exit_code_rules: {
      precedence: 'error.execution "unknown" exits 4; otherwise error.code in usage_codes exits 2, in availability_codes exits 3, and any other error exits 1.',
      usage_codes: [...USAGE_ERROR_CODES],
      availability_codes: [...AVAILABILITY_ERROR_CODES],
    },
    state: {
      session: 'The daemon owns one persistent session. Session identity is implicit for eval, logs, screenshot, and test.',
      recovery: `Use roblox test job --job ID --follow for admitted jobs. Use roblox status --request-id ID or GET ${AGENT_REQUESTS_PREFIX}/{request_id} to inspect an unknown command outcome without replay. Commands accept --request-id ID (header ${REQUEST_ID_HEADER}); resending the same command with the same ID returns the original outcome instead of executing it again.`,
    },
    commands,
    local_commands: {
      record: { form: "roblox record --duration SECONDS --output FILE.mp4 [--foreground]", description: "macOS 15+: continuous Studio window video and application audio; microphone excluded. Existing files are never overwritten. The fixed form is capped at 600 seconds. Studio stays in the background unless --foreground; the receipt reports render_fps when the daemon can measure it." },
      record_studio: { form: "roblox record-studio start --out FILE.mp4 [--duration SECONDS] | roblox record-studio stop", description: "Uncapped start/stop recording of one Studio window bound by window identity. The CLI signals the running helper; --duration is only an optional safety cap. Calibrate the play viewport first with roblox screenshot --target client-1 --crop viewport." },
      close: 'roblox close — detach from the session, or close a Studio process owned by roblox open.',
      status: 'roblox status [--capture-probe] | roblox status --request-id ID — return a compact connected-instance and active-session summary (--capture-probe also samples rendered frames), or recover the outcome of one request.',
      setup: 'roblox setup — install the generated, version-matched Studio plugin. Nothing is started at login.',
      daemon: 'roblox daemon start|stop|restart|status|run — start the persistent daemon in the background, stop it, or run it in the foreground. Studio connects to it; nothing starts it implicitly.',
      doctor: 'roblox doctor — diagnose local build, daemon, and connector health.',
      version: 'roblox version — return package, Node, and agent protocol versions.',
      schema: 'roblox schema — print this manifest without contacting the daemon.',
    },
  };
}
