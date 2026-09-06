---
name: deploy
description: >-
  Выкатить hl-paper-scanner на прод (Oracle) и проверить, что бот поднялся.
  Использовать при просьбе задеплоить, выкатить, обновить прод или откатиться.
---

# Деплой hl-paper-scanner

Прод — докер-контейнер `hl-paper-scanner` на Oracle, доступ по `ssh oracle`.

## Перед выкаткой

1. `npm test` локально — сторожа + тесты. Красное не деплоим.
2. Изменения в `src/modules/dashboard/web/` требуют пересборки витрины:
   она собирается внутри docker build, отдельного шага не нужно.
3. Закоммитить и запушить в `main` — прод тянет из git, не из локальной папки.

## Выкатка

```bash
ssh oracle 'cd ~/hl-paper-scanner && git pull -q origin main && git log --oneline -1'
ssh oracle 'cd ~/hl-paper-scanner && docker compose build -q hl-paper-scanner'
ssh oracle 'cd ~/hl-paper-scanner && docker compose up -d hl-paper-scanner'
```

## Проверка после старта

Ждать ~25с, потом:

```bash
ssh oracle 'docker logs --tail 40 hl-paper-scanner 2>&1 | grep -iE "error|started|adopt"'
```

Убедиться: тик идёт, WS-фиды подключились, открытые позы подхвачены со стопами.

## 🚨 База

`data/trades.db` принадлежит uid 1000, а `ubuntu` — 1001: с хоста в неё писать
нельзя. Разовая правка строки — через одноразовый контейнер:

```bash
ssh oracle 'cd ~/hl-paper-scanner && docker compose run --rm --no-deps --entrypoint node hl-paper-scanner -e "…"'
```

## Откат

`git revert` + повтор выкатки. Откат образа без коммита не делаем: прод должен
совпадать с `main`.
