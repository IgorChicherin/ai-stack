# Платформы: Windows, Linux, macOS

[English](platforms.md) · **Русский**

Стек (Ollama, supermemory, jev) работает в Linux-контейнерах, поэтому подходит для любой ОС, где есть Docker. Различается **способ доступа Ollama к GPU** и **расположение конфигов**.

| | Windows 11 | Linux | macOS |
|---|---|---|---|
| Контейнеры | Docker Desktop (WSL2) | Docker Engine + плагин Compose | Docker Desktop, OrbStack или Colima |
| GPU для Ollama | NVIDIA, через контейнер | NVIDIA, через контейнер (NVIDIA Container Toolkit) | GPU Apple (Metal) только через **нативный Ollama на хосте** |
| Файлы Compose | `base` + `nvidia` | `base` + `nvidia` (или один `base` на CPU) | `base` + `host-ollama` |
| Конфиг Claude Code | `%USERPROFILE%\.claude` | `~/.claude` | `~/.claude` |
| Конфиг opencode | `%USERPROFILE%\.config\opencode` | `$XDG_CONFIG_HOME/opencode` или `~/.config/opencode` | `~/.config/opencode` |

**Статус проверки.** Всё собрано и запущено на Windows 11 с RTX 4070 Ti (12 GB). Для Linux и macOS файлы Compose отрисованы и проверены (`docker compose config`), установщик прогнан на имитации домашней папки Linux/macOS, но контейнеры на реальном Linux или macOS не запускались. Сообщайте о проблемах.

## Требования (все платформы)

- Docker с Compose 2.24 или новее (`docker compose version`). Файл `host-ollama` использует тег `!reset`.
- Node.js 18 или новее для хуков агентов и установщика (хуки используют встроенный `fetch`).
- Около 12 GB свободного места под модели.
- Ollama 0.35 или новее (Tev1 нужен эндпоинт `/v1/systemone`). Образ `ollama/ollama:latest` достаточно свежий.

## Файлы Compose

| Файл | Назначение |
|---|---|
| `docker-compose.yml` | базовый: `ollama` (CPU), `ollama-pull`, `supermemory`, `jev` |
| `docker-compose.nvidia.yml` | даёт Ollama в контейнере GPU NVIDIA |
| `docker-compose.host-ollama.yml` | не запускает Ollama в контейнере и направляет `supermemory` и `jev` на Ollama, запущенный на хосте |

Файлы выбираются флагами `-f` или переменной `COMPOSE_FILE` в `.env` (скопируй `.env.example` в `.env`). Разделитель в `COMPOSE_FILE`: `;` на Windows и `:` на Linux и macOS.

## Linux

### С GPU NVIDIA

