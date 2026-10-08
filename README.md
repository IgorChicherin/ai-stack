# ai-stack

**English** · [Русский](README.ru.md)

A local stack in Linux containers for Windows, Linux and macOS:

| Service | What it does | Host port |
|---|---|---|
| `ollama` | Runs the models (on the GPU when available) | `127.0.0.1:11435` |
| `ollama-pull` | Downloads the models once | none |
| `supermemory` | Long-term memory: stores documents, extracts facts, searches them | `127.0.0.1:6767` |
| `jev` | A local counterpart of Jev: fast "pick one / yes-no / rate" decisions on the Tev1 model, served over MCP and REST | `127.0.0.1:8765` |

Clients: **opencode** and **Claude Code** connect to the same containers.

**Platforms.** The stack runs on Windows, Linux and macOS. What differs is how Ollama gets the GPU (NVIDIA inside the container on Windows and Linux, native Ollama with Metal on macOS) and where the config files live. Linux and macOS instructions: [`docs/platforms.md`](docs/platforms.md) (Russian: [`docs/platforms.ru.md`](docs/platforms.ru.md)). Commands below are for Windows PowerShell unless stated otherwise.

```
 opencode ──plugin──┐                       ┌──> gemma4:e4b-it-qat  (fact extraction)
                    ├─> supermemory :6767 ──┤
 Claude Code ─hooks─┘        (OpenAI API)   └──> ollama :11434 ──> GPU
                                                    ^
 opencode / Claude Code ──MCP──> jev :8765 ─────────┘ tev1:4b (/v1/systemone)
```

---

## What jev is for and how to use it

### What it is

`jev` gives an agent (opencode, Claude Code) a fast "reflex": for a short question about a text it answers with **probabilities**, not with reasoning. Under the hood is Tev1 (4B, on the GPU), a model trained to choose one option from a list. It does not generate text; in a single pass it returns a distribution over the options. So the answer arrives in a fraction of a second (about 0.7 s once the model is in VRAM), costs zero cloud-model tokens, and gives a number you can branch on.

It is a local counterpart of the closed Jev model from TypeSafe: the same class of tasks (routing, rule checks, rating on a scale), but on your own machine.

### When to use it

| Task | Question to jev | Tool |
|---|---|---|
| Triage an incoming request | "Is this a bug, a feature or a question?" | `classify` |
| Pick which agent or model is needed | "Simple edit or multi-file refactoring?" | `classify` |
| Check a fact or a rule | "Does this diff change the public API?", "Does the text contain a secret?" | `check` |
| Rate quality | "How clear is this commit message?" | `score` |
| Several checks at once | up to 64 questions about one text in a single call | `decide` |

Not suitable for: generating text, long reasoning, texts longer than about 5000 characters (they are truncated; the model context is about 2000 tokens), and decisions with irreversible consequences (delete, deploy, commit). The accuracy of Tev1 4B on an independent benchmark is about 73%, so it is wrong in roughly a quarter of cases. Use `jev` as a fast filter, not as a judge.

### Tools

All four are available to the agent as MCP tools (`mcp__jev__<name>` in Claude Code, `jev_<name>` in opencode).

**`classify(text, instructions, options)`** picks one option. `options` is a dictionary "name: description". The model relies on the descriptions, so write them concretely.

```json
{
  "text": "The login page crashes when I click submit",
  "instructions": "What kind of request is this?",
  "options": {
    "bug": "reports broken behavior",
    "feature": "asks for new behavior",
    "question": "asks how something works"
  }
}
```

Answer: `choice` (the winner), `probabilities` (per option), `confidence`.

**`check(text, question)`** is a yes/no question. Answer: `noul`, the probability of "yes" from 0 to 1. You choose the threshold. For safety checks use a low one (for example, treat `> 0.3` as suspicious); for an automatic action use a high one.

