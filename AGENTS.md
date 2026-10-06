# ai-stack: project instructions

This file covers only work on the ai-stack repository. Rules that apply everywhere (using `jev`, the commit guard, memory, language) are global: the source is `global/AGENTS.md`, installed by `scripts/install-configs.js` into `~/.claude/CLAUDE.md` only. opencode reads that file as its fallback, so it must not get its own copy (a global `~/.config/opencode/AGENTS.md` would shadow it). Do not duplicate them here and do not add project-level hook or plugin config, because the hook must run exactly once.

## Stack

- `docker-compose.yml`: `ollama` (GPU), `ollama-pull`, `supermemory` (port 6767), `jev` (port 8765). All ports are bound to `127.0.0.1`.
- `jev/app.py`: MCP server and REST wrapper around Ollama `/v1/systemone`.
- `supermemory/Dockerfile`: official Linux binary with sha256 check.
- `hooks/`: source of the commit guard. `config/` and `global/`: sources of the global agent config. `scripts/install-configs.js` installs them.

## Working rules

- After changing anything in `hooks/`, `config/` or `global/`, run `node scripts/install-configs.js --dry-run`, then without `--dry-run`. The installer is idempotent and backs up every file it changes.
- Models are set in `.env` (`SM_MODEL`, `JEV_MODEL`). Both must stay fully on the GPU: check `docker compose exec ollama ollama ps` shows `100% GPU`.
- Never commit `.env`, API keys or the contents of `~/backups`.
- Keep the project cross-platform (Windows, Linux, macOS). Platform differences belong in the compose override files and `docs/platforms.md`, not in `docker-compose.yml` or in OS-specific code. Use `path` and `os` in Node scripts, never hard-coded separators or home paths.
