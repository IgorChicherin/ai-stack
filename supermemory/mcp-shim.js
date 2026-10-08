#!/usr/bin/env node
// Local MCP server (stdio) for the self-hosted supermemory server.
//
// The Claude Code supermemory plugin sends its MCP traffic to the cloud
// (https://mcp.supermemory.ai/mcp), and the local server has no /mcp endpoint.
// This shim exposes the same tool names on top of the local HTTP API, so
// mcp__supermemory__* tools and the supermemory:context-gatherer agent work
// against http://localhost:6767. No dependencies: Node 18+ (global fetch).
//
// Environment:
//   SUPERMEMORY_API_URL     local server address (default http://localhost:6767)
//   SUPERMEMORY_CC_API_KEY  local server API key (the same key the plugin hooks use)
//   SUPERMEMORY_REPO_TAG    optional container tag override
//   SUPERMEMORY_ISOLATE_WORKTREES=true  optional, same meaning as in the plugin

'use strict';

const { execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const SERVER_INFO = { name: 'supermemory-local', version: '1.0.0' };
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const REQUEST_TIMEOUT_MS = 30000;

const BASE_URL = (process.env.SUPERMEMORY_API_URL || 'http://localhost:6767').replace(/\/+$/, '');
const API_KEY = process.env.SUPERMEMORY_CC_API_KEY || '';

// ---------------------------------------------------------------------------
// Container tag. Same algorithm as the plugin (hooks/lib/container-tag.js,
// plugin 0.1.8), so the shim reads and writes the container the hooks use.
// ---------------------------------------------------------------------------

function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function getGitRoot(cwd) {
  try {
    if (process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true') {
      return git('rev-parse --show-toplevel', cwd) || null;
    }
    const commonDir = git('rev-parse --git-common-dir', cwd);
    if (commonDir === '.git') return git('rev-parse --show-toplevel', cwd) || null;
    const resolved = path.resolve(cwd, commonDir);
    if (path.basename(resolved) === '.git' && !resolved.includes(`${path.sep}.git${path.sep}`)) {
      return path.dirname(resolved);
    }
    return git('rev-parse --show-toplevel', cwd) || null;
  } catch {
    return null;
  }
}

function normalizeGitRemote(remoteUrl) {
  const raw = remoteUrl.trim();
  if (!raw) return null;
  let normalized;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      normalized = parsed.protocol === 'file:'
        ? `file:${decodeURIComponent(parsed.pathname)}`
        : `${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}/${parsed.pathname.replace(/^\/+/, '')}`;
    } catch {
      normalized = raw;
    }
  } else {
    const scpStyle = raw.match(/^(?:[^@/]+@)?([^:]+):(.+)$/);
    normalized = scpStyle ? `${scpStyle[1].toLowerCase()}/${scpStyle[2]}` : `file:${path.resolve(raw)}`;
  }
  return normalized
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function getGitRepoInfo(cwd) {
  try {
    const remoteUrl = git('remote get-url origin', cwd);
    const display = remoteUrl.replace(/\/+$/, '').replace(/\.git$/i, '');
    const separator = Math.max(display.lastIndexOf('/'), display.lastIndexOf(':'));
    return { name: display.slice(separator + 1) || null, normalizedRemote: normalizeGitRemote(remoteUrl) };
  } catch {
    return { name: null, normalizedRemote: null };
  }
}

function sanitizeRepoName(name) {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return (sanitized || 'unknown').slice(0, 95).replace(/_+$/g, '') || 'unknown';
}