**`score(text, instructions, levels)`** rates the text on a scale. `levels` is an ordered list of descriptions from worst to best. Answer: `score` (the expected level index, from 0 to `len(levels)-1`), `probabilities` per level, `legend`, `confidence`.

**`decide(text, questions)`** is the raw batch call: up to 64 questions, in the same format as REST (`/v1/decide`). The text is processed once, so it is cheaper than many separate calls.

```json
{
  "text": "def f(a):\n    return eval(a)  # used on user input from request",
  "questions": {
    "risky":   {"type": "noul",  "instructions": "Is this code a security risk?",
                "criteria": {"true": "Contains a security vulnerability.", "false": "No obvious vulnerability."}},
    "quality": {"type": "score", "instructions": "Rate the code quality",
                "criteria": ["Unsafe or broken", "Works but poor", "Acceptable", "Good"]}
  }
}
```

Real answer for this example: `risky.noul = 0.97`, `quality.score = 0.73` (mostly "Works but poor").

### How to use it in a project

1. **Ask the agent directly.** For example: "run this diff through `check` with the question 'does it change the public API'", or "classify these 20 tickets with `classify` into bug/feature/question".
2. **Put rules in the project instructions** so the agent calls `jev` by itself. The agent does not know on its own when it is useful. All instructions for agents are written **in English** (both the model and `jev` work more reliably). Example for `AGENTS.md` (opencode) or `CLAUDE.md` (Claude Code); a ready version lives in `global/AGENTS.md`:

   ```markdown
   ## jev (local classifier)
   - Before editing more than 3 files, call `check`: "Does the change affect a public API or a DB schema?". If the probability is above 0.5, show the plan and ask the user first.
   - Classify unlabeled tasks with `classify` (bug / feature / question / chore).
   - A jev answer is a hint. Never make an irreversible decision from it without user confirmation.
   ```
   A secret check before commits is not needed in the rules: the hook does it (see below).
3. **Call it from scripts and CI** over REST: `POST http://localhost:8765/v1/decide` with the body `{"state": "...", "questions": {...}}` (the Ollama `/v1/systemone` format). Good for git hooks, log filters and triage.
4. **Write good option descriptions.** Quality depends on them more than on how the question is phrased. Instead of `"bug"` write `"bug": "reports broken or crashing behavior"`. For security and policy checks prefer `check` with a clear criterion.
5. **Keep the text short.** Send a diff, a message or one paragraph, not a whole file.

The `jev` tools **are not called automatically**: they are ordinary MCP tools and the model decides whether to call them. Only commit protection runs automatically, see the next section.

### What runs automatically: commit protection (jev-guard)

Before every `git commit` a hook checks what is being committed for secrets (keys, tokens, passwords, private keys). It exists for both clients.

**How it checks.** Only the added lines of the diff are taken (`git diff --cached`, and `git diff HEAD` for `commit -a`/`-am`). Then two independent checks run:

1. **Patterns (regular expressions)**: a `PRIVATE KEY` block, an AWS key (`AKIA...`), GitHub tokens, keys like `sk-...` and `sm_...`, Slack tokens, assignments like `password = "..."`. Deterministic, works without a network.
2. **`jev`**: a `noul` question "does the text contain a real secret?" for chunks of the diff (up to 3500 characters each, at most 8 chunks, in parallel). It finds what the patterns do not know. Threshold `0.5`.

If either check fires, the commit does not pass silently:

| Client | What happens |
|---|---|
| Claude Code | A confirmation prompt (`permissionDecision: ask`) with the reasons. The user decides: allow or reject. |
| opencode | The `bash` call is blocked with the error `jev-guard blocked this commit`. The agent must show the lines and ask the user (opencode has no "ask" mode in this hook). |

If `jev` is unavailable (the container is stopped, 20 s timeout), the pattern check still runs and the answer carries a `jev unavailable` warning. Work is not blocked because `jev` is stopped.

**Files:**

