#!/usr/bin/env node
'use strict';
// Installs the ai-stack agent configuration into the user's Claude Code and
// opencode config directories.
//
//   node scripts/install-configs.js [--dry-run]
//
// What it does (idempotent, safe to re-run):
//   1. Backs up every file it is about to change to ~/backups/ai-stack-install-<timestamp>/.
//   2. Copies the jev-guard hook files into <claude dir>/hooks/jev-guard/ and
//      <opencode dir>/plugins/jev-guard/ (defaults ~/.claude and ~/.config/opencode).
//   3. Merges config/claude/settings.json into ~/.claude/settings.json (JSON).
//   4. Merges config/opencode/opencode.jsonc into ~/.config/opencode/opencode.jsonc,
//      keeping comments and formatting (jsonc-parser edits, no rewrite).
//   5. Writes global/AGENTS.md as a managed block into ~/.claude/CLAUDE.md. Text outside
//      the block is left alone. opencode reads that file as its fallback, so it gets no
//      copy of its own (an old managed block in ~/.config/opencode/AGENTS.md is removed).
//   6. Removes entries that earlier point at this repository (references by path),
//      because the files are copied now.
//   7. Copies supermemory/mcp-shim.js into <claude dir>/mcp/supermemory/ and registers it as the
//      user-scope MCP server "supermemory" through `claude mcp add` (skipped with a hint when
//      the `claude` CLI is not on PATH).

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { applyEdits, modify, parse } = require('jsonc-parser');

const repo = path.resolve(__dirname, '..');
const homeDir = os.homedir();
const home = homeDir.replace(/\\/g, '/');
const dry = process.argv.includes('--dry-run');

// Honor the same overrides the clients do: CLAUDE_CONFIG_DIR for Claude Code and
// XDG_CONFIG_HOME for opencode (default ~/.config on Linux, macOS and Windows).
const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
const opencodeDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'opencode');

const BEGIN = '<!-- ai-stack:begin -->';
const END = '<!-- ai-stack:end -->';
const STALE = /ai-stack/; // entries that reference the repo by path

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const backupDir = path.join(homeDir, 'backups', `ai-stack-install-${stamp}`);
const backedUp = new Set();
const changes = [];

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
const toSlash = (p) => p.replace(/\\/g, '/');
const render = (text) => text.replaceAll('{{CLAUDE_DIR}}', toSlash(claudeDir)).replaceAll('{{HOME}}', home);

function backup(target) {
  if (!fs.existsSync(target) || backedUp.has(target)) return;
  backedUp.add(target);
  const dest = path.join(backupDir, path.relative(homeDir, target));
  if (dry) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(target, dest);
}

function write(target, content, label) {
  const current = read(target);
  if (current === content) {
    changes.push(`unchanged  ${label}`);
    return;
  }
  changes.push(`${current === null ? 'create   ' : 'update   '} ${label}`);
  if (dry) return;
  backup(target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function copy(src, dst, label) {
  write(dst, fs.readFileSync(src, 'utf8'), label);
}

// ---- 1. hook files --------------------------------------------------------
const hooks = path.join(repo, 'hooks');
copy(path.join(hooks, 'jev-guard-core.js'), path.join(claudeDir, 'hooks', 'jev-guard', 'jev-guard-core.js'), '~/.claude/hooks/jev-guard/jev-guard-core.js');
copy(path.join(hooks, 'claude-jev-guard.js'), path.join(claudeDir, 'hooks', 'jev-guard', 'claude-jev-guard.js'), '~/.claude/hooks/jev-guard/claude-jev-guard.js');
copy(path.join(hooks, 'jev-guard-core.js'), path.join(opencodeDir, 'plugins', 'jev-guard', 'jev-guard-core.js'), '~/.config/opencode/plugins/jev-guard/jev-guard-core.js');
copy(path.join(hooks, 'opencode-jev-guard.js'), path.join(opencodeDir, 'plugins', 'jev-guard', 'opencode-jev-guard.js'), '~/.config/opencode/plugins/jev-guard/opencode-jev-guard.js');

// ---- 2. Claude Code settings.json (strict JSON) ---------------------------
function mergeValue(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    const out = [...a];
    for (const item of b) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item);
    return out;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in a ? mergeValue(a[k], v) : v;
    return out;
  }
  return b;
}

function dropStaleHooks(settings) {
  const pre = settings?.hooks?.PreToolUse;
  if (!Array.isArray(pre)) return;
  const kept = [];
  for (const group of pre) {
    const hs = (group.hooks || []).filter((h) => !(typeof h.command === 'string' && (STALE.test(h.command) || /jev-guard/.test(h.command))));
    if (hs.length) kept.push({ ...group, hooks: hs });
  }
  settings.hooks.PreToolUse = kept;
  if (!kept.length) delete settings.hooks.PreToolUse;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
}

{
  const target = path.join(claudeDir, 'settings.json');
  const fragment = JSON.parse(render(fs.readFileSync(path.join(repo, 'config', 'claude', 'settings.json'), 'utf8')));
  const existingText = read(target);
  const existing = existingText ? JSON.parse(existingText) : {};
  dropStaleHooks(existing);
  const merged = mergeValue(existing, fragment);
  write(target, JSON.stringify(merged, null, 2) + '\n', '~/.claude/settings.json (merge)');
}

