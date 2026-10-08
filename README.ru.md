# ai-stack

[English](README.md) · **Русский**

Локальный стек в Linux-контейнерах для Windows, Linux и macOS:

| Сервис | Что делает | Порт на хосте |
|---|---|---|
| `ollama` | Запускает модели на GPU | `127.0.0.1:11435` |
| `ollama-pull` | Одноразово скачивает модели | нет |
| `supermemory` | Долговременная память: хранит документы, извлекает факты, ищет | `127.0.0.1:6767` |
| `jev` | Локальный аналог Jev: быстрые решения «выбери / да-нет / оцени» на модели Tev1; MCP + REST | `127.0.0.1:8765` |

Клиенты: **opencode** и **Claude Code** подключаются к одним и тем же контейнерам.

**Платформы.** Стек работает на Windows, Linux и macOS. Различается способ доступа Ollama к GPU (NVIDIA в контейнере на Windows и Linux, нативный Ollama с Metal на macOS) и пути конфигов. Инструкции для Linux и macOS: [`docs/platforms.ru.md`](docs/platforms.ru.md) (на английском: [`docs/platforms.md`](docs/platforms.md)). Команды ниже даны для Windows PowerShell, если не сказано иное.

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
2. **Закрепи правила в инструкциях проекта**, чтобы агент звал `jev` сам. Агент сам не знает, когда это полезно. Все инструкции для агентов пишутся **на английском** (так надёжнее работают и модель, и `jev`). Пример для `AGENTS.md` (opencode) или `CLAUDE.md` (Claude Code), готовая версия лежит в `AGENTS.md` этого проекта:

   ```markdown
   ## jev (local classifier)
   - Before editing more than 3 files, call `check`: "Does the change affect a public API or a DB schema?". If the probability is above 0.5, show the plan and ask the user first.
   - Classify unlabeled tasks with `classify` (bug / feature / question / chore).
   - A jev answer is a hint. Never make an irreversible decision from it without user confirmation.
   ```
   Проверка секретов перед коммитом в правилах не нужна: её делает hook (см. ниже).
3. **Вызывай из скриптов и CI** по REST: `POST http://localhost:8765/v1/decide` с телом `{"state": "...", "questions": {...}}` (формат Ollama `/v1/systemone`). Подходит для хуков git, фильтров логов, триажа.
4. **Пиши хорошие описания вариантов.** Качество зависит от них сильнее, чем от формулировки вопроса. Вместо `"bug"` пиши `"bug": "reports broken or crashing behavior"`. Для безопасности и политик предпочитай `check` с чётким критерием.
5. **Держи текст коротким.** Отправляй diff, сообщение или один абзац, а не файл целиком.

Инструменты `jev` **сами не вызываются**: это обычные MCP-инструменты, и модель решает, звать ли их. Автоматически работает только защита коммитов, см. следующий раздел.

### Что вызывается автоматически: защита коммитов (jev-guard)

Перед каждым `git commit` срабатывает hook, который проверяет, что коммитится, на секреты (ключи, токены, пароли, приватные ключи). Он есть в проекте для обоих клиентов.

**Как проверяется.** Из `git diff` берутся только добавленные строки (`git diff --cached`, а при `commit -a`/`-am` `git diff HEAD`). Дальше две независимые проверки:

1. **Шаблоны (регулярные выражения)**: блок `PRIVATE KEY`, ключ AWS (`AKIA...`), токены GitHub, ключи вида `sk-...` и `sm_...`, токены Slack, присваивания вида `password = "..."`. Детерминированно, работает без сети.
2. **`jev`**: вопрос `noul` «содержит ли текст настоящий секрет?» по кускам диффа (до 3500 символов, максимум 8 кусков, параллельно). Находит то, что шаблоны не знают. Порог `0.5`.

Если сработала любая проверка, коммит не проходит молча:

| Клиент | Что происходит |
|---|---|
| Claude Code | Запрос подтверждения (`permissionDecision: ask`) с причинами. Пользователь решает: разрешить или отклонить. |
| opencode | Вызов `bash` блокируется ошибкой `jev-guard blocked this commit`. Агент должен показать строки и спросить пользователя (у opencode нет режима «спросить» в этом хуке). |

Если `jev` недоступен (контейнер остановлен, таймаут 20 с), проверка шаблонами всё равно выполняется, а в ответе будет предупреждение `jev unavailable`. Работа из-за остановленного `jev` не блокируется.

**Файлы:**

