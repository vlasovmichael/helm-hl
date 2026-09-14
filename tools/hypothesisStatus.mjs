export const LIFECYCLE_STATUS = Object.freeze({
  OPEN: "OPEN",
  CLOSED: "CLOSED",
});

export const RESULT_STATUS = Object.freeze({
  REJECTED: "REJECTED",
  INCONCLUSIVE: "INCONCLUSIVE",
  PASSED_STAT: "PASSED_STAT",
  PASSED_ECONOMICS: "PASSED_ECONOMICS",
});

export const RESULT_STATUS_LABEL = Object.freeze({
  [RESULT_STATUS.REJECTED]: "ОТВЕРГНУТА",
  [RESULT_STATUS.INCONCLUSIVE]: "НЕДОСТАТОЧНО ДАННЫХ ДЛЯ ВЫВОДА",
  [RESULT_STATUS.PASSED_STAT]: "ПРОШЛА СТАТИСТИКУ, НЕ ЭКОНОМИКУ",
  [RESULT_STATUS.PASSED_ECONOMICS]: "ПРОШЛА СТАТИСТИКУ И ЭКОНОМИЧЕСКИЙ ПОРОГ",
});

export function isLifecycleStatus(value) {
  return Object.values(LIFECYCLE_STATUS).includes(value);
}

export function isResultStatus(value) {
  return Object.values(RESULT_STATUS).includes(value);
}
