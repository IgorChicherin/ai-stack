# Platforms: Windows, Linux, macOS

**English** · [Русский](platforms.ru.md)

The stack (Ollama, supermemory, jev) runs in Linux containers, so it works on every OS that runs Docker. What differs is **how Ollama gets the GPU** and **where the config files live**.

| | Windows 11 | Linux | macOS |
|---|---|---|---|
| Containers | Docker Desktop (WSL2 backend) | Docker Engine + Compose plugin | Docker Desktop, OrbStack or Colima |
| GPU for Ollama | NVIDIA, through the container | NVIDIA, through the container (NVIDIA Container Toolkit) | Apple GPU (Metal) only through a **native Ollama on the host** |
| Compose files | `base` + `nvidia` | `base` + `nvidia` (or `base` alone on CPU) | `base` + `host-ollama` |
| Claude Code config | `%USERPROFILE%\.claude` | `~/.claude` | `~/.claude` |
| opencode config | `%USERPROFILE%\.config\opencode` | `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode` | `~/.config/opencode` |

**Test status.** Everything was built and run on Windows 11 with an RTX 4070 Ti (12 GB). For Linux and macOS the Compose files were rendered and validated (`docker compose config`) and the installer was run against a simulated Linux/macOS home directory, but the containers were not started on real Linux or macOS hardware. Report problems you hit there.

## Requirements (all platforms)

- Docker with Compose 2.24 or newer (`docker compose version`). The `host-ollama` override uses the `!reset` tag.
- Node.js 18 or newer for the agent hooks and the installer (the hooks use the built-in `fetch`).
- About 12 GB of free disk space for the models.
- Ollama 0.35 or newer (Tev1 needs the `/v1/systemone` endpoint). The `ollama/ollama:latest` image is new enough.

## Compose files

| File | Purpose |
|---|---|
| `docker-compose.yml` | base: `ollama` (CPU), `ollama-pull`, `supermemory`, `jev` |
| `docker-compose.nvidia.yml` | gives the containerized Ollama the NVIDIA GPU |
| `docker-compose.host-ollama.yml` | does not start the containerized Ollama, points `supermemory` and `jev` at an Ollama running on the host |

Select files with `-f` flags or with `COMPOSE_FILE` in `.env` (copy `.env.example` to `.env`). The separator in `COMPOSE_FILE` is `;` on Windows and `:` on Linux and macOS.

## Linux

### With an NVIDIA GPU

