// Липкая полоса эквити на телефоне повторяет значения из шапки. Следим за
// самими узлами, а не за данными: значения пишет tick(), и дублировать его
// маршрут сюда означало бы второй источник той же цифры.

/**
 * @returns {() => void} остановка: снимает наблюдатель.
 */
export function initTapeBar() {
  const heroValue = document.getElementById("equity-value");
  const heroDelta = document.getElementById("equity-delta");
  const modePill = document.getElementById("mode-pill");
  const tapeValue = document.getElementById("tape-equity");
  const tapeDelta = document.getElementById("tape-delta");
  const tapeMode = document.getElementById("tape-mode");
  if (!heroValue || !tapeValue) return () => {};

  const sync = () => {
    tapeValue.textContent = heroValue.textContent.trim();
    if (heroDelta && tapeDelta) {
      tapeDelta.textContent = heroDelta.textContent.trim();
      const sign = heroDelta.classList.contains("positive")
        ? "positive"
        : heroDelta.classList.contains("negative")
          ? "negative"
          : "";
      tapeDelta.className = `tape-delta ${sign}`;
    }
    if (modePill && tapeMode) tapeMode.textContent = modePill.textContent.trim();
  };

  const mo = new MutationObserver(sync);
  const text = { childList: true, characterData: true, subtree: true };
  mo.observe(heroValue, text);
  // У дельты следим и за классом: знак приходит именно им.
  if (heroDelta) mo.observe(heroDelta, { ...text, attributes: true, attributeFilter: ["class"] });
  if (modePill) mo.observe(modePill, text);
  sync();

  return () => mo.disconnect();
}