| Файл | Роль |
|---|---|
| `hooks/jev-guard-core.js` | общая логика: разбор команды, дифф, шаблоны, вызов `jev` |
| `hooks/claude-jev-guard.js` | hook Claude Code (`PreToolUse`, matcher `Bash`) |
| `hooks/opencode-jev-guard.js` | плагин opencode (`tool.execute.before`) |
| `config/claude/settings.json`, `config/opencode/opencode.jsonc` | фрагменты настроек, которые установщик сливает в глобальные конфиги клиентов |
| `global/AGENTS.md` | глобальные правила для агентов: когда звать `jev`, защита коммитов, память, язык |
| `scripts/install-configs.js` | установщик: копирует хуки и сливает настройки (см. ниже) |
| `AGENTS.md` / `CLAUDE.md` | правила только для работы над самим `ai-stack` (`CLAUDE.md` включает `AGENTS.md`) |

**Настройка (переменные окружения):**

| Переменная | По умолчанию | Смысл |
|---|---|---|
| `JEV_URL` | `http://localhost:8765` | адрес сервиса `jev` |
| `JEV_GUARD_THRESHOLD` | `0.5` | порог вероятности от `jev`. Ниже строже, `2` отключает проверку через `jev`, шаблоны остаются |
| `JEV_GUARD_CHUNK_CHARS` | `3500` | размер куска диффа |
| `JEV_GUARD_MAX_CHUNKS` | `8` | сколько кусков проверять через `jev` |
| `JEV_GUARD_TIMEOUT_MS` | `20000` | таймаут запроса к `jev` |

**Проверено на тестовом репозитории:** безобидный коммит проходит; ключ AWS даёт запрос (`jev` 89%); `password = "hunter2hunter2"` даёт запрос (`jev` 71%); `git commit -am` видит незакоммиченные правки; при остановленном `jev` приходит предупреждение, а не ошибка; команды, не связанные с коммитом, не затрагиваются.

**Ограничения.** Точность `jev` около 73%: возможны ложные срабатывания на тестовых данных и документации (тогда подтверди коммит) и пропуски нетипичных секретов. Хук смотрит только на добавленные строки и не ищет секреты в истории. Он срабатывает на команду `git commit` в `bash`, а не на `git` из других инструментов.

**Установка для всех проектов (установщик конфигов).** Скрипт копирует файлы в папки клиентов и сливает настройки из файлов репозитория с твоими. Репозиторий после установки можно перемещать, пути на него не записываются.

```powershell
cd ai-stack
npm install                                  # один раз: jsonc-parser
node scripts/install-configs.js --dry-run    # показать, что изменится
node scripts/install-configs.js              # установить
```

Что делает `scripts/install-configs.js` (повторный запуск безопасен, второй прогон ничего не меняет):

| Шаг | Источник в репозитории | Куда |
|---|---|---|
| Копирует хук | `hooks/jev-guard-core.js`, `hooks/claude-jev-guard.js` | `~/.claude/hooks/jev-guard/` |
| Копирует плагин | `hooks/jev-guard-core.js`, `hooks/opencode-jev-guard.js` | `~/.config/opencode/plugins/jev-guard/` |
| Сливает настройки Claude Code | `config/claude/settings.json` | `~/.claude/settings.json` (JSON: объекты сливаются по ключам, массивы объединяются без дублей) |
| Сливает настройки opencode | `config/opencode/opencode.jsonc` | `~/.config/opencode/opencode.jsonc` (правки через `jsonc-parser`: комментарии и форматирование сохраняются) |
| Правила для агентов | `global/AGENTS.md` | блок между `<!-- ai-stack:begin -->` и `<!-- ai-stack:end -->` в `~/.claude/CLAUDE.md`. Текст вне блока не трогается. Для opencode копии нет (см. ниже). |
| Регистрирует MCP-шим supermemory | `supermemory/mcp-shim.js` | `~/.claude/mcp/supermemory/` и MCP-сервер `supermemory` уровня user (через `claude mcp add`; если `claude` нет в PATH, шаг пропускается с подсказкой) |

Перед записью скрипт копирует каждый изменяемый файл в `~/backups/ai-stack-install-<время>/` (в копиях могут быть ключи, не публикуй). Старые записи, которые ссылались на репозиторий по пути, он удаляет. Чтобы поменять правила или хук: правь файлы в репозитории и запусти установщик ещё раз.

