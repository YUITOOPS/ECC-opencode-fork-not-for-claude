# ECC for OpenCode 2

Everything Claude Code (v2.2.3), вручную портированный с API Claude Code /
OpenCode 1 на нативный API OpenCode 2.x. Это домашний конфиг
`~/.config/opencode`, вынесенный в git: из него же песочница
[ai-docker-sandbox](https://github.com/YUITOOPS/ai-docker-sandbox) забирает
скиллы, правила, агентов и плагин при старте контейнера.

## Состав

| Путь | Что это |
|---|---|
| `agents/` | 26 ECC-субагентов (`mode: subagent`) |
| `commands/` | 35 слэш-команд |
| `skills/` | 327 ECC-скиллов (автодискавери по `SKILL.md`) |
| `rules/` | 122 файла правил; подключены через `instructions` в `opencode.jsonc` |
| `plugins/ecc/` | плагин `ecc-hooks`: хуки + 8 инструментов |
| `agents-skills/` | 5 скиллов, которые на хосте живут в `~/.agents/skills` |
| `node_modules/` | ставятся командой `npm ci` |
| `scripts/`, `hooks/`, `manifests/` | runtime-обвязка ECC (нужен `node`) |
| `AGENTS.md` | глобальные правила ECC |
| `opencode.jsonc` | глобальный конфиг: `instructions` + `permissions` |

## Чего здесь нет и почему

- `node_modules/` — ставятся командой `npm ci`.
- `service.json` — пароль локального сервиса OpenCode, машинно-специфичный
  секрет. В контейнере он создаётся свой.

## Скиллы вне ECC

`agents-skills/` — копия `~/.agents/skills` (ponytail, ponytail-review,
systematic-debugging, using-superpowers, verification-before-completion). На
хосте они остаются на месте, а песочница получает их из этого репозитория в
`~/.agents/skills`.

Обновить копию после `npx skills add/update`:

```powershell
robocopy "$env:USERPROFILE\.agents\skills" agents-skills /MIR
```

## Установка на новую машину

```bash
git clone https://github.com/YUITOOPS/ECC-opencode-fork-not-for-claude.git ~/.config/opencode
cd ~/.config/opencode && npm ci
```

Дальше OpenCode подхватывает содержимое при следующем старте. Доменные наборы
правил (`rules/web/`, `rules/typescript/` и т.д.) подключаются не здесь, а в
проектном `opencode.jsonc`.

## Обновление в песочнице

Песочница делает `git fetch` + `git reset --hard` в свой
`~/.config/opencode` при каждом старте контейнера. Правки, сделанные **внутри**
контейнера, затираются — источник истины этот репозиторий:

```bash
git commit -am "..." && git push
```