| File | Role |
|---|---|
| `hooks/jev-guard-core.js` | shared logic: command parsing, diff, patterns, the `jev` call |
| `hooks/claude-jev-guard.js` | Claude Code hook (`PreToolUse`, matcher `Bash`) |
| `hooks/opencode-jev-guard.js` | opencode plugin (`tool.execute.before`) |
| `config/claude/settings.json`, `config/opencode/opencode.jsonc` | settings fragments that the installer merges into the clients' global configs |
| `global/AGENTS.md` | global rules for agents: when to call `jev`, commit protection, memory, language |
| `scripts/install-configs.js` | installer: copies the hooks and merges settings (see below) |
| `AGENTS.md` / `CLAUDE.md` | rules only for working on `ai-stack` itself (`CLAUDE.md` includes `AGENTS.md`) |

**Settings (environment variables):**

| Variable | Default | Meaning |
|---|---|---|
| `JEV_URL` | `http://localhost:8765` | address of the `jev` service |
| `JEV_GUARD_THRESHOLD` | `0.5` | probability threshold from `jev`. Lower is stricter; `2` turns off the `jev` check and keeps the patterns |
| `JEV_GUARD_CHUNK_CHARS` | `3500` | diff chunk size |
| `JEV_GUARD_MAX_CHUNKS` | `8` | how many chunks to check with `jev` |
| `JEV_GUARD_TIMEOUT_MS` | `20000` | timeout of a request to `jev` |

**Tested on a test repository:** a harmless commit passes; an AWS key gives a prompt (`jev` 89%); `password = "hunter2hunter2"` gives a prompt (`jev` 71%); `git commit -am` sees uncommitted edits; with `jev` stopped a warning comes, not an error; commands unrelated to commits are not affected.

**Limitations.** `jev` accuracy is about 73%: false alarms on test data and documentation are possible (then confirm the commit), and unusual secrets can be missed. The hook looks only at added lines and does not search history. It fires on the `git commit` command in `bash`, not on `git` run from other tools.

**Install for all projects (config installer).** The script copies files into the clients' folders and merges the settings from the repository files with yours. After installation the repository can be moved: no paths to it are written.

```powershell
cd ai-stack
npm install                                  # once: jsonc-parser
node scripts/install-configs.js --dry-run    # show what would change
node scripts/install-configs.js              # install
```

What `scripts/install-configs.js` does (safe to re-run; the second run changes nothing):

| Step | Source in the repository | Destination |
|---|---|---|
| Copies the hook | `hooks/jev-guard-core.js`, `hooks/claude-jev-guard.js` | `~/.claude/hooks/jev-guard/` |
| Copies the plugin | `hooks/jev-guard-core.js`, `hooks/opencode-jev-guard.js` | `~/.config/opencode/plugins/jev-guard/` |
| Merges Claude Code settings | `config/claude/settings.json` | `~/.claude/settings.json` (JSON: objects merge by key, arrays are unioned without duplicates) |
| Merges opencode settings | `config/opencode/opencode.jsonc` | `~/.config/opencode/opencode.jsonc` (edits via `jsonc-parser`: comments and formatting are kept) |
| Rules for agents | `global/AGENTS.md` | a block between `<!-- ai-stack:begin -->` and `<!-- ai-stack:end -->` in `~/.claude/CLAUDE.md`. Text outside the block is not touched. There is no copy for opencode (see below). |
| Registers the supermemory MCP shim | `supermemory/mcp-shim.js` | `~/.claude/mcp/supermemory/` plus the user-scope MCP server `supermemory` (through `claude mcp add`; skipped with a hint when the `claude` CLI is not on PATH) |

Before writing, the script copies every file it changes to `~/backups/ai-stack-install-<time>/` (the copies may contain keys, do not publish them). It removes old entries that referenced the repository by path. To change the rules or the hook: edit the files in the repository and run the installer again.

The installer honors `CLAUDE_CONFIG_DIR` (Claude Code) and `XDG_CONFIG_HOME` (opencode).

