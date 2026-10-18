/* Option 1 — Supabase login.
   Users are created in Supabase (Dashboard → Authentication → Users). Admins are
   users whose app_metadata.role is the backend's SUPABASE_ADMIN_ROLE (default "admin").
   The browser signs in with supabase-js and sends the access token to the Flask
   backend, which verifies it. Portal and admin keep separate sessions (storageKey). */
'use strict';
(function () {
  let client = null;
  window.HOJAuth = {
    idField: { label: 'Work email', type: 'email', autocomplete: 'username' },
    hint: 'Sign in with the account your administrator created for you.',
    async init(scope, pub) {
      if (!window.supabase || !pub.supabaseUrl || !pub.supabaseAnonKey) throw new Error('Supabase is not configured for this deployment.');
      client = window.supabase.createClient(pub.supabaseUrl, pub.supabaseAnonKey, {
        auth: { storageKey: 'hoj-' + scope + '-auth', persistSession: true, autoRefreshToken: true }
      });
    },
    async headers() {
      const { data } = await client.auth.getSession();
      return data.session ? { Authorization: 'Bearer ' + data.session.access_token } : {};
    },
    async signIn(scope, email, password) {
      const { error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw Object.assign(new Error(error.message === 'Invalid login credentials' ? 'Invalid email or password' : error.message), { status: 401 });
    },
    async signOut() { await client.auth.signOut(); }
  };
})();
