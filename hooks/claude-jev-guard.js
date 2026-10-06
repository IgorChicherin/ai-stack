#!/usr/bin/env node
'use strict';
// Claude Code PreToolUse hook (matcher: Bash).
// On `git commit`, scans the commit contents for secrets. A hit turns into a
// permission prompt ("ask") that shows the reasons. Everything else passes through.

const { scanCommit, isCommitCommand } = require('./jev-guard-core');

function reply(obj) {
  process.stdout.write(JSON.stringify(obj));
  process.exit(0);
}

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', async () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const command = input?.tool_input?.command;
  if (input?.tool_name !== 'Bash' || !isCommitCommand(command)) process.exit(0);

  const res = await scanCommit(command, input.cwd || process.cwd());
  const note = res.warnings.length ? { systemMessage: res.warnings.join('\n') } : {};
  if (!res.flag) reply(note);

  reply({
    ...note,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason:
        'jev-guard: possible secret in this commit.\n- ' + res.reasons.join('\n- ') +
        '\nReview the diff that will be committed before approving.',
    },
  });
});
