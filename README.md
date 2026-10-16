# HindujaOneJourney

Journey for our internal customers: employees of group companies get a guided
protection journey — **profile once → personalised recommendation → customise →
checkout** — for Health, Travel, Motor and Home insurance.

## Current state: clickable mockup

Open `mockup/index.html` in any modern browser (no install, no server, works
offline). Three modes from the top bar:

- **Customer journey** — the full flow from the UI deck: intro, protection
  profile (pre-filled family & assets), recommendation cards with "why
  recommended", customise (members, sum insured, add-ons, live premium),
  review & checkout (one or many products), KYC + consent + payment, policy
  wallet with next-best action. Mobile-responsive.
- **Workflow builder** — drag-and-drop editing of journey steps, profile
  questions, recommendation rules, product catalogue and per-screen layout,
  with live preview. Changes are saved in your browser; use Export/Import JSON
  to share them.
- **Integration console** — every backend call the journey makes, with
  request/response payloads, including an illustrative SOAP envelope for the
  rating call.

**Everything is mock data.** Rates, policy numbers, KYC, payment and the sample
employee are fake. Nothing leaves the browser.

## Path to production

Target stack: Java / Spring Boot backend + web front end. IT replaces the five
mock adapters with real calls — see [`docs/INTEGRATION.md`](docs/INTEGRATION.md)
for the endpoint contracts, the SOAP rating integration and the open items.