1. Install Docker Engine and the Compose plugin ([Docker docs](https://docs.docker.com/engine/install/)).
2. Install the NVIDIA driver and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), then register it with Docker:
   ```bash
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   docker run --rm --gpus all ubuntu nvidia-smi      # must print your GPU
   ```
3. Start the stack:
   ```bash
   git clone git@github.com:IgorChicherin/ai-stack.git && cd ai-stack
   cp .env.example .env
   # in .env, enable:  COMPOSE_FILE=docker-compose.yml:docker-compose.nvidia.yml
   docker compose up -d --build
   docker compose exec ollama ollama ps               # PROCESSOR must say 100% GPU
   ```

### CPU only

Skip the toolkit and leave `COMPOSE_FILE` unset. Use smaller models in `.env` (for example `JEV_MODEL=tev1:0.8b`, `SM_MODEL=gemma3:4b`), because 4B and larger models are slow on a CPU.

### Ollama on the host (any GPU: AMD, Intel, NVIDIA)

Use `docker-compose.host-ollama.yml` (see the macOS section for the flow). On Linux the host Ollama must be reachable from the Docker bridge. By default it listens on `127.0.0.1` only, which containers cannot reach. Make it listen on all interfaces and keep the port off the network with a firewall:

```bash
sudo systemctl edit ollama      # add:  [Service]  Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
```

## macOS

Docker containers on macOS cannot use the Apple GPU. Run **Ollama natively** (it uses Metal) and let the containers call it.

```bash
brew install ollama          # or install the Ollama app; version 0.35 or newer
ollama serve &               # skip if the app is already running
ollama pull gemma4:e4b-it-qat && ollama pull tev1:4b

git clone git@github.com:IgorChicherin/ai-stack.git && cd ai-stack
cp .env.example .env
# in .env, enable:  COMPOSE_FILE=docker-compose.yml:docker-compose.host-ollama.yml
docker compose up -d --build
curl http://localhost:8765/health      # {"ok":true,"model":"tev1:4b",...}
```

`host.docker.internal` reaches services on the Mac, including ones bound to `127.0.0.1`. Memory is unified, so size models by RAM: `tev1:4b` (4.5 GB) plus `gemma4:e4b-it-qat` (6 GB on disk, about 3 GB resident) fit comfortably on a 16 GB Mac. Use `tev1:4b-q4_K_M` on 8 GB.

## Windows

See `README.md`. In short: Docker Desktop with the WSL2 backend, a current NVIDIA driver, then in `.env` set `COMPOSE_FILE=docker-compose.yml;docker-compose.nvidia.yml`. If a model is killed while loading (`signal: killed`), raise the WSL memory limit (`memory=` under `[wsl2]` in `%USERPROFILE%\.wslconfig`, then `wsl --shutdown`).

## Installing the agent configuration

The installer copies the commit-guard hook and rules into the Claude Code and opencode config directories and merges settings. Same commands on every OS:

```bash
npm install                                   # once: installs jsonc-parser
node scripts/install-configs.js --dry-run     # show what would change
node scripts/install-configs.js               # install (backs up changed files first)
```

It respects `CLAUDE_CONFIG_DIR` (Claude Code) and `XDG_CONFIG_HOME` (opencode). Backups go to `~/backups/ai-stack-install-<time>/`.

### Connect the clients to the stack

```bash
claude mcp add --transport http --scope user jev http://localhost:8765/mcp    # Claude Code
# opencode: the installer adds the "jev" MCP entry to opencode.jsonc
```

For the supermemory plugin of Claude Code, install it inside a session (`/plugin marketplace add supermemoryai/claude-supermemory`, then `/plugin install supermemory@supermemory-plugins`) and set two environment variables **before starting Claude Code**. Get the key from the container logs: `docker compose logs supermemory | grep "api key"`.

| Shell | Command |
|---|---|
| bash (Linux) | `echo 'export SUPERMEMORY_API_URL=http://localhost:6767' >> ~/.bashrc` and `echo 'export SUPERMEMORY_CC_API_KEY=sm_...' >> ~/.bashrc` |
| zsh (macOS default) | the same lines into `~/.zshrc` |
| fish | `set -Ux SUPERMEMORY_API_URL http://localhost:6767` and `set -Ux SUPERMEMORY_CC_API_KEY sm_...` |
| PowerShell (Windows) | `[Environment]::SetEnvironmentVariable("SUPERMEMORY_API_URL","http://localhost:6767","User")` and the same for the key |

Open a new terminal afterwards. Without `SUPERMEMORY_API_URL` the plugin talks to the supermemory cloud.

For opencode, put the same key into `<opencode dir>/supermemory.json` (`"baseUrl": "http://localhost:6767"`, `"apiKey": "sm_..."`) and register `./plugins/supermemory/shim.js` as described in `README.md`, section 4.2 (Russian: `README.ru.md`).

## Useful commands (POSIX shells)

```bash
docker compose ps
docker compose logs -f supermemory
docker compose exec ollama ollama ps           # CPU/GPU split of loaded models
nvidia-smi --query-gpu=memory.used,memory.free --format=csv

# back up the supermemory database (volume sm-data)
docker run --rm -v ai-stack_sm-data:/data -v "$PWD":/backup alpine tar czf /backup/sm-data.tgz -C /data .
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `could not select device driver "nvidia" with capabilities: [[gpu]]` | The NVIDIA override is enabled but the toolkit is missing (Linux) or there is no NVIDIA GPU (macOS). Install the toolkit, or remove `docker-compose.nvidia.yml` from `COMPOSE_FILE`. |
| An error about the `!reset` tag or an unknown `depends_on` field when using `host-ollama` | Docker Compose older than 2.24. Update Compose, or use the base file with a containerized Ollama. |
| `jev` or `supermemory` cannot reach Ollama in `host-ollama` mode | Linux: host Ollama listens on `127.0.0.1` only, see the Linux section. All OS: check `curl http://localhost:11434/api/tags` on the host and that the models are pulled. |
| `ollama ps` shows `PROCESSOR 100% CPU` | No GPU is attached to the container. NVIDIA: check `docker run --rm --gpus all ubuntu nvidia-smi`. macOS: use `host-ollama`. |
| `redirect target not allowed ... non-public 198.18.x.x` on `ollama pull` | A VPN or proxy returns fake IPs. Exclude `registry.ollama.ai` and `*.r2.cloudflarestorage.com`, or pull with the VPN off. |
| Ports 6767, 8765 or 11435 are in use | Another process owns them. Change the host side of the `ports:` mapping in `docker-compose.yml`. |
