// ─────────────────────────────────────────────────
//  HTTP-обёртка над /api дашборды. 401 → редирект на логин.
// ─────────────────────────────────────────────────

export async function fetchJson(path) {
  const r = await fetch(path);
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}
