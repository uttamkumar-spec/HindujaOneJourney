# Integration guide

The portal and admin console talk only to the Flask backend. Every upstream
system sits behind one adapter class in `backend/app/adapters.py`; today they
are all **mocks**. Replacing a mock with the real call changes nothing in the
routes or screens.

```
Browser ── portal  (/)       ─┐
Browser ── admin   (/admin)  ─┤  JSON over HTTPS
                              ▼
                   Flask backend (backend/app)
                   ├─ engine.py    rules, selection checks, config validation
                   ├─ store.py     config versions, leads, quotes, policies
                   ├─ auth.py      Supabase JWT  |  AD (LDAPS)  |  dev
                   └─ adapters.py  ─► HR/GMC profile   (MockProfileSource)
                                   ─► Rating (SOAP)    (MockRatingService)
                                   ─► KYC              (MockKyc)
                                   ─► Payment gateway  (MockPayments)
                                   ─► Policy admin     (MockPolicyAdmin)
```

## Adapters to replace

| Adapter | Method | Must return | Notes |
|---|---|---|---|
| `MockProfileSource` | `get(user)` | flat dict of prefill keys → values | Keys used by the default journey: see `SAMPLE` in the class. A journey field's `prefill` names one of these keys, so a new HR attribute = return a new key + map a field to it in the admin console. |
| `MockRatingService` | `quote(req)` | `{"lines":[{"code","name","premium"}], "premium": int}` | `req` = `productCode`, `proposer`, `members`, `travellers`, `vehicles`, `covers[{code, sumInsured, option}]`. Build the SOAP call from it — e.g. with the `zeep` library from the WSDL — map cover `code`s (editable in **Product catalogue**) to the service's codes, add WS-Security. GST is added by the backend from the catalogue's `gstPct`. |
| `MockKyc` | `verify(req)` | `{"status": "VERIFIED", ...}` | Called once per checkout before payment. |
| `MockPayments` | `charge(req)` | `{"status": "SUCCESS", "txnId": ...}` | The amount is recomputed server-side from stored quotes. A real gateway needs redirect + callback; see "Payment" below. |
| `MockPolicyAdmin` | `issue(req)` | `{"status": "Issued" \| "Processing", "policyNo": ...}` | One call per product. |

Plug a real class in through `Adapters(profile=..., rating=..., ...)` in
`create_app` (or `build` it from settings). Every call is recorded in the
in-memory call log shown in **Admin → Integration log**, with PAN, mobile and
e-mail masked.

The SOAP envelope shown in the log is **illustrative** (placeholder namespace
`urn:PLACEHOLDER:rating`) until the real WSDL is available.

## API (what the browser calls)

Portal (`/api`, signed-in employee):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/public-config` | Auth mode + Supabase URL/anon key (no sign-in needed) |
| POST | `/api/auth/login`, `/api/auth/logout` | AD / dev sign-in (Supabase signs in from the browser) |
| GET | `/api/me` | Current user |
| GET | `/api/journey-config` | Published journey **without the rules** |
| GET | `/api/profile/me` | Pre-filled values (profile adapter) |
| POST | `/api/recommendations` | `{profile}` → cards; stores a lead; server checks required fields |
| POST | `/api/quotes` | `{productId, selection}` → premium; selection validated against the catalogue |
| POST | `/api/checkout` | `{quoteIds, consents, kyc}` → KYC → payment → issuance; each quote usable once |
| GET | `/api/policies/me` | Employee's policies |

Admin (`/admin/api`, signed-in admin):

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/api/auth/login`, `/logout` | AD / dev admin sign-in |
| GET | `/admin/api/me` | Current admin |
| GET | `/admin/api/config` | Draft + live version info |
| PUT / DELETE | `/admin/api/config/draft` | Save (returns validation errors) / discard draft |
| POST | `/admin/api/config/publish` | Validate + publish draft as a new version (409 if someone published meanwhile) |
| GET | `/admin/api/config/versions[/<v>]` | History / one version |
| POST | `/admin/api/config/rollback` | Re-publish an older version |
| GET | `/admin/api/sample-profile` | Sample data for previews |
| POST | `/admin/api/preview/recommendations`, `/preview/quote` | Run the draft without publishing |
| GET | `/admin/api/activity`, `/admin/api/logs` | Recent leads/policies; integration call log |

All state-changing requests must carry the header `X-HOJ-Request: 1` (CSRF
protection for the cookie-based AD sessions).

## Payment (production)

The mock charges synchronously. A real gateway flow is: create order for the
server-computed amount → redirect / SDK → gateway callback to a new backend
endpoint → verify signature → issue policies → portal shows the wallet. Only
`MockPayments` and the checkout route change; the screens already handle a
"Processing" status.

## Open items for the business / IT

- Rating service WSDL, auth method, UAT endpoint; one vs many endpoints.
- Source of pre-filled employee data (HRMS API / GMC system / file).
- KYC, payment gateway and policy admin systems to call.
- On-prem AD (LDAPS) vs Microsoft Entra ID (would need OIDC instead of LDAP).
- Approval flow for publishing (today any admin can publish; maker-checker can be added).
- "Needs" step from the deck — content not defined, not built.
- Real GST treatment per product; real product/cover codes.
- Earlier this guide targeted a Java / Spring Boot backend. The Flask backend
  here is the working reference; if IT standardises on Spring Boot, the API
  table above is the contract to keep.
