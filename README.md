# ai-stack

Локальный стек в Linux-контейнерах (Docker Desktop, WSL2, NVIDIA GPU):

| Сервис | Что делает | Порт на хосте |
|---|---|---|
| `ollama` | Запускает модели на GPU | `127.0.0.1:11435` |
| `ollama-pull` | Одноразово скачивает модели | нет |
| `supermemory` | Долговременная память: хранит документы, извлекает факты, ищет | `127.0.0.1:6767` |
| `jev` | Локальный аналог Jev: быстрые решения «выбери / да-нет / оцени» на модели Tev1; MCP + REST | `127.0.0.1:8765` |

Клиенты: **opencode** и **Claude Code** подключаются к одним и тем же контейнерам.

```
 opencode ──plugin──┐                       ┌──> gemma4:e4b-it-qat  (извлечение фактов)
                    ├─> supermemory :6767 ──┤
 Claude Code ─hooks─┘        (OpenAI API)   └──> ollama :11434 ──> GPU
                                                    ^
 opencode / Claude Code ──MCP──> jev :8765 ─────────┘ tev1:4b (/v1/systemone)
```

---

## Для чего нужен jev и как им пользоваться

### Что это

`jev` даёт агенту (opencode, Claude Code) быстрый «рефлекс»: на короткий вопрос о тексте он отвечает **вероятностями**, а не рассуждением. Под капотом модель Tev1 (4B, на GPU), которую обучили выбирать вариант из списка. Она не генерирует текст, а за один проход выдаёт распределение по вариантам. Поэтому ответ приходит за доли секунды (около 0.7 с, когда модель уже в VRAM), стоит ноль токенов облачной модели и даёт число, по которому можно ветвить логику.

Это локальный аналог закрытой модели Jev от TypeSafe: тот же класс задач (маршрутизация, проверка по правилу, оценка по шкале), но на твоей машине.

### Когда использовать

| Задача | Вопрос к jev | Инструмент |
|---|---|---|
| Разобрать входящий запрос | «Это баг, фича или вопрос?» | `classify` |
| Выбрать, какой агент или модель нужны | «Простая правка или многофайловый рефакторинг?» | `classify` |
| Проверить факт или правило | «Меняет ли этот diff публичный API?», «Есть ли в тексте секрет?» | `check` |
| Оценить качество | «Насколько понятно это сообщение коммита?» | `score` |
| Несколько проверок сразу | до 64 вопросов к одному тексту за один вызов | `decide` |

Не подходит для: генерации текста, длинных рассуждений, текстов длиннее около 5000 символов (обрезаются, контекст модели около 2000 токенов), решений с необратимыми последствиями (удаление, деплой, коммит). Точность Tev1 4B на независимом бенчмарке около 73%, то есть ошибается примерно в четверти случаев. Используй `jev` как быстрый фильтр, а не как судью.

### Инструменты

Все четыре доступны агенту как MCP-инструменты (`mcp__jev__<имя>` в Claude Code, `jev_<имя>` в opencode).

**`classify(text, instructions, options)`** — выбрать один вариант. `options` это словарь «имя: описание». Модель опирается на описания, поэтому пиши их конкретно.

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

Ответ: `choice` (победитель), `probabilities` (по каждому варианту), `confidence`.

**`check(text, question)`** — вопрос «да/нет». Ответ: `noul`, вероятность «да» от 0 до 1. Порог выбирай сам. Для безопасности ставь низкий (например, `> 0.3` считать подозрительным), для автоматического действия высокий.

**`score(text, instructions, levels)`** — оценка по шкале. `levels` это упорядоченный список описаний от худшего к лучшему. Ответ: `score` (ожидаемый индекс уровня, от 0 до `len(levels)-1`), `probabilities` по уровням, `legend`, `confidence`.

**`decide(text, questions)`** — сырой пакетный вызов, до 64 вопросов, формат как у REST (`/v1/decide`). Один и тот же текст обрабатывается один раз, поэтому это дешевле, чем много отдельных вызовов.

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

Реальный ответ на этот пример: `risky.noul = 0.97`, `quality.score = 0.73` (в основном «Works but poor»).

### Как пользоваться на проекте

