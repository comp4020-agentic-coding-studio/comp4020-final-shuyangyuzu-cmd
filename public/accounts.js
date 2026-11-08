// Server communication for account registration/login/logout
// (src/accountRoutes.ts). No DOM here, same pattern as orders.js —
// public/tavern.js owns the actual login/signup overlay and the
// character panel's logout/switch controls, calling these functions
// directly, which is what keeps this module part of app.js's own
// versioned dynamic imports rather than a nested, unversioned import
// that could silently serve a stale cached copy.
//
// `credentials: 'same-origin'` on every call: the account session lives
// in an HttpOnly cookie (never localStorage, never a URL param — unlike
// every other session_secret in this app, which the client itself
// holds), so the browser must actually attach it for these requests to
// mean anything.
async function post(path, body) {
  const r = await fetch('/api/accounts' + path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.message || 'Request failed'), { status: r.status, code: data.error });
  return data;
}

export async function whoAmI() {
  const r = await fetch('/api/accounts/me', { credentials: 'same-origin' });
  return r.json();
}

// 2026-11-08 — the real-time username-availability check as the user
// types in the registration form. Plain GET, no credentials needed (this
// reveals nothing an actual registration attempt wouldn't already leak,
// and carries no account state) — the caller (tavern.js's own debounced
// input handler) is responsible for the ~300ms typing-pause debounce and
// for discarding a response that's no longer for the current input value
// (see usernameAvailability's own doc comment there for why a bare
// "last response wins" isn't enough once requests can race).
export async function checkUsernameAvailable(username) {
  const r = await fetch('/api/accounts/username-available?username=' + encodeURIComponent(username));
  return r.json();
}

export async function register({ username, password, confirmPassword, migrateGuest }) {
  return post('/register', { username, password, confirmPassword, migrateGuest });
}

export async function login({ username, password }) {
  return post('/login', { username, password });
}

export async function logout() {
  return post('/logout', {});
}

export async function resetPassword({ username, recoveryCode, newPassword, confirmNewPassword }) {
  return post('/reset-password', { username, recoveryCode, newPassword, confirmNewPassword });
}

export async function regenerateRecoveryCodes({ currentPassword }) {
  return post('/recovery-codes/regenerate', { currentPassword });
}