Для opencode инструкции не устанавливаются: нет ни записи `instructions`, ни `~/.config/opencode/AGENTS.md`. Если глобального `AGENTS.md` нет, opencode сам читает `~/.claude/CLAUDE.md` (порядок поиска правил в документации opencode: локальные файлы, затем `~/.config/opencode/AGENTS.md`, затем `~/.claude/CLAUDE.md`). Так остаётся один глобальный источник правил. Если создашь свой `~/.config/opencode/AGENTS.md`, он перекроет `CLAUDE.md`, и правил `ai-stack` в opencode не будет.

Конфигурация **только глобальная**: в проекте нет собственных `.claude/settings.json` и `opencode.json`, поэтому хук работает один раз и в `ai-stack`, и в остальных проектах.

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

Хорошо: «используем PowerShell, не bash», «ветка `main` защищена, коммитим через PR», «Proto `uint64` ложится в `DECIMAL(38,0)`», причина, по которой выбрано то или иное решение.

Плохо: логи, содержимое файлов, временные пути, секреты. Это хранить не нужно, и плагин opencode настроен так, чтобы такое не сохранять (`filterPrompt`).

### Как пользоваться на проекте

1. **Просто работай.** Захват и recall автоматические. После нескольких сессий у проекта накопится профиль.
2. **Запоминай явно.** Скажи агенту: «запомни: в этом проекте миграции делаем только через Flyway». Агент вызовет инструмент памяти (opencode) или факт сохранится при захвате (Claude Code). Явная фраза «запомни / remember» работает надёжнее, чем надежда на автоматическое извлечение.
3. **Вспоминай явно.** Спроси: «что мы решали про схему БД?». Если автоматический recall промахнулся, агент может искать сам: в opencode через инструмент памяти плагина, в Claude Code через `search_memory` локального MCP-shim (раздел 5.3).
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

- Docker с Compose 2.24+ и **Linux-контейнерами** (Windows: Docker Desktop с WSL2; Linux: Docker Engine; macOS: Docker Desktop, OrbStack или Colima).
- Node.js 18+ (хуки и установщик).
- GPU: NVIDIA в контейнере (Windows, Linux) или нативный Ollama с Metal (macOS). Подробности: `docs/platforms.ru.md`. Проверено на Windows 11 с RTX 4070 Ti (12 GB).
- Ollama 0.35+ внутри контейнера (образ `ollama/ollama:latest` подходит, Tev1 требует `/v1/systemone`).
- Свободное место: около 12 GB под модели (volume `ollama`).

## 2. Файлы

```
ai-stack/
  docker-compose.yml        базовый файл (Ollama на CPU)
  docker-compose.nvidia.yml        GPU NVIDIA для Ollama в контейнере (Windows, Linux)
  docker-compose.host-ollama.yml   Ollama на хосте (macOS Metal и любая ОС)
  .env, .env.example        модели, версия supermemory, выбор compose-файлов (.env в .gitignore)
  docs/platforms.md, docs/platforms.ru.md   инструкции для Windows, Linux и macOS (English, Русский)
  supermemory/Dockerfile    официальный Linux-бинарь supermemory-server + проверка sha256
  supermemory/mcp-shim.js   stdio MCP-сервер для Claude Code поверх локального API supermemory
  jev/Dockerfile            Python 3.12 + FastMCP
  jev/app.py                MCP-инструменты и REST поверх Ollama /v1/systemone
  hooks/                    защита коммитов (jev-guard): общий модуль, hook Claude Code, плагин opencode
  config/                   фрагменты настроек Claude Code и opencode (сливаются установщиком)
  global/AGENTS.md          глобальные правила для агентов (копируются установщиком)
  scripts/install-configs.js  установщик глобальных конфигов
  AGENTS.md, CLAUDE.md      правила только для работы над ai-stack
```

`.env`:

```
SM_MODEL=gemma4:e4b-it-qat      # модель извлечения фактов для supermemory
JEV_MODEL=tev1:4b               # модель решений для jev
SUPERMEMORY_VERSION=0.0.8       # релиз server-vX.Y.Z на GitHub supermemoryai/supermemory
```

Для GPU NVIDIA на Windows добавь в `.env` строку `COMPOSE_FILE=docker-compose.yml;docker-compose.nvidia.yml` (разделитель `;` только на Windows, на Linux и macOS `:`). Без неё Ollama в контейнере работает на CPU. Образец: `.env.example`.

## 3. Запуск