1. **Попроси агента напрямую.** Например: «прогони этот diff через `check` с вопросом "меняет ли публичный API"», или «классифицируй эти 20 тикетов через `classify` на bug/feature/question».
2. **Закрепи правила в инструкциях проекта**, чтобы агент звал `jev` сам. Агент сам не знает, когда это полезно. Пример для `AGENTS.md` (opencode) или `CLAUDE.md` (Claude Code):

   ```markdown
   ## jev (локальный классификатор)
   - Перед тем как менять более 3 файлов, вызови `check`: «Затрагивает ли изменение публичный API или схему БД?». Если > 0.5, сначала спроси меня.
   - Перед коммитом вызови `check` на diff: «Содержит ли текст секрет, ключ или пароль?». Если > 0.3, остановись и покажи подозрительные строки.
   - Входящие задачи без тега разбирай через `classify` (bug / feature / question / chore).
   - Результат jev это подсказка. Не принимай по нему необратимых решений без подтверждения.
   ```
3. **Вызывай из скриптов и CI** по REST: `POST http://localhost:8765/v1/decide` с телом `{"state": "...", "questions": {...}}` (формат Ollama `/v1/systemone`). Подходит для хуков git, фильтров логов, триажа.
4. **Пиши хорошие описания вариантов.** Качество зависит от них сильнее, чем от формулировки вопроса. Вместо `"bug"` пиши `"bug": "reports broken or crashing behavior"`. Для безопасности и политик предпочитай `check` с чётким критерием.
5. **Держи текст коротким.** Отправляй diff, сообщение или один абзац, а не файл целиком.

---

## Для чего нужен supermemory и как им пользоваться

### Что это

`supermemory` это долговременная память агента. Обычный агент забывает всё при закрытии сессии, а `supermemory` сохраняет важное между сессиями и подмешивает в начало следующих. Работает локально: сервер, база (шифрованная), эмбеддинги (`bge-base-en-v1.5`) и извлечение фактов (`gemma4:e4b-it-qat`) на твоей машине. Ничего не уходит в облако.

### Как память появляется и используется

```
сессия ──захват──> документ ──модель извлекает факты──> воспоминания
                                                              │
новая сессия <──recall (поиск по смыслу + профиль)────────────┘
```

1. **Захват.** Плагин отправляет серверу кусок разговора (`/v3/documents`). В opencode это происходит каждые N ходов (`captureEveryNTurns`) и при завершении сессии, в Claude Code через hooks.
2. **Извлечение.** Сервер режет текст на фрагменты, считает эмбеддинги и просит модель выписать устойчивые факты: предпочтения, решения с причинами, договорённости, ограничения проекта, повторяющиеся ошибки и их исправления. Обработка одного документа занимает около 15 секунд, пока идёт, статус `queued`/`extracting`, затем `done`.
3. **Recall.** При старте сессии и на каждый запрос плагин ищет релевантные воспоминания (`/v4/search`, `/v4/profile`) и добавляет их в контекст. В Claude Code это видно по блоку `◪ Recalled from supermemory` в ответах.

Память разделена по **контейнерам** (тегам). Для проекта тег строится из имени папки (например, `repo_ai_stack__115c2bf9b35daaef`), поэтому воспоминания одного репозитория не смешиваются с другими. opencode и Claude Code пишут в одну базу и видят воспоминания друг друга, если тег совпадает.

### Что стоит запоминать

Хорошо: «используем PowerShell, не bash», «в `mt-pumping` ветка `main` защищена, коммитим через PR», «Proto `uint64` ложится в `DECIMAL(38,0)`», причина, по которой выбрано то или иное решение.

Плохо: логи, содержимое файлов, временные пути, секреты. Это хранить не нужно, и плагин opencode настроен так, чтобы такое не сохранять (`filterPrompt`).

### Как пользоваться на проекте

1. **Просто работай.** Захват и recall автоматические. После нескольких сессий у проекта накопится профиль.
2. **Запоминай явно.** Скажи агенту: «запомни: в этом проекте миграции делаем только через Flyway». Агент вызовет инструмент памяти (opencode) или факт сохранится при захвате (Claude Code). Явная фраза «запомни / remember» работает надёжнее, чем надежда на автоматическое извлечение.
3. **Вспоминай явно.** Спроси: «что мы решали про схему БД?». Если автоматический recall промахнулся, агент в opencode может искать сам. В Claude Code инструмент `search_memory` недоступен (MCP плагина смотрит в облако, см. раздел 5.3), поэтому там работает только авто-recall.
4. **Индексируй кодовую базу** (Claude Code): `/supermemory:index` разберёт репозиторий и сохранит структуру. Полезно в начале работы над большим проектом.
5. **Проверяй, что сохранилось:**
   ```powershell
   $k = $env:SUPERMEMORY_CC_API_KEY
   # документы и их статусы (должны быть done, не failed)
   curl -s -X POST http://localhost:6767/v3/documents/list -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"limit":20}'
   # извлечённые воспоминания проекта
   curl -s -X POST http://localhost:6767/v4/memories/list -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"containerTags":["repo_ai_stack__115c2bf9b35daaef"],"limit":25}'
   # поиск по смыслу
   curl -s -X POST http://localhost:6767/v4/search -H "Authorization: Bearer $k" -H "Content-Type: application/json" -d '{"q":"как подключен opencode","containerTags":["repo_ai_stack__115c2bf9b35daaef"],"limit":5}'
   ```
   Веб-интерфейс сервера доступен на `http://localhost:6767`.