// ---- 3. opencode.jsonc (JSONC, comments kept) -----------------------------
{
  const target = path.join(opencodeDir, 'opencode.jsonc');
  const fragment = parse(render(fs.readFileSync(path.join(repo, 'config', 'opencode', 'opencode.jsonc'), 'utf8')));
  let text = read(target) ?? '{}\n';
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: '\n' } };
  const apply = (pathArr, value) => {
    text = applyEdits(text, modify(text, pathArr, value, fmt));
  };
  const lenient = { allowTrailingComma: true, disallowComments: false };

  for (const [key, value] of Object.entries(fragment)) {
    const current = parse(text, [], lenient)?.[key];
    if (Array.isArray(value)) {
      const base = Array.isArray(current) ? current.filter((x) => !(typeof x === 'string' && STALE.test(x))) : [];
      const next = [...base, ...value.filter((v) => !base.includes(v))];
      if (JSON.stringify(next) !== JSON.stringify(current)) apply([key], next);
    } else if (value && typeof value === 'object') {
      for (const [sub, subValue] of Object.entries(value)) {
        if (JSON.stringify(current?.[sub]) !== JSON.stringify(subValue)) apply([key, sub], subValue);
      }
    } else if (current !== value) {
      apply([key], value);
    }
  }
  // Earlier setups referenced this repo by path. The files are copied now, so drop those.
  for (const key of ['plugin', 'instructions']) {
    const current = parse(text, [], lenient)?.[key];
    if (!Array.isArray(current)) continue;
    const kept = current.filter((x) => !(typeof x === 'string' && STALE.test(x)));
    if (kept.length === current.length) continue;
    apply([key], kept.length ? kept : undefined);
  }
  write(target, text, '~/.config/opencode/opencode.jsonc (merge)');
}

// ---- 4. managed rule blocks -----------------------------------------------
function upsertBlock(target, label) {
  const rules = fs.readFileSync(path.join(repo, 'global', 'AGENTS.md'), 'utf8').trim();
  const block = `${BEGIN}\n<!-- Managed by ai-stack scripts/install-configs.js. Edit global/AGENTS.md in the repo and re-run the installer. -->\n${rules}\n${END}`;
  let text = read(target) ?? '';
  // drop an earlier managed block and legacy path imports of the repo rules
  text = text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), '');
  text = text.split('\n').filter((l) => !(l.trim().startsWith('@') && STALE.test(l))).join('\n').trim();
  const next = (text ? text + '\n\n' : '') + block + '\n';
  write(target, next, label);
}
function removeBlock(target, label) {
  const current = read(target);
  if (current === null || !current.includes(BEGIN)) {
    changes.push(`unchanged  ${label.replace(' removed', '')}: no managed block`);
    return;
  }
  const rest = current.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}\\n?`), '').trim();
  if (dry) { changes.push(`${rest ? 'update   ' : 'delete   '} ${label}`); return; }
  backup(target);
  if (rest) fs.writeFileSync(target, rest + '\n'); else fs.rmSync(target);
  changes.push(`${rest ? 'update   ' : 'delete   '} ${label}`);
}

upsertBlock(path.join(claudeDir, 'CLAUDE.md'), '~/.claude/CLAUDE.md (managed block)');
// opencode needs no copy of the rules: with no ~/.config/opencode/AGENTS.md it falls back to
// ~/.claude/CLAUDE.md, so there is one global source. Remove a block left by earlier runs.
removeBlock(path.join(opencodeDir, 'AGENTS.md'), '~/.config/opencode/AGENTS.md (managed block removed)');

// ---- 5. supermemory MCP shim ------------------------------------------------
// The plugin's own MCP server talks to the cloud. The shim serves the same tools from the local
// server. User-scope servers live in ~/.claude.json, which Claude Code rewrites itself, so the
// registration goes through the CLI and not through a direct edit of that file.
{
  const shim = path.join(claudeDir, 'mcp', 'supermemory', 'mcp-shim.js');
  copy(path.join(repo, 'supermemory', 'mcp-shim.js'), shim, '~/.claude/mcp/supermemory/mcp-shim.js');

  const shimArg = toSlash(shim);
  const win = process.platform === 'win32';
  // On Windows `claude` may be a .cmd shim, which needs a shell: build one quoted command line.
  const claude = (args) => (win
    ? spawnSync(['claude', ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' '), { encoding: 'utf8', shell: true })
    : spawnSync('claude', args, { encoding: 'utf8' }));
  const label = 'MCP server "supermemory" (claude mcp, user scope)';
  const current = claude(['mcp', 'get', 'supermemory']);

  if (current.error) {
    changes.push(`skipped    ${label}: claude CLI not found. Run: claude mcp add --scope user supermemory -- node "${shimArg}"`);
  } else if (current.status === 0 && current.stdout.includes(shimArg)) {
    changes.push(`unchanged  ${label}`);
  } else {
    const exists = current.status === 0;
    changes.push(`${exists ? 'update   ' : 'create   '} ${label}`);
    if (!dry) {
      if (exists) claude(['mcp', 'remove', '--scope', 'user', 'supermemory']);
      const added = claude(['mcp', 'add', '--scope', 'user', 'supermemory', '--', 'node', shimArg]);
      if (added.status !== 0) changes.push(`failed     ${label}: ${(added.stderr || added.stdout || '').trim()}`);
    }
  }
}

// ---- report -----------------------------------------------------------------
console.log(dry ? 'DRY RUN (nothing written)' : 'Installed');
for (const c of changes) console.log('  ' + c);
if (!dry && backedUp.size) console.log(`Backup of ${backedUp.size} changed file(s): ${backupDir}`);
