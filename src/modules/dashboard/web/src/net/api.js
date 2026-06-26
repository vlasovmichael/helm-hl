// ─────────────────────────────────────────────────
//  HTTP-обёртка над /api дашборды. 401 → редирект на логин.
// ─────────────────────────────────────────────────

export async function fetchJson(path) {
  const r = await fetch(path);
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}

export async function postJson(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  if (r.status === 401) window.location.href = "/login";
  return r.json();
}

/** Последние ушедшие ntfy-пуши (для колокольчика). */
export function getNotifications(limit = 50) {
  return fetchJson(`/api/notifications?limit=${limit}`);
}