```powershell
cd ai-stack
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

Конфиг: `%USERPROFILE%\.config\opencode\` (Linux и macOS: `~/.config/opencode/`).

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

### 5.3 MCP-инструменты supermemory (локальный shim)

MCP-прокси плагина (`hooks/mcp-proxy.js`) всегда ходит на `https://mcp.supermemory.ai/mcp`. У локального сервера эндпоинта `/mcp` нет (404), а его ключ в облаке недействителен (`401 Invalid or expired token`; в `/mcp` это видно как упавший `plugin:supermemory:supermemory` или `-32001 not authenticated`). Не направляй плагин в облако: память разделится на два хранилища, а данные репозитория уйдут с машины.

Hooks (авто-recall, захват, `/supermemory:status`) не используют MCP и работают с локальным сервером как есть. Для MCP-инструментов используй `supermemory/mcp-shim.js`: stdio MCP-сервер без зависимостей (Node 18+), который отображает инструменты на локальный HTTP API.

| Инструмент | Локальный эндпоинт |
|---|---|
| `search_memory` | `POST /v4/search` |
| `add_memory` | `POST /v3/documents` |
| `listMemories` | `POST /v4/memories/list` |
| `listSpaces` | собирается из `POST /v3/documents/list` (эндпоинта spaces у сервера нет) |
| `whoAmI` | `POST /v4/profile` (проверяет ключ) |

По умолчанию каждый инструмент работает с контейнером текущего репозитория. Shim вычисляет тег тем же алгоритмом, что и плагин (хеш git remote `origin`, `SUPERMEMORY_REPO_TAG`, `repoContainerTag` в `.claude/.supermemory-claude/config.json`), поэтому инструменты и hooks пишут в один контейнер.

1. Зарегистрируй shim один раз для всех проектов. Имя сервера должно быть `supermemory`: тогда инструменты называются `mcp__supermemory__*`, и их находят `/supermemory:index` и агент `supermemory:context-gatherer`.
   Этот шаг делает установщик (раздел 2): копирует шим и регистрирует его. Команда ниже — ручной аналог.
   ```powershell
   claude mcp add --scope user supermemory -- node "C:\Users\<you>\Work\ai-stack\supermemory\mcp-shim.js"
   ```
   Shim берёт `SUPERMEMORY_API_URL` и `SUPERMEMORY_CC_API_KEY` из окружения (раздел 5.2). Своих настроек у него нет.
2. Отключи облачный сервер плагина: `/mcp` → `plugin:supermemory:supermemory` → Disable. Hooks от него не зависят.
3. Перезапусти Claude Code. Проверка: `claude mcp list` показывает `supermemory ... Connected`; в сессии попроси агента вызвать `whoAmI`. Ожидаемо: `Connected to http://localhost:6767 (local supermemory). Key accepted. Container: repo_<name>__<hash>.`

Ручная проверка без Claude Code (запускай из папки репозитория):
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"whoAmI","arguments":{}}}' \
  | node ~/Work/ai-stack/supermemory/mcp-shim.js
```

Shim повторяет алгоритм тега плагина версии 0.1.8. Если обновление плагина изменит алгоритм, инструменты и hooks будут смотреть в разные контейнеры: сравни контейнер из `whoAmI` с тегом в `/supermemory:status`.

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
| Упавший `plugin:supermemory:supermemory` или `-32001 Supermemory is not authenticated` в `/mcp` | MCP плагина смотрит в облако. Отключи его и используй локальный shim, см. раздел 5.3. |
| Shim `supermemory` подключён, но инструменты возвращают `SUPERMEMORY_CC_API_KEY is not set` или `401` | Claude Code запущен без переменных окружения из раздела 5.2. Перезапусти терминал и Claude Code. |
| Модель в `ollama ps` не `100% GPU` | Не хватает VRAM. Закрой лишнее (LM Studio) или возьми квантизацию поменьше. |
| Порт 6767 занят | Запущен локальный `supermemory-server.exe` на Windows (`supermemory-start`). Останови его (`supermemory-stop`). |
| Контейнеры остановились сами | Проверь `docker events --since 10m` и не перезапускалась ли Docker Desktop. Все сервисы имеют `restart: unless-stopped`. |

## 10. Откуда что взято

- Супермемори: официальные релизы [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory/releases) (`supermemory-server-linux-x64`), документация <https://supermemory.ai/docs/self-hosting/overview>.
- Плагин Claude Code: [supermemoryai/claude-supermemory](https://github.com/supermemoryai/claude-supermemory), документация <https://supermemory.ai/docs/integrations/claude-code>.
- Tev1: <https://ollama.com/library/tev1> (Together AI, модель принимает вопросы типов `choice`, `noul`, `score` через `/v1/systemone`).