No instructions are installed for opencode: there is neither an `instructions` entry nor `~/.config/opencode/AGENTS.md`. When there is no global `AGENTS.md`, opencode reads `~/.claude/CLAUDE.md` itself (the rule lookup order in the opencode docs: local files, then `~/.config/opencode/AGENTS.md`, then `~/.claude/CLAUDE.md`). This keeps one global source of rules. If you create your own `~/.config/opencode/AGENTS.md`, it overrides `CLAUDE.md` and opencode will not get the `ai-stack` rules.

The configuration is **global only**: the project has no `.claude/settings.json` or `opencode.json` of its own, so the hook runs once, both in `ai-stack` and in other projects.

---

## What supermemory is for and how to use it

### What it is

`supermemory` is the agent's long-term memory. An ordinary agent forgets everything when the session closes; `supermemory` keeps the important things between sessions and injects them at the start of the next ones. It runs locally: the server, the (encrypted) database, the embeddings (`bge-base-en-v1.5`) and the fact extraction (`gemma4:e4b-it-qat`) are all on your machine. Nothing goes to the cloud.

### How memory appears and is used

```
session ──capture──> document ──model extracts facts──> memories
                                                           │
new session <──recall (semantic search + profile)──────────┘
```

1. **Capture.** The plugin sends the server a piece of the conversation (`/v3/documents`). In opencode this happens every N turns (`captureEveryNTurns`) and when the session ends; in Claude Code it happens through hooks.
2. **Extraction.** The server splits the text into chunks, computes embeddings and asks the model to write out durable facts: preferences, decisions with reasons, agreements, project constraints, recurring errors and their fixes. Processing one document takes about 15 seconds; meanwhile the status is `queued`/`extracting`, then `done`.
3. **Recall.** At session start and on every request the plugin looks for relevant memories (`/v4/search`, `/v4/profile`) and adds them to the context. In Claude Code you see this as a `◪ Recalled from supermemory` block in the answers.

Memory is separated by **containers** (tags). For a project the tag is built from the folder name (for example, `repo_ai_stack__115c2bf9b35daaef`), so memories of one repository are not mixed with others. opencode and Claude Code write to the same database and see each other's memories when the tag matches.

### What is worth remembering

Good: "we use PowerShell, not bash", "the `main` branch is protected, we commit through PRs", "Proto `uint64` maps to `DECIMAL(38,0)`", the reason a particular decision was made.

Bad: logs, file contents, temporary paths, secrets. There is no need to store them, and the opencode plugin is configured not to (`filterPrompt`).

### How to use it in a project

1. **Just work.** Capture and recall are automatic. After a few sessions the project accumulates a profile.
2. **Remember explicitly.** Tell the agent: "remember: in this project migrations are done only through Flyway". The agent calls the memory tool (opencode) or the fact is saved at capture (Claude Code). An explicit "remember" works more reliably than hoping for automatic extraction.
3. **Recall explicitly.** Ask: "what did we decide about the DB schema?". If automatic recall missed, the agent can search by itself: in opencode through the plugin's memory tool, in Claude Code through `search_memory` of the local MCP shim (section 5.3).
4. **Index the codebase** (Claude Code): `/supermemory:index` analyzes the repository and saves its structure. Useful at the start of work on a large project.
5. **Check what was saved:**
   ```powershell
   $k = $env:SUPERMEMORY_CC_API_KEY
   # documents and their statuses (should be done, not failed)
   curl -s -X POST http://localhost:6767/v3/documents/list -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"limit":20}'
   # extracted memories of the project
   curl -s -X POST http://localhost:6767/v4/memories/list -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"containerTags":["repo_ai_stack__115c2bf9b35daaef"],"limit":25}'
   # semantic search
   curl -s -X POST http://localhost:6767/v4/search -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"q":"how is opencode connected","containerTags":["repo_ai_stack__115c2bf9b35daaef"],"limit":5}'
   ```
   The server's web interface is at `http://localhost:6767`.
