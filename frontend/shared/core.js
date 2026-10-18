/* HindujaOneJourney — shared core (portal + admin).
   - h(): tiny DOM builder
   - api(): fetch wrapper (adds auth + CSRF header, JSON in/out)
   - test()/context(): same semantics as backend/app/engine.py (used only for
     "show only if" on fields; recommendation rules run on the server)
   - login screen + boot. The login method itself comes from /assets/auth.js
     (Supabase or Active Directory), which defines window.HOJAuth. */
'use strict';
(function () {
  const HOJ = (window.HOJ = window.HOJ || {});

  HOJ.h = function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const c of kids.flat(Infinity)) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : document.createTextNode(String(c))); }
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    return el;
  };
  HOJ.clone = o => JSON.parse(JSON.stringify(o));
  HOJ.inr = n => '₹ ' + Math.round(n).toLocaleString('en-IN');
  HOJ.coerce = v => v === true || v === false ? v : v === 'true' ? true : v === 'false' ? false : (v !== '' && v != null && !isNaN(+v)) ? +v : v;
  HOJ.test = function (c, ctx) {
    const a = HOJ.coerce(ctx[c.field]), b = HOJ.coerce(c.value);
    switch (c.op) { case '==': return a === b; case '!=': return a !== b; case '<': return +a < +b; case '<=': return +a <= +b; case '>': return +a > +b; case '>=': return +a >= +b; }
    return false;
  };
  HOJ.ages = s => String(s || '').split(',').map(x => +x.trim()).filter(x => x > 0);
  HOJ.context = function (p) {
    const nChild = Math.max(0, Math.floor(+p.children_count || 0)), parents = p.has_parents === true ? (HOJ.ages(p.parent_ages).length || 2) : 0;
    return { ...p, family_count: 1 + (p.has_spouse === true ? 1 : 0) + nChild + parents, vehicle_count: (p.own_2w === true ? 1 : 0) + (p.own_4w === true ? 1 : 0) };
  };
  HOJ.shown = (o, ctx) => !o.showIf || HOJ.test(o.showIf, ctx);

  class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
  HOJ.ApiError = ApiError;
  HOJ.api = async function (path, { method = 'GET', body } = {}) {
    const headers = { 'X-HOJ-Request': '1', ...(await window.HOJAuth.headers()) };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try { res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); }
    catch (e) { throw new ApiError('Network error — check your connection', 0); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && HOJ.onSignedOut) HOJ.onSignedOut();
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    return data;
  };

  /* ---------------------------------------------------------- login */
  function loginScreen(root, scope, onDone, notice) {
    const h = HOJ.h, A = window.HOJAuth, isAdmin = scope === 'admin';
    let busy = false, error = notice || '', idVal = '';
    const draw = () => {
      const idInput = h('input', { id: 'login-id', type: A.idField.type, autocomplete: A.idField.autocomplete, required: true, value: idVal });
      const pwInput = h('input', { id: 'login-pw', type: 'password', autocomplete: 'current-password', required: true });
      root.replaceChildren(h('main', { class: 'login-wrap' + (isAdmin ? ' admin' : '') },
        h('form', { class: 'login card', onsubmit: async e => {
          e.preventDefault(); if (busy) return;
          idVal = idInput.value.trim(); busy = true; error = ''; btn.disabled = true; btn.textContent = 'Signing in…';
          try { await A.signIn(scope, idInput.value.trim(), pwInput.value); const u = await HOJ.currentUser(scope); if (!u) throw new Error('Sign-in failed'); onDone(u); }
          catch (err) { if (err.status === 403) await A.signOut(scope).catch(() => {}); error = err.message || 'Sign-in failed'; busy = false; draw(); }
        } },
          h('div', { class: 'logo' }, 'IndusInd', h('small', null, isAdmin ? 'JOURNEY ADMIN CONSOLE' : 'GENERAL INSURANCE')),
          h('h1', null, isAdmin ? 'Admin sign in' : 'Employee sign in'),
          h('p', { class: 'muted' }, isAdmin ? 'For authorised journey administrators only.' : A.hint),
          error && h('div', { class: 'alert', role: 'alert' }, error),
          h('label', { class: 'field', for: 'login-id' }, h('span', { class: 'lbl' }, A.idField.label), idInput),
          h('label', { class: 'field', for: 'login-pw' }, h('span', { class: 'lbl' }, 'Password'), pwInput),
          (btn = h('button', { class: 'btn', type: 'submit' }, 'Sign in')))));
      (idVal ? pwInput : idInput).focus();
    };
    let btn; draw();
  }

  HOJ.currentUser = async function (scope) {
    try { return (await HOJ.api(scope === 'admin' ? '/admin/api/me' : '/api/me')).user; }
    catch (e) { if (e.status === 401) return null; throw e; }
  };
  HOJ.signOut = async function (scope) { await window.HOJAuth.signOut(scope).catch(() => {}); location.reload(); };

  HOJ.fatal = function (root, msg) { root.replaceChildren(HOJ.h('main', { class: 'login-wrap' }, HOJ.h('div', { class: 'login card' }, HOJ.h('h1', null, 'Unavailable'), HOJ.h('p', null, msg)))); };

  async function boot() {
    const root = document.getElementById('app'), scope = document.body.dataset.app;
    try {
      const pub = await fetch('/api/public-config').then(r => r.json());
      await window.HOJAuth.init(scope, pub);
      // Session expiry while the app is running (any 401) returns to the sign-in screen.
      const signedOut = () => { HOJ.onSignedOut = null; loginScreen(root, scope, start, 'Your session has ended — please sign in again.'); };
      const start = u => { HOJ.onSignedOut = signedOut; (scope === 'admin' ? HOJ.Admin.start : HOJ.Portal.start)(root, u); };
      let user = null;
      try { user = await HOJ.currentUser(scope); }
      catch (e) { if (e.status === 403) { await window.HOJAuth.signOut(scope).catch(() => {}); } else throw e; }
      if (user) start(user); else loginScreen(root, scope, start);
    } catch (e) { HOJ.fatal(root, e.message || 'Could not start the application.'); }
  }
  document.addEventListener('DOMContentLoaded', boot);
})();