1. Установи Docker Engine и плагин Compose ([документация Docker](https://docs.docker.com/engine/install/)).
2. Установи драйвер NVIDIA и [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), затем зарегистрируй его в Docker:
   ```bash
   sudo nvidia-ctk runtime configure --runtime=docker
   sudo systemctl restart docker
   docker run --rm --gpus all ubuntu nvidia-smi      # должен показать твой GPU
   ```
3. Запусти стек:
   ```bash
   git clone git@github.com:IgorChicherin/ai-stack.git && cd ai-stack
   cp .env.example .env
   # в .env включи:  COMPOSE_FILE=docker-compose.yml:docker-compose.nvidia.yml
   docker compose up -d --build
   docker compose exec ollama ollama ps               # в PROCESSOR должно быть 100% GPU
   ```

### Только CPU

Пропусти toolkit и не задавай `COMPOSE_FILE`. Поставь в `.env` модели поменьше (например, `JEV_MODEL=tev1:0.8b`, `SM_MODEL=gemma3:4b`): модели от 4B на CPU работают медленно.

### Ollama на хосте (любой GPU: AMD, Intel, NVIDIA)

Используй `docker-compose.host-ollama.yml` (порядок действий в разделе про macOS). На Linux Ollama хоста должен быть доступен из сети моста Docker. По умолчанию он слушает только `127.0.0.1`, и контейнеры его не видят. Включи прослушивание на всех интерфейсах и закрой порт от сети фаерволом:

```bash
sudo systemctl edit ollama      # добавь:  [Service]  Environment="OLLAMA_HOST=0.0.0.0:11434"
sudo systemctl restart ollama
```

## macOS

Контейнеры Docker на macOS не могут использовать GPU Apple. Запусти **Ollama нативно** (он использует Metal), а контейнеры будут обращаться к нему.

```bash
brew install ollama          # или установи приложение Ollama; версия 0.35 и новее
ollama serve &               # пропусти, если приложение уже запущено
ollama pull gemma4:e4b-it-qat && ollama pull tev1:4b

git clone git@github.com:IgorChicherin/ai-stack.git && cd ai-stack
cp .env.example .env
# в .env включи:  COMPOSE_FILE=docker-compose.yml:docker-compose.host-ollama.yml
docker compose up -d --build
curl http://localhost:8765/health      # {"ok":true,"model":"tev1:4b",...}
```

`host.docker.internal` достаёт до сервисов на Mac, в том числе привязанных к `127.0.0.1`. Память унифицированная, поэтому модели подбирай по RAM: `tev1:4b` (4.5 GB) и `gemma4:e4b-it-qat` (6 GB на диске, около 3 GB в памяти) спокойно помещаются на Mac с 16 GB. На 8 GB бери `tev1:4b-q4_K_M`.

## Windows

См. `README.ru.md`. Коротко: Docker Desktop с WSL2, свежий драйвер NVIDIA, затем в `.env` задай `COMPOSE_FILE=docker-compose.yml;docker-compose.nvidia.yml`. Если модель убивается при загрузке (`signal: killed`), увеличь лимит памяти WSL (`memory=` в разделе `[wsl2]` файла `%USERPROFILE%\.wslconfig`, затем `wsl --shutdown`).

## Установка конфигурации агентов

Установщик копирует хук защиты коммитов и правила в папки конфигов Claude Code и opencode и сливает настройки. Команды одинаковы на всех ОС:

```bash
npm install                                   # один раз: ставит jsonc-parser
node scripts/install-configs.js --dry-run     # показать, что изменится
node scripts/install-configs.js               # установить (сначала делает резервные копии)
```

Установщик учитывает `CLAUDE_CONFIG_DIR` (Claude Code) и `XDG_CONFIG_HOME` (opencode). Резервные копии лежат в `~/backups/ai-stack-install-<время>/`.

### Подключение клиентов к стеку

```bash
claude mcp add --transport http --scope user jev http://localhost:8765/mcp    # Claude Code
# opencode: запись MCP "jev" в opencode.jsonc добавляет установщик
```

Плагин supermemory для Claude Code ставится внутри сессии (`/plugin marketplace add supermemoryai/claude-supermemory`, затем `/plugin install supermemory@supermemory-plugins`). Две переменные окружения нужно задать **до запуска Claude Code**. Ключ бери из логов контейнера: `docker compose logs supermemory | grep "api key"`.

| Оболочка | Команда |
|---|---|
| bash (Linux) | `echo 'export SUPERMEMORY_API_URL=http://localhost:6767' >> ~/.bashrc` и `echo 'export SUPERMEMORY_CC_API_KEY=sm_...' >> ~/.bashrc` |
| zsh (по умолчанию на macOS) | те же строки в `~/.zshrc` |
| fish | `set -Ux SUPERMEMORY_API_URL http://localhost:6767` и `set -Ux SUPERMEMORY_CC_API_KEY sm_...` |
| PowerShell (Windows) | `[Environment]::SetEnvironmentVariable("SUPERMEMORY_API_URL","http://localhost:6767","User")` и то же для ключа |

После этого открой новый терминал. Без `SUPERMEMORY_API_URL` плагин обращается в облако supermemory.

Для opencode положи тот же ключ в `<папка opencode>/supermemory.json` (`"baseUrl": "http://localhost:6767"`, `"apiKey": "sm_..."`) и зарегистрируй `./plugins/supermemory/shim.js`, как описано в `README.ru.md`, раздел 4.2.

## Полезные команды (оболочки POSIX)

```bash
docker compose ps
docker compose logs -f supermemory
docker compose exec ollama ollama ps           # распределение CPU/GPU у загруженных моделей
nvidia-smi --query-gpu=memory.used,memory.free --format=csv

# резервная копия базы supermemory (volume sm-data)
docker run --rm -v ai-stack_sm-data:/data -v "$PWD":/backup alpine tar czf /backup/sm-data.tgz -C /data .
```

## Диагностика

| Симптом | Причина и решение |
|---|---|
| `could not select device driver "nvidia" with capabilities: [[gpu]]` | Включён файл NVIDIA, но toolkit не установлен (Linux) или нет GPU NVIDIA (macOS). Установи toolkit или убери `docker-compose.nvidia.yml` из `COMPOSE_FILE`. |
| Ошибка про тег `!reset` или неизвестное поле `depends_on` при `host-ollama` | Docker Compose старше 2.24. Обнови Compose или используй базовый файл с Ollama в контейнере. |
| `jev` или `supermemory` не достают до Ollama в режиме `host-ollama` | Linux: Ollama хоста слушает только `127.0.0.1`, см. раздел Linux. Любая ОС: проверь `curl http://localhost:11434/api/tags` на хосте и что модели скачаны. |
| `ollama ps` показывает `PROCESSOR 100% CPU` | GPU не подключён к контейнеру. NVIDIA: проверь `docker run --rm --gpus all ubuntu nvidia-smi`. macOS: используй `host-ollama`. |
| `redirect target not allowed ... non-public 198.18.x.x` при `ollama pull` | VPN или прокси подставляет fake-IP. Добавь в исключения `registry.ollama.ai` и `*.r2.cloudflarestorage.com` или скачивай при выключенном VPN. |
| Порты 6767, 8765 или 11435 заняты | Их держит другой процесс. Поменяй внешнюю часть записи `ports:` в `docker-compose.yml`. |