function loadProjectConfig(basePath) {
  try {
    const file = path.join(basePath, '.claude', '.supermemory-claude', 'config.json');
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {}
  return null;
}

function getContainerTag(cwd) {
  const basePath = getGitRoot(cwd) || path.resolve(cwd);
  const projectConfig = loadProjectConfig(basePath);
  if (projectConfig?.repoContainerTag) return projectConfig.repoContainerTag;
  if (process.env.SUPERMEMORY_REPO_TAG) return process.env.SUPERMEMORY_REPO_TAG;

  const { name, normalizedRemote } = getGitRepoInfo(basePath);
  const shortName = sanitizeRepoName(name || path.basename(basePath) || 'unknown').slice(0, 72).replace(/_+$/g, '');
  let localIdentity = basePath;
  try {
    localIdentity = fs.realpathSync.native(basePath);
  } catch {}
  const isolate = process.env.SUPERMEMORY_ISOLATE_WORKTREES === 'true';
  const identity = crypto
    .createHash('sha256')
    .update(!isolate && normalizedRemote ? normalizedRemote : `path:${localIdentity}`)
    .digest('hex')
    .slice(0, 16);
  return `repo_${shortName || 'unknown'}__${identity}`;
}

// ---------------------------------------------------------------------------
// Local HTTP API
// ---------------------------------------------------------------------------

async function api(method, route, body) {
  if (!API_KEY) throw new Error('SUPERMEMORY_CC_API_KEY is not set');
  const response = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'x-sm-source': 'claude-code',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`supermemory ${route} ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const containerTagProp = {
  type: 'string',
  description: "Container (space) to use. Defaults to this repository's container.",
};

const TOOLS = [
  {
    name: 'search_memory',
    description: 'Search long-term memories. Defaults to the current repository container.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for.' },
        limit: { type: 'number', description: 'Maximum results (default 10).' },
        containerTag: containerTagProp,
      },
      required: ['query'],
    },
    async run(args, ctx) {
      const tag = args.containerTag || ctx.containerTag;
      const data = await api('POST', '/v4/search', { q: args.query, containerTag: tag, limit: args.limit || 10 });
      const results = data.results || [];
      if (results.length === 0) return `No memories found in ${tag} for "${args.query}".`;
      return results
        .map((r) => `- ${r.memory} [${(r.updatedAt || '').slice(0, 10)}, similarity ${Number(r.similarity || 0).toFixed(2)}]`)
        .join('\n');
    },
  },
  {
    name: 'add_memory',
    description: 'Save a document to long-term memory. The server extracts facts from it asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text to remember.' },
        customId: { type: 'string', description: 'Optional stable id; saving again with the same id replaces the document.' },
        metadata: { type: 'object', description: 'Optional flat key/value metadata.' },
        containerTag: containerTagProp,
      },
      required: ['content'],
    },
    async run(args, ctx) {
      const tag = args.containerTag || ctx.containerTag;
      const body = { content: args.content, containerTag: tag, metadata: { sm_source: 'claude-code', ...(args.metadata || {}) } };
      if (args.customId) body.customId = args.customId;
      const data = await api('POST', '/v3/documents', body);
      return `Saved to ${tag} (document ${data.id || 'queued'}, status ${data.status || 'unknown'}).`;
    },
  },
  {
    name: 'listMemories',
    description: 'List extracted memories in a container.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum memories (default 50).' },
        containerTag: containerTagProp,
      },
    },
    async run(args, ctx) {
      const tag = args.containerTag || ctx.containerTag;
      const data = await api('POST', '/v4/memories/list', { containerTags: [tag], limit: args.limit || 50 });
      const entries = (data.memoryEntries || []).filter((m) => m.isLatest !== false && !m.isForgotten);
      if (entries.length === 0) return `No memories in ${tag}.`;
      return entries.map((m) => `- ${m.memory} [${(m.updatedAt || m.createdAt || '').slice(0, 10)}]`).join('\n');
    },
  },
  {
    name: 'listSpaces',
    description: 'List container tags (spaces) that hold documents.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      // The local server has no spaces endpoint; derive spaces from documents.
      const data = await api('POST', '/v3/documents/list', { limit: 1000 });
      const tags = new Set();
      for (const doc of data.memories || data.documents || []) {
        for (const tag of doc.containerTags || []) tags.add(tag);
      }
      tags.add(ctx.containerTag);
      return [...tags]
        .sort()
        .map((t) => (t === ctx.containerTag ? `- ${t} (current repository)` : `- ${t}`))
        .join('\n');
    },
  },
  {
    name: 'whoAmI',
    description: 'Show the supermemory server, the current container and check that the key works.',
    inputSchema: { type: 'object', properties: {} },
    async run(_args, ctx) {
      await api('POST', '/v4/profile', { containerTag: ctx.containerTag, q: 'whoAmI' });
      return `Connected to ${BASE_URL} (local supermemory). Key accepted. Container: ${ctx.containerTag}.`;
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message, ctx) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: -32602 });
      let args = params.arguments || {};
      if (typeof args === 'string') args = JSON.parse(args);
      try {
        return { content: [{ type: 'text', text: await tool.run(args, ctx) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: err.message }], isError: true };
      }
    }
    default:
      if (!isRequest) return undefined; // notifications such as notifications/initialized
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
  }
}

function main() {
  let containerTag;
  try {
    containerTag = getContainerTag(process.cwd());
  } catch {
    containerTag = `repo_${sanitizeRepoName(path.basename(process.cwd()))}`;
  }
  const ctx = { containerTag };

  let queue = Promise.resolve();
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    queue = queue.then(async () => {
      const isRequest = message.id !== undefined && message.id !== null;
      try {
        const result = await handle(message, ctx);
        if (isRequest) send({ jsonrpc: '2.0', id: message.id, result });
      } catch (err) {
        if (isRequest) send({ jsonrpc: '2.0', id: message.id, error: { code: err.code || -32603, message: err.message } });
      }
    });
  });

  // Let pending requests finish and the event loop drain. No process.exit():
  // on Windows it can abort with a libuv assertion while fetch handles close.
  rl.on('close', () => {
    queue.catch(() => {});
  });
}

main();