6. **Чисти ошибочную память.** Неверное воспоминание удаляется через удаление документа: `DELETE /v3/documents/{id}`. Документ в статусе `failed` повторно не обработается, пока его не удалить и не добавить заново (подробности в разделе «Диагностика»).

### Что полезно знать

- Качество воспоминаний зависит от модели извлечения. `gemma4:e4b-it-qat` справляется, но иногда сохраняет мелочи («приложение использует Viper»). Если мусора много, доработай `filterPrompt` в `supermemory.json` (opencode) или смени `SM_MODEL`.
- Лимит lite-версии сервера: **10 000 документов**.
- Один и тот же текст в одном контейнере не дублируется: сервер вернёт уже существующий документ.
- Воспоминания не заменяют документацию. Всё, что нужно знать любому участнику проекта, пиши в `README.md` и `AGENTS.md`/`CLAUDE.md`. Память нужна для того, что накапливается в работе и иначе теряется.

---

## 1. Требования

- Windows 11, Docker Desktop (WSL2-бэкенд, **Linux-контейнеры**).
- NVIDIA GPU с актуальным драйвером. Проверено на RTX 4070 Ti (12 GB).
- Ollama 0.35+ внутри контейнера (образ `ollama/ollama:latest` подходит, Tev1 требует `/v1/systemone`).
- Свободное место: около 12 GB под модели (volume `ollama`).

## 2. Файлы

```
ai-stack/
  docker-compose.yml
  .env                      модели и версия supermemory (в .gitignore)
  supermemory/Dockerfile    официальный Linux-бинарь supermemory-server + проверка sha256
  jev/Dockerfile            Python 3.12 + FastMCP
  jev/app.py                MCP-инструменты и REST поверх Ollama /v1/systemone
```

`.env`:

```
SM_MODEL=gemma4:e4b-it-qat      # модель извлечения фактов для supermemory
JEV_MODEL=tev1:4b               # модель решений для jev
SUPERMEMORY_VERSION=0.0.8       # релиз server-vX.Y.Z на GitHub supermemoryai/supermemory
```

## 3. Запуск

```powershell
cd C:\Users\r00t\Work\ai-stack
docker compose up -d --build
docker compose ps
```

Первый запуск скачивает модели (около 8 GB), `supermemory` и `jev` стартуют после `ollama-pull`.

Ключ API для supermemory печатается при первом старте в логах и хранится в volume `sm-data`:

```powershell
docker compose logs supermemory | Select-String "api key"
```

Остановка: `docker compose down` (данные остаются в volumes `ollama` и `sm-data`).
`docker compose down -v` удалит и данные, включая базу воспоминаний.

### Проверка

```powershell
curl http://localhost:6767/v3/health                       # supermemory
curl http://localhost:8765/health                          # jev: {"ok":true,"model":"tev1:4b",...}
docker compose exec ollama ollama ps                       # обе модели должны быть 100% GPU
```

Тест `jev`:

```powershell
curl http://localhost:8765/v1/decide -H "Content-Type: application/json" -d '{
  "state": "The login page crashes when I click submit",
  "questions": {"kind": {"type": "choice", "instructions": "What kind of request is this?",
    "criteria": {"bug": "reports broken behavior", "feature": "asks for new behavior", "question": "asks how something works"}}}}'
```

Ответ содержит `choice`, `probabilities` и `confidence`.

---

## 4. Подключение opencode

