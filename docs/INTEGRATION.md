# Integration guide — from mockup to production

The mockup (`mockup/index.html`) is built so that IT only has to replace
**adapters**. Screens never call external systems; they read one **journey
config** and call five backend endpoints. Everything below the endpoints is
IT's to implement in the Spring Boot service.

```
Browser (journey UI + workflow builder)
   │  JSON over HTTPS
   ▼
Spring Boot backend  ── /api/v1/journey-config   (config store, versioned)
   │                 ── /api/v1/profile/me       → HRMS / GMC system
   │                 ── /api/v1/quotes           → Rating service (SOAP)
   │                 ── /api/v1/kyc/verify       → KYC service
   │                 ── /api/v1/payments         → Payment gateway
   │                 ── /api/v1/policies         → Policy admin system
```

> All endpoint paths and payloads below are a **proposal** derived from the
> mockup, not an existing API. Field names on the upstream side (HRMS, SOAP
> WSDL, gateway) must come from those systems' real specs.

## 1. Journey config — `GET /api/v1/journey-config`

The whole journey (steps, screen layouts, profile questions, rules, product
catalogue) is one JSON document. Its shape is exactly `DEFAULT_CONFIG` in
`mockup/index.html`; "Export JSON" in the builder downloads it.

Production needs:
- `GET /api/v1/journey-config` — returns the **published** version.
- `PUT /api/v1/admin/journey-config/draft` + `POST …/publish` — builder saves a
  draft; a second person publishes (maker-checker, if the business wants it).
- Store every version (who, when) so a bad change can be rolled back.
- The builder must sit behind admin login; customers only get the GET.

Replace in mockup: `loadConfig()` / `saveConfig()`.

## 2. Employee profile — `GET /api/v1/profile/me`

Response: `{ employeeId, values: { "<key>": value, … } }` — flat keys.
Each profile field in the config has a `prefill` key (e.g.
`gmc.sumInsuredLakh`) that is looked up in `values`. Adding a new pre-filled
attribute = backend returns a new key + builder maps a field to it. No UI code.

Keys the mockup uses: see `PREFILL_KEYS` in `mockup/index.html`.

Upstream source: **to be confirmed** (HRMS API / GMC policy system / file).
Identity comes from the login session — never from a query parameter.

Replace in mockup: `Adapters.profile.call`.

## 3. Rating — `POST /api/v1/quotes` (SOAP behind it)

Called once per selected product, and again whenever the customer changes
members, sum insured, options or add-ons on the Customise screen.

Request (UI → backend):
```json
{
  "productCode": "HEALTH",
  "proposer": { "name": "…", "age": 37, "pincode": "400001" },
  "members":  [ { "relation": "Self", "age": 37 }, { "relation": "Spouse", "age": 35 } ],
  "travellers": 3,
  "vehicles": [ { "type": "2W", "reg": "MH 01 AB 1234" } ],
  "covers": [ { "code": "HLT-RETAIL", "sumInsured": 10, "option": "Recommended plan" } ]
}
```
Response (backend → UI):
```json
{ "quoteId": "…", "productCode": "HEALTH",
  "lines": [ { "code": "HLT-RETAIL", "name": "Retail Health", "premium": 21375 } ],
  "premium": 35906, "gst": 0, "total": 35906, "currency": "INR", "validTill": "YYYY-MM-DD" }
```

Backend responsibilities:
1. Generate a SOAP client from the rating service's WSDL (common options in
   Spring Boot: Apache CXF's `cxf-codegen-plugin`, JAX-WS `wsimport`, or Spring
   Web Services `WebServiceTemplate` with JAXB classes — pick per your
   standards and verify current versions).
2. Map `productCode` / cover `code` values (editable in the builder's Product
   catalogue tab) to the rating service's product/cover codes.
3. Add WS-Security / certificates as the service requires. Credentials live in
   the backend's secret store, never in the UI or the config JSON.
4. **Tax is computed by the backend/rating service, not the UI.** The
   catalogue's `gstPct` exists only so the mockup can show a number. Verify the
   current GST treatment for each product with Finance before go-live.
5. Return the `quoteId`; payment and issuance must reference it so the
   customer pays the quoted premium (re-validate server-side; never trust a
   premium sent back from the browser).
6. Timeouts + a clear error → the UI already shows "Rating service
   unavailable — please retry".

The SOAP envelope shown in the Integration console is **illustrative only**
(placeholder namespace `urn:PLACEHOLDER:rating`).

Replace in mockup: `Adapters.rating.call` (the `MOCK_RATES` formulas are fake
numbers for demo only and must be deleted).

## 4. KYC — `POST /api/v1/kyc/verify`

Request `{ pan, mobile, email }` → `{ status: "VERIFIED" | "FAILED" | …, kycRef }`.
Called before payment. Upstream: **to be confirmed**.

## 5. Payment — `POST /api/v1/payments`

Request `{ amount, currency, orderRef, products[] }` → `{ status, txnId }`.
In production this becomes: create order → redirect/SDK to gateway → gateway
callback to backend → backend confirms → UI polls/receives result. The amount
must be recomputed server-side from the stored `quoteId`s.

## 6. Policy issuance — `POST /api/v1/policies`

One call per product (each policy is issued independently):
`{ productCode, quoteId, paymentTxn }` → `{ policyNo | null, status: "Issued" | "Processing" }`.
The wallet screen shows `Processing` with "Track status" for non-instant cases.

## What is configurable without code (builder)

| Builder tab | Controls |
|---|---|
| Journey steps | Order, enable/disable, titles, "Step x of y" counting (with ordering warnings) |
| Profile questions | Sections, fields, type, pre-fill key, required, show-if conditions |
| Recommendation rules | Conditions → product + tag + "why recommended" text, priority by drag |
| Product catalogue | Products, covers, codes sent to rating, amount/option lists, defaults |
| Screen layout | Which components appear on each screen, in what order, with what text |

Not configurable (code): the components themselves, the adapter calls, and
derived values (`family_count`, `vehicle_count`).

## Open items for the business / IT

- Rating service WSDL, auth method, UAT endpoint, one vs many endpoints.
- Source of pre-filled employee data and how employees log in (SSO / OTP / portal session).
- KYC, payment gateway and policy admin systems to call.
- "Needs" step: shown as a tab in the deck but its content isn't defined — not built.
- Who may edit and who may publish journey config.
- Real GST treatment per product; real product/cover codes.