6. **Clean up wrong memories.** A wrong memory is removed by deleting its document: `DELETE /v3/documents/{id}`. A document in the `failed` status is not reprocessed until you delete it and add it again (details in the "Troubleshooting" section).

### Good to know

- The quality of memories depends on the extraction model. `gemma4:e4b-it-qat` copes, but sometimes stores trivia ("the application uses Viper"). If there is a lot of noise, refine `filterPrompt` in `supermemory.json` (opencode) or change `SM_MODEL`.
- The lite server version is limited to **10,000 documents**.
- The same text in the same container is not duplicated: the server returns the existing document.
- Memories do not replace documentation. Put everything any project participant needs to know in `README.md` and `AGENTS.md`/`CLAUDE.md`. Memory is for what accumulates during work and would otherwise be lost.

---

## 1. Requirements

- Docker with Compose 2.24+ and **Linux containers** (Windows: Docker Desktop with WSL2; Linux: Docker Engine; macOS: Docker Desktop, OrbStack or Colima).
- Node.js 18+ (hooks and installer).
- GPU: NVIDIA inside the container (Windows, Linux) or native Ollama with Metal (macOS). Details: `docs/platforms.md`. Tested on Windows 11 with an RTX 4070 Ti (12 GB).
- Ollama 0.35+ inside the container (the `ollama/ollama:latest` image is fine; Tev1 needs `/v1/systemone`).
- Free disk space: about 12 GB for the models (volume `ollama`).

## 2. Files

```
ai-stack/
  docker-compose.yml        base file (Ollama on the CPU)
  docker-compose.nvidia.yml        NVIDIA GPU for the containerized Ollama (Windows, Linux)
  docker-compose.host-ollama.yml   Ollama on the host (macOS Metal, any OS)
  .env, .env.example        models, supermemory version, compose file selection (.env is in .gitignore)
  docs/platforms.md, docs/platforms.ru.md   instructions for Windows, Linux and macOS (English, Russian)
  supermemory/Dockerfile    official Linux supermemory-server binary + sha256 check
  supermemory/mcp-shim.js   stdio MCP server for Claude Code on top of the local supermemory API
  jev/Dockerfile            Python 3.12 + FastMCP
  jev/app.py                MCP tools and REST on top of Ollama /v1/systemone
  hooks/                    commit protection (jev-guard): shared module, Claude Code hook, opencode plugin
  config/                   settings fragments for Claude Code and opencode (merged by the installer)
  global/AGENTS.md          global rules for agents (copied by the installer)
  scripts/install-configs.js  installer of the global configs
  AGENTS.md, CLAUDE.md      rules only for working on ai-stack
```

`.env`:

```
SM_MODEL=gemma4:e4b-it-qat      # fact extraction model for supermemory
JEV_MODEL=tev1:4b               # decision model for jev
SUPERMEMORY_VERSION=0.0.8       # release server-vX.Y.Z on GitHub supermemoryai/supermemory
```

For an NVIDIA GPU on Windows add the line `COMPOSE_FILE=docker-compose.yml;docker-compose.nvidia.yml` to `.env` (the `;` separator is only for Windows; on Linux and macOS use `:`). Without it the containerized Ollama runs on the CPU. A template is in `.env.example`.

## 3. Start

```powershell
cd ai-stack
docker compose up -d --build
docker compose ps
```

The first start downloads the models (about 8 GB); `supermemory` and `jev` start after `ollama-pull`.

The supermemory API key is printed in the logs on the first start and stored in the `sm-data` volume:

```powershell
docker compose logs supermemory | Select-String "api key"
```

Stop: `docker compose down` (data stays in the `ollama` and `sm-data` volumes).
`docker compose down -v` deletes the data too, including the memory database.

### Checks

```powershell
curl http://localhost:6767/v3/health                       # supermemory
curl http://localhost:8765/health                          # jev: {"ok":true,"model":"tev1:4b",...}
docker compose exec ollama ollama ps                       # both models should be 100% GPU
```