Конфиг: `C:\Users\r00t\.config\opencode\`.

### 4.1 jev (MCP)

В `opencode.jsonc` добавь:

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

Проверка: `opencode mcp list` показывает `jev connected`. Инструменты: `classify`, `check`, `score`, `decide`.

### 4.2 supermemory (плагин)

Плагин `opencode-supermemory` 2.x написан под API OpenCode 2. OpenCode 1.x требует, чтобы плагин экспортировал по умолчанию объект с `server()` или `tui()`, поэтому имя пакета не работает. Нужен shim.

1. Пакет установлен в папке конфига (`package.json`: `opencode-supermemory ^2.0.15`):
   ```powershell
   cd $HOME\.config\opencode
   npm install opencode-supermemory
   ```
2. `plugins/supermemory/shim.js`:
   ```js
   import { SupermemoryPlugin } from "opencode-supermemory";
   export default SupermemoryPlugin;
   ```
3. В `opencode.jsonc` зарегистрируй **shim**, а не имя пакета:
   ```jsonc
   "plugin": [
     "./plugins/supermemory/shim.js"
   ]
   ```
4. `supermemory.json` рядом с `opencode.jsonc`:
   ```json
   {
     "recallMode": "direct",
     "captureEveryNTurns": 3,
     "apiKey": "<ключ из логов контейнера>",
     "baseUrl": "http://localhost:6767",
     "similarityThreshold": 0.62,
     "maxMemories": 5,
     "maxProjectMemories": 10,
     "injectProfile": true
   }
   ```
   Значения `similarityThreshold`, `maxMemories`, `filterPrompt` подбирай под себя.
5. Перезапусти opencode: конфиг читается только при старте.

Нюансы:

- `captureEveryNTurns: 0` **не отключает** захват. Он означает «захват только в конце сессии». Для регулярного захвата поставь 3-5.
- Ключ привязан к базе. Если volume `sm-data` пересоздан, ключ новый, а старый даёт `401`. Скопируй новый в `apiKey`.
- Ключ хранится в `supermemory.json` открытым текстом. Не коммить папку конфига.

---

## 5. Подключение Claude Code

### 5.1 jev (MCP)

В обычном терминале:

```powershell
claude mcp add --transport http --scope user jev http://localhost:8765/mcp
claude mcp list        # jev ... Connected
```

`--scope user` делает сервер доступным во всех проектах. Инструменты в сессии называются `mcp__jev__classify`, `mcp__jev__check`, `mcp__jev__score`, `mcp__jev__decide`.

### 5.2 supermemory (плагин, только hooks)

1. В сессии Claude Code:
   ```
   /plugin marketplace add supermemoryai/claude-supermemory
   /plugin install supermemory@supermemory-plugins
   ```
2. Две переменные окружения **пользователя** (без них плагин откроет браузерный логин в облако и пойдёт на `api.supermemory.ai`):
   ```powershell
   [Environment]::SetEnvironmentVariable("SUPERMEMORY_API_URL", "http://localhost:6767", "User")
   [Environment]::SetEnvironmentVariable("SUPERMEMORY_CC_API_KEY", "<тот же ключ, что в opencode>", "User")
   ```
   Адрес берётся из `SUPERMEMORY_API_URL` в первую очередь, затем из `baseUrl` в `.claude/.supermemory-claude/config.json` проекта, иначе облако.
3. **Полностью закрой терминал и Claude Code и запусти заново.** Переменные подхватывает только новый процесс. `/clear` и `/reload-plugins` не помогают.
4. Проверка: `/supermemory:status`. Ожидаемо: источник ключа `env`, проба `/v4/profile` возвращает `200`.

Параметры плагина (`~/.supermemory-claude/settings.json`): `maxProfileItems` (по умолчанию 5), `signalExtraction`, `includeTools`.

### 5.3 Ограничение: MCP плагина ходит в облако

MCP-прокси плагина (`hooks/mcp-proxy.js`) по умолчанию использует `https://mcp.supermemory.ai/mcp`. У локального сервера эндпоинта `/mcp` нет (404). Поэтому:

- **hooks** (авто-recall в начале сессии, захват, `/supermemory:status`) работают с локальным сервером;
- **MCP-инструменты** `search_memory`, `add_memory`, `whoAmI` и агент `supermemory:context-gatherer` не работают (ошибка `-32001 not authenticated`). Ключ локального сервера в облаке недействителен, и отправлять туда данные не нужно.

Если ошибка в `/mcp` мешает, отключи сервер `plugin:supermemory:supermemory` через `/mcp`. Hooks от этого не зависят.

---

## 6. Модели и видеопамять

Для 12 GB VRAM подобрано так, чтобы **обе модели были целиком на GPU без offload**:

| Модель | Назначение | VRAM | Контекст |
|---|---|---|---|
| `tev1:4b` | решения (`jev`) | около 4.7 GB | 2050 |
| `gemma4:e4b-it-qat` | извлечение фактов | около 3.1 GB | 4096 |

