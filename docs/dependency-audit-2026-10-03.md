# Исходный npm audit — 2026-10-03

Снимок получен командой `npm audit --json` до изменений зависимостей.

| Пакет | Severity | Тип | Путь |
| --- | --- | --- | --- |
| `@eslint-community/eslint-utils` | high | транзитивный | `eslint > @eslint-community/eslint-utils` |
| `@eslint/config-array` | high | транзитивный | `eslint > @eslint/config-array` |
| `@eslint/js` | high | прямой | `@eslint/js > eslint` |
| `blessed-contrib` | high | прямой | `blessed-contrib > lodash`, `map-canvas`, `marked-terminal` |
| `brace-expansion` | high | транзитивный | `eslint > minimatch > brace-expansion` |
| `eslint` | high | прямой | `eslint > @eslint-community/eslint-utils`, `@eslint/config-array`, `minimatch` |
| `immutable` | high | транзитивный | `sass > immutable` |
| `lodash` | high | транзитивный | `blessed-contrib > lodash`; `blessed-contrib > marked-terminal > node-emoji > lodash` |
| `map-canvas` | moderate | транзитивный | `blessed-contrib > map-canvas > xml2js` |
| `marked-terminal` | high | транзитивный | `blessed-contrib > marked-terminal > node-emoji` |
| `minimatch` | high | транзитивный | `eslint > minimatch > brace-expansion` |
| `nanoid` | high | транзитивный | `vite > postcss > nanoid` |
| `node-emoji` | high | транзитивный | `blessed-contrib > marked-terminal > node-emoji > lodash` |
| `postcss` | high | транзитивный | `vite > postcss > nanoid` |
| `sass` | high | прямой | `sass > immutable` |
| `vite` | high | прямой | `vite > postcss`, `sass` |
| `xml2js` | moderate | транзитивный | `blessed-contrib > map-canvas > xml2js` |

Итого: 15 high и 2 moderate.
