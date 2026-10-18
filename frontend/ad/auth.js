/* Option 2 — Active Directory login (via the backend).
   The password goes only to the Flask backend over HTTPS, which binds to AD over
   LDAPS (settings in backend/.env.dev). The backend then sets an HttpOnly session
   cookie; nothing is stored in the browser. Portal and admin are separate sessions,
   and admin requires membership of LDAP_ADMIN_GROUP_DN. */
'use strict';
(function () {
  const base = scope => (scope === 'admin' ? '/admin/api/auth' : '/api/auth');
  async function post(url, body) {
    const res = await fetch(url, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-HOJ-Request': '1' }, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'Sign-in failed'), { status: res.status });
    return data;
  }
  window.HOJAuth = {
    idField: { label: 'Network username', type: 'text', autocomplete: 'username' },
    hint: 'Use your usual company network (Windows) username and password.',
    async init() {},
    async headers() { return {}; },           // the session cookie is sent automatically
    async signIn(scope, username, password) { await post(base(scope) + '/login', { username, password }); },
    async signOut(scope) { await post(base(scope) + '/logout'); }
  };
})();
