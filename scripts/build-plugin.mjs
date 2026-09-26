#!/usr/bin/env node

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from 'fs';
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join, basename, relative, sep } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const { version: VERSION } = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
const pluginDir = join(rootDir, 'studio-plugin');
const outDir = join(pluginDir, 'out');
const serverDir = join(outDir, 'server');
const modulesDir = join(outDir, 'modules');
// rbxtsc treats this scoped package as a library and never copies its runtime,
// so pack RuntimeLib and Promise straight from the pinned compiler package.
const includeDir = join(pluginDir, 'node_modules', 'roblox-ts', 'include');
const nodeModulesRbxtsDir = join(pluginDir, 'node_modules', '@rbxts');

// One owned plugin artifact. Diagnostics are a CLI workflow now, so a second
// Studio plugin variant only creates duplicate transports and ambiguity.
const VARIANTS = {
  main: {
    scriptName: 'RobloxCliStudio',
    outputName: 'RobloxCliStudio.rbxmx',
    toolbarName: 'Roblox CLI',
    buttonTitle: 'Roblox CLI',
    buttonTooltip: 'Roblox CLI status',
    buttonIconDisconnected: '75876056391496',  // red
    buttonIconConnecting: '71302583919560',    // yellow
    buttonIconConnected: '130958234173611',    // green
  },
};

const variantArgIdx = process.argv.indexOf('--variant');
const variantName = variantArgIdx !== -1 ? process.argv[variantArgIdx + 1] : 'main';
const variant = VARIANTS[variantName];
if (!variant) {
  console.error(`Unknown variant "${variantName}". Only the main Roblox CLI plugin is supported.`);
  process.exit(1);
}

const outputPath = join(pluginDir, variant.outputName);

function escapeCdata(source) {
  return source.replace(/\]\]>/g, ']]]]><![CDATA[>');
}

function injectVersion(source) {
  return source
    .replace(/__VERSION__/g, VERSION)
    .replace(/__BUILD_ID__/g, BUILD_ID)
    .replace(/__PLUGIN_VARIANT__/g, variantName)
    .replace(/__TOOLBAR_NAME__/g, variant.toolbarName)
    .replace(/__BUTTON_TITLE__/g, variant.buttonTitle)
    .replace(/__BUTTON_TOOLTIP__/g, variant.buttonTooltip)
    .replace(/__BUTTON_ICON_DISCONNECTED__/g, variant.buttonIconDisconnected)
    .replace(/__BUTTON_ICON_CONNECTING__/g, variant.buttonIconConnecting)
    .replace(/__BUTTON_ICON_CONNECTED__/g, variant.buttonIconConnected);
}

const serverInitPath = join(serverDir, 'init.server.luau');
if (!existsSync(serverInitPath)) {
  console.error(`Server script not found at ${serverInitPath}`);
  console.error('Run "cd studio-plugin && npm run build" first to compile TypeScript.');
  process.exit(1);
}

function luaFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) return luaFiles(fullPath);
    return entry.isFile() && isLuaFile(entry.name) ? [fullPath] : [];
  });
}

// The build id names the exact plugin code: a hash of every bundled Lua source
// before placeholder injection, so the daemon can refuse any other plugin build.
const BUILD_ID = (() => {
  const paths = [outDir, includeDir, nodeModulesRbxtsDir]
    .flatMap(luaFiles)
    .map((path) => relative(pluginDir, path).split(sep).join('/'))
    .sort();
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(`${path}\0`).update(readFileSync(join(pluginDir, path))).update('\0');
  }
  return hash.digest('hex').slice(0, 16);
})();

// rbxtsc emits `_G[script]` for the runtime handle in every compiled module.
// The ordinary rbxtsc loader supplies that handle, but this build produces a
// self-contained .rbxmx directly. Bootstrap the root Script explicitly; its
// TS.import calls then register the same runtime for every child module.
// Without exactly one bootstrap line the plugin would fail to load in Studio.
const RUNTIME_BOOTSTRAP = /^local TS = _G\[script\]/gm;
const serverInitSource = readFileSync(serverInitPath, 'utf8');
const bootstrapCount = serverInitSource.match(RUNTIME_BOOTSTRAP)?.length ?? 0;
if (bootstrapCount !== 1) {
  console.error(`Expected exactly one RuntimeLib bootstrap (local TS = _G[script]) in ${serverInitPath}; found ${bootstrapCount}.`);
  process.exit(1);
}
if (!existsSync(join(includeDir, 'RuntimeLib.lua'))) {
  console.error(`Missing ${join(includeDir, 'RuntimeLib.lua')}; run npm --prefix studio-plugin ci.`);
  process.exit(1);
}
const mainSource = injectVersion(serverInitSource).replace(
  RUNTIME_BOOTSTRAP,
  'local TS = require(script.include.RuntimeLib)',
);

let refId = 1;