A `jev` test:

```powershell
curl http://localhost:8765/v1/decide -H "Content-Type: application/json" -d '{
  "state": "The login page crashes when I click submit",
  "questions": {"kind": {"type": "choice", "instructions": "What kind of request is this?",
    "criteria": {"bug": "reports broken behavior", "feature": "asks for new behavior", "question": "asks how something works"}}}}'
```

The answer contains `choice`, `probabilities` and `confidence`.

---

## 4. Connect opencode

Config: `%USERPROFILE%\.config\opencode\` (Linux and macOS: `~/.config/opencode/`).

### 4.1 jev (MCP)

Add to `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "jev": {
      "type": "remote",
      "url": "http://localhost:8765/mcp",
      "enabled": true
    }
  }
}
```

Check: `opencode mcp list` shows `jev connected`. Tools: `classify`, `check`, `score`, `decide`.

### 4.2 supermemory (plugin)

The `opencode-supermemory` 2.x plugin is written for the OpenCode 2 API. OpenCode 1.x requires a plugin to default-export an object with `server()` or `tui()`, so the package name does not work. A shim is needed.

1. The package is installed in the config folder (`package.json`: `opencode-supermemory ^2.0.15`):
   ```powershell
   cd $HOME\.config\opencode
   npm install opencode-supermemory
   ```
2. `plugins/supermemory/shim.js`:
   ```js
   import { SupermemoryPlugin } from "opencode-supermemory";
   export default SupermemoryPlugin;
   ```
3. In `opencode.jsonc` register the **shim**, not the package name:
   ```jsonc
   "plugin": [
     "./plugins/supermemory/shim.js"
   ]
   ```
4. `supermemory.json` next to `opencode.jsonc`:
   ```json
   {
     "recallMode": "direct",
     "captureEveryNTurns": 3,
     "apiKey": "<key from the container logs>",
     "baseUrl": "http://localhost:6767",
     "similarityThreshold": 0.62,
     "maxMemories": 5,
     "maxProjectMemories": 10,
     "injectProfile": true
   }
   ```
   Tune `similarityThreshold`, `maxMemories` and `filterPrompt` to your needs.
5. Restart opencode: the config is read only at startup.

Notes:

- `captureEveryNTurns: 0` **does not turn capture off**. It means "capture only at the end of the session". For regular capture set 3-5.
- The key is bound to the database. If the `sm-data` volume is recreated, the key is new and the old one gives `401`. Copy the new one into `apiKey`.
- The key is stored in `supermemory.json` in plain text. Do not commit the config folder.

---

## 5. Connect Claude Code

### 5.1 jev (MCP)

In a regular terminal:

```powershell
claude mcp add --transport http --scope user jev http://localhost:8765/mcp
claude mcp list        # jev ... Connected
```

`--scope user` makes the server available in all projects. In a session the tools are named `mcp__jev__classify`, `mcp__jev__check`, `mcp__jev__score`, `mcp__jev__decide`.

### 5.2 supermemory (plugin, hooks only)

1. In a Claude Code session:
   ```
   /plugin marketplace add supermemoryai/claude-supermemory
   /plugin install supermemory@supermemory-plugins
   ```
2. Two **user** environment variables (without them the plugin opens a browser login to the cloud and goes to `api.supermemory.ai`):
   ```powershell
   [Environment]::SetEnvironmentVariable("SUPERMEMORY_API_URL", "http://localhost:6767", "User")
   [Environment]::SetEnvironmentVariable("SUPERMEMORY_CC_API_KEY", "<the same key as in opencode>", "User")
   ```
   The address comes from `SUPERMEMORY_API_URL` first, then from `baseUrl` in the project's `.claude/.supermemory-claude/config.json`, otherwise the cloud. For Linux and macOS shells see `docs/platforms.md`.
3. **Fully close the terminal and Claude Code and start again.** Only a new process picks up the variables. `/clear` and `/reload-plugins` do not help.
4. Check: `/supermemory:status`. Expected: key source `env`, the `/v4/profile` probe returns `200`.

Plugin settings (`~/.supermemory-claude/settings.json`): `maxProfileItems` (default 5), `signalExtraction`, `includeTools`.

### 5.3 supermemory MCP tools (local shim)

The plugin's MCP proxy (`hooks/mcp-proxy.js`) always talks to `https://mcp.supermemory.ai/mcp`. The local server has no `/mcp` endpoint (404), and its key is invalid in the cloud (`401 Invalid or expired token`, shown in `/mcp` as `plugin:supermemory:supermemory` failed or `-32001 not authenticated`). Do not point the plugin at the cloud: memories would split between two stores and repository data would leave the machine.

