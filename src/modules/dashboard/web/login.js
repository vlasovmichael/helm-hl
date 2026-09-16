//  login.html — автономная страница входа: стили и логика формы.

import "./src/styles/login.scss";

const BAD_CREDS = "Invalid username or password.";

const form = document.getElementById("login-form");
const errEl = document.getElementById("login-error");
const btn = document.getElementById("login-submit");
const params = new URLSearchParams(window.location.search);

function showError(text) {
  errEl.textContent = text;
  errEl.classList.add("visible");
}

// Сервер редиректит сюда с ?error=1, когда форма ушла без JS.
if (params.get("error") === "1") showError(BAD_CREDS);

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errEl.classList.remove("visible");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    const body = new URLSearchParams({
      user: document.getElementById("user").value,
      pass: document.getElementById("pass").value,
    });
    const r = await fetch("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      // 🚨 manual: успешный вход отвечает редиректом, и автоматический переход
      // увёл бы со страницы до того, как мы прочитаем ?next.
      redirect: "manual",
    });
    if (r.status === 204 || r.type === "opaqueredirect") {
      window.location.href = params.get("next") || "/";
      return;
    }
    const data = await r.json().catch(() => ({}));
    showError(data.error || BAD_CREDS);
  } catch {
    showError("Network error. Try again.");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
});
