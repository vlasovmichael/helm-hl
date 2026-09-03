// ─────────────────────────────────────────────────────────────────────
//  Шапка страницы — одна на все страницы дашборда.
//
//  До 04.09.2026 <header> копировался в шесть .html и в каждом расходился:
//  на /lab плашка WS висела одна в правом столбце, на / — в ряду со здоровьем
//  фидов, на /oi вместо неё стояла заметка, на /statistics не было ничего.
//  Одна и та же плашка «WS live» оказывалась в разных местах и на разной
//  высоте — та же болезнь, что была у topnav до mountTopnav().
//
//  Левая часть у страниц разная по смыслу (на дашборде это equity, на
//  остальных — надзаголовок + название), поэтому она параметр, а правая —
//  всегда одна и та же.
// ─────────────────────────────────────────────────────────────────────

/**
 * Правая часть шапки: плашка состояния связи + необязательная заметка.
 *
 * 🚨 Плашка рисуется ТОЛЬКО там, где страница действительно держит WS
 * (`status: true`). На /oi, /orderbook и /journal сокета нет — там она вечно
 * показывала бы «WS connecting» и врала бы о состоянии, которого никто не
 * измеряет. Отсутствие плашки честнее выдуманной.
 */
function statusSide({ note, status }) {
  const pills = status
    ? `<div class="pill-row">
        <div id="ws-pill" class="status-pill offline is-connecting">WS connecting</div>
      </div>`
    : "";
  if (!pills && !note) return "";
  return `
    <div class="meta-group">
      ${pills}
      ${note ? `<p class="page-note">${note}</p>` : ""}
    </div>`;
}

/**
 * Рендерит шапку в placeholder `<header id="page-header">`.
 *
 * eyebrow — раздел («Open Interest»), title — что именно на странице,
 * note — одна фраза о происхождении данных, status — держит ли страница WS,
 * extra — разметка страницы-исключения (стенд ticket.html живёт без topnav,
 * и переключателю темы больше негде стоять).
 */
export function mountPageHeader({
  eyebrow,
  title,
  note = "",
  status = false,
  extra = "",
}) {
  const host = document.getElementById("page-header");
  if (!host) return;
  host.innerHTML = `
    <div class="page-head">
      <div class="label">${eyebrow}</div>
      <div class="value page-title">${title}</div>
    </div>
    ${extra}
    ${statusSide({ note, status })}`;
}
