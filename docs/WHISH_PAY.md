# Whish Pay (online payments in Lebanon)

**Status: not integrated.** `server/billing/whish.js` is a clearly-marked stub that returns "not available yet" so the rest of the system (billing routes, the `whish` payment route, tests) is ready the day you have access.

## What we do not know (verify with Whish Money before building)

* Whether a merchant API exists for your account type, its sandbox, authentication scheme, and webhook signing.
* Whether it supports **recurring/subscription** charges. Most Lebanese wallet providers do not: assume **prepaid periods** (1/3/6/12 months), which is exactly how the manual route already works.
* Settlement currency (USD "fresh" vs LBP), fees, and payout timing.

## The plan

1. Ask Whish Money for merchant API documentation and a sandbox.
2. Implement `createCheckout()` (redirect URL) and a webhook route that verifies their signature on the raw body, then calls `manual.recordPayment`-style logic via `billing/core.js` (`issueInvoice` + `activate`) with `provider: 'whish'` and the provider's transaction id as `providerRef` (the UNIQUE `(provider, provider_ref)` constraint makes webhooks idempotent).
3. Add tests with signed fake webhooks (copy the pattern in `tests/billing.test.js`).
4. Set `WHISH_PAY_ENABLED=true`.

Until then customers pay by Whish/OMT/bank transfer and you record it in the admin console in 20 seconds; the receipt PDF is emailed automatically.
