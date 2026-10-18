# HindujaOneJourney

Guided protection journey for employees of the group: **profile once →
personalised recommendation → customise → checkout** for Health, Travel,
Motor and Home insurance — plus a separate, drag-and-drop **admin console**
to change the journey without a redeploy.

```
backend/    Flask API: rules engine, config versions, auth, integration adapters (mock)
frontend/
  shared/     journey screens, admin builder, styles (used by both options)
  supabase/   Option 1 — portal.html + admin.html, Supabase sign-in
  ad/         Option 2 — portal.html + admin.html, Active Directory sign-in via backend
mockup/     original single-file clickable mockup (no backend; for demos only)
docs/       SETUP.md (run + both options), INTEGRATION.md (APIs + adapters)
```

- Customer portal: `/` · Admin console: `/admin` (own sign-in; can be deployed
  as a separate internal-only instance with `SERVE_SURFACES=admin`).
- Start here: [`docs/SETUP.md`](docs/SETUP.md).
- Integrating real systems (SOAP rating, HR data, KYC, payment, policy admin):
  [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

All rates, policy numbers and integrations are currently **mocks**.
Secrets live only in `backend/.env.dev` (gitignored); `backend/.env.dev.example`
is the template.
