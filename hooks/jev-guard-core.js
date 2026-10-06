'use strict';
// Pre-commit secret guard shared by the Claude Code hook and the opencode plugin.
//
// Two independent checks on the text that is about to be committed:
//   1. Regexes for well-known secret shapes. Deterministic, no network.
//   2. jev `noul` question "does this text contain a secret?" per chunk of added
//      lines. Catches what the regexes miss, but Tev1 is a small model
//      (about 73% accurate), so a hit is a reason to ask, not proof.
//
// If jev is unreachable the guard still returns the regex result and reports the
// failure in `warnings`. It never blocks work because jev is down.

const { execFileSync } = require('node:child_process');

const JEV_URL = process.env.JEV_URL || 'http://localhost:8765';
const THRESHOLD = Number(process.env.JEV_GUARD_THRESHOLD || '0.5');
const CHUNK_CHARS = Number(process.env.JEV_GUARD_CHUNK_CHARS || '3500');
const MAX_CHUNKS = Number(process.env.JEV_GUARD_MAX_CHUNKS || '8');
const TIMEOUT_MS = Number(process.env.JEV_GUARD_TIMEOUT_MS || '20000');

const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['Anthropic/OpenAI style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['supermemory key', /\bsm_[A-Za-z0-9_-]{30,}\b/],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['hard-coded credential', /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"'\s]{8,}["']/i],
];

const COMMIT_RE = /(^|[\s;&|(])git\s+(?:-[A-Za-z]\s+\S+\s+|--[a-z-]+(?:=\S+)?\s+)*commit\b/;

function isCommitCommand(command) {
  return typeof command === 'string' && COMMIT_RE.test(command);
}

function includesAll(command) {
  // -a, -am, --all (but not --amend alone)
  return /\s(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(command.replace(/\s--amend\b/g, ''));
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function addedLines(diff) {
  const lines = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) lines.push({ file, text: line.slice(1) });
  }
  return lines;
}

function chunk(lines) {
  const chunks = [];
  let cur = '';
  for (const { file, text } of lines) {
    const row = `${file}: ${text}\n`.slice(0, 400);
    if (cur.length + row.length > CHUNK_CHARS && cur) { chunks.push(cur); cur = ''; }
    cur += row;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

async function askJev(text) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${JEV_URL}/v1/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: text,
        questions: {
          secret: {
            type: 'noul',
            instructions: 'Does this text contain a real secret, such as an API key, access token, password or private key?',
            criteria: {
              true: 'The text contains a real credential or private key value.',
              false: 'The text has no credential values. Variable names, placeholders and documentation are not secrets.',
            },
          },
        },
      }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`jev HTTP ${res.status}`);
    const body = await res.json();
    return body.answers.secret.noul;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<{flag: boolean, reasons: string[], warnings: string[], maxProbability: number|null}>}
 */
async function scanCommit(command, cwd) {
  const out = { flag: false, reasons: [], warnings: [], maxProbability: null };
  let diff;
  try {
    diff = git(includesAll(command) ? ['diff', 'HEAD', '--unified=0'] : ['diff', '--cached', '--unified=0'], cwd);
  } catch (e) {
    out.warnings.push(`jev-guard: cannot read diff (${String(e.message).split('\n')[0]})`);
    return out;
  }
  const lines = addedLines(diff);
  if (!lines.length) return out;

  for (const { file, text } of lines) {
    for (const [name, re] of SECRET_PATTERNS) {
      if (re.test(text)) {
        out.flag = true;
        out.reasons.push(`${name} in ${file || '(unknown file)'}`);
      }
    }
  }
  out.reasons = [...new Set(out.reasons)].slice(0, 10);

  const chunks = chunk(lines);
  if (chunks.length > MAX_CHUNKS) {
    out.warnings.push(`jev-guard: diff has ${chunks.length} chunks, checked first ${MAX_CHUNKS} with jev`);
  }
  try {
    const probs = await Promise.all(chunks.slice(0, MAX_CHUNKS).map(askJev));
    out.maxProbability = Math.max(...probs);
    if (out.maxProbability >= THRESHOLD) {
      out.flag = true;
      out.reasons.push(`jev rates the diff ${(out.maxProbability * 100).toFixed(0)}% likely to contain a secret`);
    }
  } catch (e) {
    out.warnings.push(`jev-guard: jev unavailable at ${JEV_URL} (${e.message}); only regex checks ran`);
  }
  return out;
}

module.exports = { scanCommit, isCommitCommand, THRESHOLD };
