# Задача 2: мутации — модули сопровождения ручных сделок

Продолжение `docs/mutation-tests-task.md`, те же правила, инфраструктура и отчёт
(новый раздел «Этап 2» в `docs/mutation-tests-report.md`). Ветка та же.

Модули (здесь живут храповик безубытка, TP-сетка и закрытия ручных сделок):

1. `src/modules/strategistAdopt.js` — цель ≥ 90%. Отдельно: тесты храповика
   (`ADOPT_BE_ARM_PCT` / `ADOPT_BE_FLOOR_PCT`): взвод на peak ≥ ARM, закрытие при
   откате ≤ FLOOR, взвод не сбрасывается, переживает рестарт через adoptTrailStore.
2. `src/modules/tpGrid.js` — цель ≥ 90%. Отдельно: формат `доля@R` против `доля@N%`,
   сумма долей < 1, минимум ступени $11.
3. `src/modules/adoptTrailStore.js`, `adoptShadowTrail.js`, `adoptPeakTruth.js` — ≥ 80%.
4. `src/modules/paperEntry.js`, `src/modules/ledger.js` — ≥ 80%.

Продовый код не менять, баги — в «Найденные баги» с деньгами. Модуль = коммит.
Готово, когда у каждого модуля есть строка «после».