The hooks (automatic recall, capture, `/supermemory:status`) do not use MCP and work with the local server as is. For the MCP tools, use `supermemory/mcp-shim.js`: a stdio MCP server without dependencies (Node 18+) that maps the tools onto the local HTTP API.

| Tool | Local endpoint |
|---|---|
| `search_memory` | `POST /v4/search` |
| `add_memory` | `POST /v3/documents` |
| `listMemories` | `POST /v4/memories/list` |
| `listSpaces` | derived from `POST /v3/documents/list` (the server has no spaces endpoint) |
| `whoAmI` | `POST /v4/profile` (checks the key) |

Every tool defaults to the current repository's container. The shim computes the tag with the same algorithm as the plugin (git remote `origin` hash, `SUPERMEMORY_REPO_TAG`, `repoContainerTag` in `.claude/.supermemory-claude/config.json`), so the tools and the hooks use the same container.

1. Register the shim once for all projects. The server name must be `supermemory`: the tools then appear as `mcp__supermemory__*`, the names that `/supermemory:index` and the `supermemory:context-gatherer` agent look for.
   Run the installer (section 2) to do this step: it copies the shim and registers it. The command below is the manual equivalent.
   ```powershell
   claude mcp add --scope user supermemory -- node "C:\Users\<you>\Work\ai-stack\supermemory\mcp-shim.js"
   ```
   The shim reads `SUPERMEMORY_API_URL` and `SUPERMEMORY_CC_API_KEY` from the environment (section 5.2). It has no settings of its own.
2. Disable the plugin's cloud server: `/mcp` → `plugin:supermemory:supermemory` → Disable. The hooks do not depend on it.
3. Restart Claude Code. Check: `claude mcp list` shows `supermemory ... Connected`; in a session, ask the agent to call `whoAmI`. Expected: `Connected to http://localhost:6767 (local supermemory). Key accepted. Container: repo_<name>__<hash>.`

Manual check without Claude Code (run it from a repository folder):
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoAmI","arguments":{}}}' \
  | node ~/Work/ai-stack/supermemory/mcp-shim.js
