import { createHash } from 'node:crypto';
import { CliCommandError } from './cli-errors.js';
export type Json = Record<string, unknown>;
export interface Condition extends Json {
  code: string;
  target?: string;
  timeout_ms?: number;
  stable_samples?: number;
}
export interface Scenario extends Json {
  steps: Json[];
  resume_when?: Condition;
  warnings: string[];
  fingerprint: string;
}
function fail(message: string): never { throw new CliCommandError('invalid_scenario', message); }
const object = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
function keys(v: Json, allowed: string[], where: string) {
  for (const key of Object.keys(v))
    if (!allowed.includes(key))
      fail(`${where}: unknown field ${key}`);
}
function number(v: unknown, name: string, min: number, max: number) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max)
    fail(`${name} must be a number between ${min} and ${max}`);
}
function integer(v: unknown, name: string, min: number, max: number) {
  number(v, name, min, max);
  if (!Number.isInteger(v))
    fail(`${name} must be an integer`);
}
function path(v: unknown, name: string) {
  if (!Array.isArray(v) || !v.length || v.length > 40 || v.some(x => typeof x !== 'string' || !x.length))
    fail(`${name} must be a non-empty array of instance names`);
}
export function condition(v: unknown, name: string): Condition {
  if (!object(v))
    fail(`${name} must be an object`);
  keys(v, ['code', 'target', 'timeout_ms', 'interval_ms', 'stable_samples'], name);
  if (typeof v.code !== 'string' || !v.code.trim())
    fail(`${name}.code is required`);
  if (v.target !== undefined && (typeof v.target !== 'string' || !/^(edit|server|client-[1-9]\d*)$/.test(v.target)))
    fail(`${name}.target is invalid`);
  if (v.timeout_ms !== undefined)
    integer(v.timeout_ms, `${name}.timeout_ms`, 1, 300000);
  if (v.interval_ms !== undefined)
    integer(v.interval_ms, `${name}.interval_ms`, 10, 10000);
  if (v.stable_samples !== undefined)
    integer(v.stable_samples, `${name}.stable_samples`, 1, 600);
  return v as Condition;
}
function substitute(value: unknown, args: Json): unknown {
  if (object(value) && Object.keys(value).length === 1 && typeof value.$param === 'string') {
    if (!Object.hasOwn(args, value.$param))
      fail(`Missing action parameter ${value.$param}`);
    return args[value.$param];
  }
  if (Array.isArray(value))
    return value.map(v => substitute(v, args));
  if (object(value))
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, args)]));
  return value;
}
const fields: Record<string, string[]> = {
  wait: ['duration_ms', 'duration'],
  eval: ['code', 'args', 'interactive'],
  wait_until: ['code', 'args', 'timeout_ms', 'interval_ms', 'stable_samples', 'stable_frames'],
  logs: ['scope', 'tail', 'filter', 'cursor'],
  screenshot: ['format', 'quality', 'backend', 'focus', 'crop'],
  keyboard: ['action', 'key_code', 'text', 'duration', 'duration_ms'],
  mouse: ['action', 'x', 'y', 'button'],
  click_gui: ['path'],
  click_world: ['path', 'position'],
  interact_prompt: ['path', 'gui_path'],
  diagnose: ['checks', 'duration_ms', 'readiness_attribute', 'blockers'],
};
export function compileScenario(raw: unknown): Scenario {
  if (!object(raw))
    fail('scenario must be an object');
  keys(raw, ['description', 'steps', 'actions', 'resume_when', 'version'], 'scenario');
  if (raw.version !== undefined && raw.version !== 1)
    fail('Only scenario version 1 is supported');
  if (raw.description !== undefined && typeof raw.description !== 'string')
    fail('description must be a string');
  if (!Array.isArray(raw.steps))
    fail('scenario.steps must be an array');
  if (raw.actions !== undefined && !object(raw.actions))
    fail('scenario.actions must be an object');
  const actions = (raw.actions ?? {}) as Json;
  for (const [name, action] of Object.entries(actions)) {
    if (!object(action) || !Array.isArray(action.steps) || !Array.isArray(action.parameters) || action.parameters.some(x => typeof x !== 'string'))
      fail(`Invalid action ${name}`);
    keys(action, ['parameters', 'steps'], `action ${name}`);
  }
  const warnings: string[] = [];
  const steps: Json[] = [];
  const expand = (list: unknown[], prefix: string, chain: string[]) => {
    if (chain.length > 16)
      fail('Action nesting exceeds 16');
    for (const [index, value] of list.entries()) {
      if (!object(value))
        fail(`Step ${index} must be an object`);
      const step = { ...value };
      if (step.name !== undefined && (typeof step.name !== 'string' || !step.name.trim()))
        fail('Step name must be non-empty text');
      const name = prefix + (typeof step.name === 'string' ? step.name : `step-${index + 1}`);
      if (step.type === 'use') {
        keys(step, ['type', 'name', 'action', 'args'], name);
        const actionName = String(step.action);
        const action = actions[actionName];
        if (!object(action) || chain.includes(actionName))
          fail(`Unknown or recursive action ${actionName}`);
        const args = step.args ?? {};
        if (!object(args))
          fail(`${name}.args must be an object`);
        const parameters = action.parameters as string[];
        if (Object.keys(args).some(k => !parameters.includes(k)) || parameters.some(k => !Object.hasOwn(args, k)))
          fail(`${name}: action parameters do not match`);
        expand(substitute(action.steps, args) as unknown[], `${name}/`, [...chain, actionName]);
        continue;
      }
      const type = String(step.type);
      if (!Object.hasOwn(fields, type))
        fail(`${name}: unsupported step type ${type}`);
      keys(step, ['type', 'name', 'target', 'expect', ...fields[type]], name);
      if (step.target !== undefined && (typeof step.target !== 'string' || !/^(edit|server|client-[1-9]\d*)$/.test(step.target)))
        fail(`${name}: invalid target`);
      if (['click_gui', 'click_world', 'interact_prompt', 'diagnose', 'keyboard', 'mouse'].includes(type) && step.target !== undefined && !/^client-[1-9]\d*$/.test(String(step.target)))
        fail(`${name}: a play client target is required`);
      if (step.expect !== undefined)
        condition(step.expect, `${name}.expect`);
      if (step.args !== undefined && !object(step.args))
        fail(`${name}.args must be an object`);
      if (type === 'eval' || type === 'wait_until') {
        if (typeof step.code !== 'string' || !step.code.trim())
          fail(`${name}: code is required`);
        if (step.interactive !== undefined && typeof step.interactive !== 'boolean')
          fail(`${name}: interactive must be boolean`);
      }
      if (['click_gui', 'interact_prompt'].includes(type))
        path(step.path, `${name}.path`);
      if (type === 'interact_prompt' && step.gui_path !== undefined)
        path(step.gui_path, `${name}.gui_path`);
      if (type === 'click_world') {
        if ((step.path === undefined) === (step.position === undefined))
          fail(`${name}: choose path or position`);
        if (step.path !== undefined)
          path(step.path, `${name}.path`);
        if (step.position !== undefined && (!Array.isArray(step.position) || step.position.length !== 3 || step.position.some(n => typeof n !== 'number' || !Number.isFinite(n))))
          fail(`${name}: position requires three finite numbers`);
      }
      if (type === 'wait' && step.duration !== undefined) {
        if (step.duration_ms !== undefined)
          fail(`${name}: choose duration_ms, not both duration forms`);
        step.duration_ms = step.duration;
        delete step.duration;
        warnings.push(`${name}: legacy wait.duration means milliseconds; use duration_ms`);
      }
      if (type === 'keyboard') {
        const action = step.action ?? 'tap';
        if (!['tap', 'press', 'release'].includes(String(action)))
          fail(`${name}: invalid keyboard action`);
        if ((typeof step.key_code !== 'string' || !step.key_code) && typeof step.text !== 'string')
          fail(`${name}: key_code or text is required`);
        if (step.text !== undefined && (step.key_code !== undefined || step.action !== undefined || step.duration !== undefined || step.duration_ms !== undefined))
          fail(`${name}: text cannot be combined with key options`);
        if ((step.duration !== undefined || step.duration_ms !== undefined) && action !== 'tap')
          fail(`${name}: duration requires action=tap`);
        if (step.duration !== undefined && step.duration_ms !== undefined)
          fail(`${name}: choose one duration unit`);
        if (step.duration !== undefined) {
          number(step.duration, `${name}.duration seconds`, 0, 60);
          step.duration_ms = (step.duration as number) * 1000;
          delete step.duration;
        }
      }
      if (step.duration_ms !== undefined)
        integer(step.duration_ms, `${name}.duration_ms`, 0, type === 'wait' ? 86400000 : 60000);
      if (type === 'mouse') {
        if (!['move', 'click', 'mouseDown', 'mouseUp'].includes(String(step.action)))
          fail(`${name}: invalid mouse action`);
        number(step.x, `${name}.x`, 0, 20000);
        number(step.y, `${name}.y`, 0, 20000);
        if (step.button !== undefined && !['Left', 'Right', 'Middle'].includes(String(step.button)))
          fail(`${name}: invalid mouse button`);
      }
      if (type === 'wait_until') {
        if (step.stable_frames !== undefined) {
          if (step.stable_samples !== undefined)
            fail(`${name}: choose stable_samples only`);
          step.stable_samples = step.stable_frames;
          delete step.stable_frames;
          warnings.push(`${name}: stable_frames counted polls; use stable_samples`);
        }
        condition(Object.fromEntries(Object.entries(step).filter(([k]) => ['code', 'target', 'timeout_ms', 'interval_ms', 'stable_samples'].includes(k))), name);
      }
      if (type === 'screenshot') {
        if (step.target === 'server')
          fail(`${name}: screenshots need an edit or client target`);
        if (step.focus !== undefined && typeof step.focus !== 'string')
          fail(`${name}.focus must be an instance path`);
        if (step.crop !== undefined && (step.backend === 'engine' || (step.target !== undefined && step.target !== 'client-1')))
          fail(`${name}: viewport crop requires the native visible client`);
        if (step.crop !== undefined && step.crop !== 'viewport')
          fail(`${name}: crop must be viewport`);
        if (step.backend !== undefined && !['auto', 'engine', 'native'].includes(String(step.backend)))
          fail(`${name}: invalid capture backend`);
        if (step.format !== undefined && !['png', 'jpeg'].includes(String(step.format)))
          fail(`${name}: invalid format`);
        if (step.quality !== undefined)
          integer(step.quality, `${name}.quality`, 1, 100);
      }
      if (type === 'logs') {
        for (const field of ['filter', 'cursor'])
          if (step[field] !== undefined && typeof step[field] !== 'string')
            fail(`${name}.${field} must be text`);
        if (step.tail !== undefined)
          integer(step.tail, `${name}.tail`, 0, 10000);
        if (step.scope !== undefined && !['auto', 'instance', 'group'].includes(String(step.scope)))
          fail(`${name}: invalid log scope`);
      }
      if (type === 'diagnose')
        validateDiagnostics(step);
      if (steps.some(s => s.name === name))
        fail(`Duplicate step name ${name}`);
      steps.push({ ...step, name });
      if (steps.length > 10000)
        fail('Expanded scenario exceeds 10000 steps');
    }
  };
  expand(raw.steps, '', []);
  const result = { description: raw.description, steps, ...(raw.resume_when === undefined ? {} : { resume_when: condition(raw.resume_when, 'resume_when') }) };
  return { ...result, warnings, fingerprint: createHash('sha256').update(JSON.stringify(result)).digest('hex') };
}
export function validateDiagnostics(body: Json) {
  const checks = body.checks ?? ['ui', 'readiness', 'counts'];
  if (!Array.isArray(checks) || !checks.length || checks.some(c => !['ui', 'prompts', 'performance', 'readiness', 'counts'].includes(String(c))))
    fail('checks must contain ui, prompts, performance, readiness or counts');
  if (body.readiness_attribute !== undefined && (typeof body.readiness_attribute !== 'string' || !body.readiness_attribute))
    fail('readiness_attribute must be non-empty text');
  if (body.duration_ms !== undefined)
    integer(body.duration_ms, 'diagnostic duration_ms', 100, 60000);
  if (body.blockers !== undefined) {
    if (!Array.isArray(body.blockers))
      fail('blockers must be an array of GUI paths');
    for (const p of body.blockers)
      path(p, 'blocker');
  }
}
export function scenarioNeedsInput(scenario?: {
  steps: Json[];
}): boolean {
  return !!scenario?.steps.some(s => ['keyboard', 'mouse', 'click_gui', 'click_world', 'interact_prompt'].includes(String(s.type)) || (s.type === 'eval' && s.interactive === true));
}