Суммарно занято около 10.9 из 12.3 GB, свободно около 1.1 GB. Обе модели держатся в памяти 24 часа (`OLLAMA_KEEP_ALIVE`, `JEV_KEEP_ALIVE`), `OLLAMA_MAX_LOADED_MODELS=2`.

Следствия:

- Большая модель в LM Studio (например, Qwen3-14B Q4, около 9 GB) рядом не поместится. Либо выгружай её на время, либо используй модель поменьше.
- Если VRAM не хватает, `tev1:4b-q4_K_M` занимает около 2.7 GB вместо 4.5 GB.
- Проверка: `docker compose exec ollama ollama ps` должен показывать `100% GPU`. Любой процент CPU означает offload.

Смена модели: поправь `.env`, затем `docker compose up -d`. `ollama-pull` скачает недостающее.

`gemma4` перед ответом «думает»: рассуждения идут отдельным полем, поэтому извлечение одного документа занимает 14-17 секунд. Для фонового захвата это терпимо.

---

## 7. Безопасность

- Все порты опубликованы только на `127.0.0.1`. Сервер supermemory внутри контейнера слушает `0.0.0.0` и не имеет флага смены адреса, но наружу порт не публикуется.
- Не публикуй порты на `0.0.0.0` и не открывай их в фаерволе.
- Ключ API лежит в `supermemory.json` и в переменных окружения пользователя открытым текстом.
- `jev` и Tev1 это небольшая модель (точность на бенчмарке около 73% для 4B). Нельзя полагаться на неё как на единственную защиту для решений с последствиями (удаление, деплой, коммит).

---

## 8. Обслуживание

Обновить supermemory: смени `SUPERMEMORY_VERSION` в `.env` (релизы `server-vX.Y.Z` на GitHub) и пересобери:

```powershell
docker compose build supermemory ; docker compose up -d
```

Бэкап памяти (volume `sm-data`):

```powershell
docker run --rm -v ai-stack_sm-data:/data -v ${PWD}:/backup alpine tar czf /backup/sm-data.tgz -C /data .
```

Логи: `docker compose logs -f supermemory` (там же диагностика `docker compose exec supermemory supermemory-server doctor`).

---

## 9. Диагностика

| Симптом | Причина и решение |
|---|---|
| В UI supermemory 0 воспоминаний, документы `failed` | Документы создались, когда LLM была недоступна или стек перезапускался. Повторная отправка того же текста возвращает старый `failed`-документ без обработки. Нужно удалить документ (`DELETE /v3/documents/{id}`) и добавить заново. |
| `401` от supermemory в opencode | Ключ из старой базы. Возьми новый из логов и впиши в `apiKey`. |
| `llama-server process has terminated: signal: killed` при загрузке модели | OOM в WSL2: лимит памяти WSL слишком мал (проверь `memory=` в `~/.wslconfig`, по умолчанию 50% RAM). После правки `wsl --shutdown` остановит все контейнеры Docker, включая чужие проекты. |
| `redirect target not allowed ... resolves to non-public 198.18.x.x` при `ollama pull` | VPN/прокси с fake-IP DNS. Добавь `registry.ollama.ai` и `*.r2.cloudflarestorage.com` в исключения или отключи VPN на время загрузки. |
| `Authentication timed out` / открылся `console.supermemory.ai` в Claude Code | Переменные окружения не видны процессу. Перезапусти терминал и Claude Code целиком. |
| `-32001 Supermemory is not authenticated` в `/mcp` | MCP плагина смотрит в облако, см. раздел 5.3. |
| Модель в `ollama ps` не `100% GPU` | Не хватает VRAM. Закрой лишнее (LM Studio) или возьми квантизацию поменьше. |
| Порт 6767 занят | Запущен локальный `supermemory-server.exe` на Windows (`supermemory-start`). Останови его (`supermemory-stop`). |
| Контейнеры остановились сами | Проверь `docker events --since 10m` и не перезапускалась ли Docker Desktop. Все сервисы имеют `restart: unless-stopped`. |

## 10. Откуда что взято

- Супермемори: официальные релизы [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory/releases) (`supermemory-server-linux-x64`), документация <https://supermemory.ai/docs/self-hosting/overview>.
- Плагин Claude Code: [supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory), документация <https://supermemory.ai/docs/integrations/claude-code>.
- Tev1: <https://ollama.com/library/tev1> (Together AI, модель принимает вопросы типов `choice`, `noul`, `score` через `/v1/systemone`).