function findInitFile(dir) {
  for (const name of ['init.luau', 'init.lua']) {
    const p = join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

const INIT_FILENAMES = new Set(['init.luau', 'init.lua', 'init.server.luau', 'init.server.lua']);

function isLuaFile(name) {
  return name.endsWith('.luau') || name.endsWith('.lua');
}

function dirHasLuaContent(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && isLuaFile(entry.name)) return true;
    if (entry.isDirectory() && dirHasLuaContent(join(dir, entry.name))) return true;
  }
  return false;
}

function buildModuleItems(dir, depth = 0) {
  if (!existsSync(dir)) return '';

  let items = '';
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!dirHasLuaContent(fullPath)) continue;

      const initFile = findInitFile(fullPath);
      refId++;
      const currentRef = refId;

      if (initFile) {
        const moduleSource = injectVersion(readFileSync(initFile, 'utf8'));
        const childItems = buildModuleItems(fullPath, depth + 1);
        items += `
      ${'  '.repeat(depth)}<Item class="ModuleScript" referent="${currentRef}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${entry.name}</string>
      ${'  '.repeat(depth)}    <string name="Source"><![CDATA[${escapeCdata(moduleSource)}]]></string>
      ${'  '.repeat(depth)}  </Properties>${childItems}
      ${'  '.repeat(depth)}</Item>`;
      } else {
        const childItems = buildModuleItems(fullPath, depth + 1);
        items += `
      ${'  '.repeat(depth)}<Item class="Folder" referent="${currentRef}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${entry.name}</string>
      ${'  '.repeat(depth)}  </Properties>${childItems}
      ${'  '.repeat(depth)}</Item>`;
      }
    } else if (isLuaFile(entry.name) && !INIT_FILENAMES.has(entry.name)) {
      const ext = entry.name.endsWith('.luau') ? '.luau' : '.lua';
      const moduleName = basename(entry.name, ext);
      const moduleSource = injectVersion(readFileSync(fullPath, 'utf8'));
      refId++;
      items += `
      ${'  '.repeat(depth)}<Item class="ModuleScript" referent="${refId}">
      ${'  '.repeat(depth)}  <Properties>
      ${'  '.repeat(depth)}    <string name="Name">${moduleName}</string>
      ${'  '.repeat(depth)}    <string name="Source"><![CDATA[${escapeCdata(moduleSource)}]]></string>
      ${'  '.repeat(depth)}  </Properties>
      ${'  '.repeat(depth)}</Item>`;
    }
  }

  return items;
}

const moduleItems = buildModuleItems(modulesDir);

const includeItems = buildModuleItems(includeDir);

const rbxtsItems = buildModuleItems(nodeModulesRbxtsDir);

function countModules(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      count += countModules(join(dir, entry.name));
      if (findInitFile(join(dir, entry.name))) count++;
    } else if (isLuaFile(entry.name) && !INIT_FILENAMES.has(entry.name)) {
      count++;
    }
  }
  return count;
}

const rbxmx = `<?xml version="1.0" encoding="utf-8"?>
<roblox version="4">
  <Item class="Script" referent="0">
    <Properties>
      <string name="Name">${variant.scriptName}</string>
      <token name="RunContext">0</token>
      <string name="Source"><![CDATA[${escapeCdata(mainSource)}]]></string>
    </Properties>
    <Item class="Folder" referent="1">
      <Properties>
        <string name="Name">modules</string>
      </Properties>${moduleItems}
    </Item>${includeItems ? `
    <Item class="Folder" referent="${++refId}">
      <Properties>
        <string name="Name">include</string>
      </Properties>${includeItems}
    </Item>` : ''}${rbxtsItems ? `
    <Item class="Folder" referent="${++refId}">
      <Properties>
        <string name="Name">node_modules</string>
      </Properties>
      <Item class="Folder" referent="${++refId}">
        <Properties>
          <string name="Name">@rbxts</string>
        </Properties>${rbxtsItems}
      </Item>
    </Item>` : ''}
  </Item>
</roblox>
`;

const leftoverPlaceholders = ['__VERSION__', '__BUILD_ID__'].filter((placeholder) => rbxmx.includes(placeholder));
if (leftoverPlaceholders.length > 0) {
  console.error(`Built plugin still contains ${leftoverPlaceholders.join(', ')}; refusing to write ${outputPath}.`);
  process.exit(1);
}

writeFileSync(outputPath, rbxmx, 'utf8');
const moduleCount = countModules(modulesDir);
const includeCount = countModules(includeDir);
const rbxtsCount = countModules(nodeModulesRbxtsDir);
console.log(`Built studio-plugin/${variant.outputName} build ${BUILD_ID} (${moduleCount} modules${includeCount > 0 ? `, ${includeCount} runtime includes` : ''}${rbxtsCount > 0 ? `, ${rbxtsCount} @rbxts packages` : ''})`);
