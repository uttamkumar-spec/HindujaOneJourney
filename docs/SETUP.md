# Setup — two deployment options

Both options run the **same Flask backend** and the **same journey screens**.
They differ only in how people sign in:

| | Option 1 — Supabase | Option 2 — Active Directory |
|---|---|---|
| `AUTH_MODE` | `supabase` | `ad` |
| HTML pages | `frontend/supabase/portal.html`, `admin.html` | `frontend/ad/portal.html`, `admin.html` |
| Who creates accounts | You, in the Supabase dashboard | Your AD team (existing network accounts) |
| Where the password goes | Browser → Supabase | Browser → this backend → AD (LDAPS) |
| Who is an admin | Users with `app_metadata.role = "admin"` | Members of `LDAP_ADMIN_GROUP_DN` (nested groups count) |

URLs (same for both): **`/`** = customer portal, **`/admin`** = admin console.
Each has its own sign-in; signing in to the portal never opens the admin console.

## 1. Run locally

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.dev.example .env.dev        # then edit .env.dev — it is gitignored
python run.py                       # http://127.0.0.1:5000  and  /admin
python -m pytest                    # backend tests
```

Quick try without Supabase or AD: keep `AUTH_MODE=dev` and `APP_ENV=development`
and sign in with the users in `DEV_USERS`. Dev mode refuses to start outside
development.

## 2. Option 1 — Supabase

1. Create a Supabase project (or use an existing one).
2. In `.env.dev` set `AUTH_MODE=supabase`, `SUPABASE_URL` and `SUPABASE_ANON_KEY`
   (Project Settings → API). The anon/publishable key is public by design; the
   backend serves it to the browser. **Never** put the service-role key here.
3. `SUPABASE_JWT_SECRET`: leave empty if the project uses the newer asymmetric
   JWT signing keys (the backend fetches the public keys from
   `<SUPABASE_URL>/auth/v1/.well-known/jwks.json`). Set it only for a project
   still signing with the legacy HS256 secret.
4. Create employees: Dashboard → Authentication → Users → *Add user* (email +
   password). Consider turning off public sign-ups (Authentication → Providers →
   Email) so only accounts you create can sign in.
5. Make someone an admin — in the SQL editor:
   ```sql
   update auth.users
   set raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb
   where email = 'admin.person@yourcompany.com';
   ```
   They must sign out and in again for the new role to reach their token.
   `app_metadata` cannot be changed by the user themselves, unlike `user_metadata`.

> Please verify the dashboard menu names and the `auth.users` column name
> against the current Supabase docs — Supabase changes its UI from time to time.

## 3. Option 2 — Active Directory

1. In `.env.dev` set `AUTH_MODE=ad` and the `LDAP_*` values:
   - `LDAP_URL` — use **LDAPS** (`ldaps://dc.corp.example.com:636`); passwords must not cross the network in clear text.
   - `LDAP_UPN_SUFFIX` — appended to plain usernames (`jdoe` → `jdoe@corp.example.com`) for the bind.
   - `LDAP_BASE_DN` — where users are searched.
   - `LDAP_ADMIN_GROUP_DN` — the AD group whose members may use `/admin`.
   - `LDAP_PORTAL_GROUP_DN` — optional; restricts the customer portal to one group.
   - `LDAP_CA_CERT_FILE` — the CA that signed the domain controller's certificate, if not in the system store.
2. How sign-in works: the backend binds to AD **as the user** (no service
   account needed), looks up their display name / e-mail, checks group
   membership, then issues an HttpOnly, signed session cookie (8 hours).
   Empty passwords are rejected (an empty LDAP bind would otherwise succeed anonymously).
3. If the group uses **Microsoft Entra ID (Azure AD)** rather than on-premises AD,
   LDAP is usually not available — that needs an OIDC sign-in instead. Tell us and
   it can be added as a third `AUTH_MODE` without touching the screens.

## 4. Production checklist

- `APP_ENV=production`, a fresh random `SECRET_KEY`, `COOKIE_SECURE=true`, HTTPS only.
- Run with a WSGI server: `gunicorn -w 2 'app:create_app()'` (from `backend/`).
- **Separate the admin console**: run two instances of the same code —
  - public: `SERVE_SURFACES=portal` (no `/admin`, no admin API, no builder code is even served)
  - internal / VPN only: `SERVE_SURFACES=admin`
  Both point at the same database.
- Move `DATABASE_PATH` (SQLite) to the group's database before go-live; the
  schema in `backend/app/store.py` is plain SQL.
- Add login rate-limiting at the gateway / WAF.
- Replace the mock adapters (see `docs/INTEGRATION.md`).

## 5. How admin changes reach customers (no redeploy)

The HTML and JavaScript never contain the journey itself. On every page load
the portal fetches the **published** journey config from
`GET /api/journey-config` and draws the screens from it. In the admin console:

1. Edits save automatically to a **draft** (customers don't see it).
2. **Publish to customers** validates the draft and stores it as a new version.
3. The next time any customer loads the portal, they get the new version.
   Someone already mid-journey keeps the version they started with until they reload.
4. **Versions & publish → Roll back** re-publishes any earlier version the same way.

Recommendation rules are evaluated on the server and never sent to the browser.
Code changes (new kinds of screen components, new integrations) still need a
normal release; content, questions, rules, products and layout do not.
