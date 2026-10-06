// opencode plugin: same secret guard as claude-jev-guard.js.
// opencode has no "ask" decision in tool.execute.before, so a hit blocks the
// bash call with an error. The agent receives the message and must ask the user.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scanCommit, isCommitCommand } = require('./jev-guard-core.js');

export const JevGuard = async ({ directory }) => ({
  'tool.execute.before': async (input, output) => {
    if (input.tool !== 'bash') return;
    const command = output?.args?.command;
    if (!isCommitCommand(command)) return;

    const res = await scanCommit(command, output.args.workdir || directory);
    for (const w of res.warnings) console.warn(w);
    if (!res.flag) return;

    throw new Error(
      'jev-guard blocked this commit: possible secret.\n- ' + res.reasons.join('\n- ') +
      '\nShow the user the flagged lines and ask before retrying. ' +
      'The user can raise JEV_GUARD_THRESHOLD or remove the flagged lines to proceed.',
    );
  },
});

export default { id: 'jev-guard', server: JevGuard };