```

The shim follows the container tag algorithm of plugin version 0.1.8. If a plugin update changes that algorithm, the tools and the hooks see different containers: compare the `whoAmI` container with the tag in `/supermemory:status`.

---

## 6. Models and video memory

Chosen for 12 GB of VRAM so that **both models sit entirely on the GPU without offload**:

| Model | Purpose | VRAM | Context |
|---|---|---|---|
| `tev1:4b` | decisions (`jev`) | about 4.7 GB | 2050 |
| `gemma4:e4b-it-qat` | fact extraction | about 3.1 GB | 4096 |

In total about 10.9 of 12.3 GB are used, about 1.1 GB is free. Both models stay in memory for 24 hours (`OLLAMA_KEEP_ALIVE`, `JEV_KEEP_ALIVE`), `OLLAMA_MAX_LOADED_MODELS=2`.

Consequences:

- A big model in LM Studio (for example Qwen3-14B Q4, about 9 GB) will not fit next to them. Either unload it for the time being or use a smaller model.
- If VRAM is short, `tev1:4b-q4_K_M` takes about 2.7 GB instead of 4.5 GB.
- Check: `docker compose exec ollama ollama ps` must show `100% GPU`. Any CPU percentage means offload.

Changing a model: edit `.env`, then `docker compose up -d`. `ollama-pull` downloads what is missing.

`gemma4` "thinks" before answering: the reasoning goes into a separate field, so extracting one document takes 14-17 seconds. That is tolerable for background capture.

---

## 7. Security

- All ports are published only on `127.0.0.1`. The supermemory server inside the container listens on `0.0.0.0` and has no flag to change that, but the port is not published outward.
- Do not publish the ports on `0.0.0.0` and do not open them in the firewall.
- The API key is stored in `supermemory.json` and in the user's environment variables in plain text.
- `jev` and Tev1 are a small model (about 73% benchmark accuracy for 4B). Do not rely on it as the only safeguard for decisions with consequences (delete, deploy, commit).

---

## 8. Maintenance

Update supermemory: change `SUPERMEMORY_VERSION` in `.env` (releases `server-vX.Y.Z` on GitHub) and rebuild:

```powershell
docker compose build supermemory ; docker compose up -d
```

Back up the memory (volume `sm-data`):

```powershell
docker run --rm -v ai-stack_sm-data:/data -v ${PWD}:/backup alpine tar czf /backup/sm-data.tgz -C /data .
```

Logs: `docker compose logs -f supermemory` (diagnostics are there too: `docker compose exec supermemory supermemory-server doctor`).

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| supermemory UI shows 0 memories, documents are `failed` | The documents were created while the LLM was unavailable or the stack was restarting. Re-sending the same text returns the old `failed` document without processing. Delete the document (`DELETE /v3/documents/{id}`) and add it again. |
| `401` from supermemory in opencode | The key is from an old database. Take the new one from the logs and put it in `apiKey`. |
| `llama-server process has terminated: signal: killed` while loading a model | Out of memory in WSL2: the WSL memory limit is too small (check `memory=` in `~/.wslconfig`; the default is 50% of RAM). After editing it, `wsl --shutdown` stops all Docker containers, including other projects'. |
| `redirect target not allowed ... resolves to non-public 198.18.x.x` on `ollama pull` | A VPN/proxy with fake-IP DNS. Add `registry.ollama.ai` and `*.r2.cloudflarestorage.com` to the exclusions or turn the VPN off while downloading. |
| `Authentication timed out` / `console.supermemory.ai` opened in Claude Code | The environment variables are not visible to the process. Restart the terminal and Claude Code completely. |
| `plugin:supermemory:supermemory` failed or `-32001 Supermemory is not authenticated` in `/mcp` | The plugin's MCP points to the cloud. Disable it and use the local shim, see section 5.3. |
| `supermemory` shim connected, but tools return `SUPERMEMORY_CC_API_KEY is not set` or `401` | Claude Code was started without the environment variables of section 5.2. Restart the terminal and Claude Code. |
| A model in `ollama ps` is not `100% GPU` | Not enough VRAM. Close other GPU users (LM Studio) or take a smaller quantization. |
| Port 6767 is in use | The local `supermemory-server.exe` is running on Windows (`supermemory-start`). Stop it (`supermemory-stop`). |
| The containers stopped by themselves | Check `docker events --since 10m` and whether Docker Desktop restarted. All services have `restart: unless-stopped`. |

More platform-specific problems (Linux, macOS): `docs/platforms.md`.

## 10. Sources

- supermemory: official releases of [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory/releases) (`supermemory-server-linux-x64`), documentation <https://supermemory.ai/docs/self-hosting/overview>.
- Claude Code plugin: [supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory), documentation <https://supermemory.ai/docs/integrations/claude-code>.
- Tev1: <https://ollama.com/library/tev1> (Together AI; the model takes questions of the types `choice`, `noul`, `score` through `/v1/systemone`).
