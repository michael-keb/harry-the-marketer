# smart-senders — visual verification

7 endpoint specs. Regenerate with `npm run gallery`.

> A capture proves the surface renders with real data. Whether each spec's
> acceptance criteria are met is the **Verdict** column, from
> [../../REQUIREMENTS-MATRIX.md](../../REQUIREMENTS-MATRIX.md).

## Captures

### Mailboxes — fleet, warm-up and sending infrastructure

Sendability with its reason, usage against the effective cap, and the senders procurement flow.

**desktop**

![Mailboxes — fleet, warm-up and sending infrastructure — desktop](./mailboxes.png)

## What the specs in this category are judged at

| Spec | Verdict | Notes |
|---|---|---|
| [Auto Generate Mailboxes](../auto-generate.md) | Not reviewed |  |
| [Get Purchased Domain List](../domain-list.md) | Not reviewed |  |
| [Get OTP for Admin Mailbox](../get-otp.md) | Not reviewed |  |
| [Get Vendors](../get-vendors.md) | Not reviewed |  |
| [Get Order Details](../order-details.md) | Not reviewed |  |
| [Search Domain](../search-domain.md) | Not reviewed |  |
| [Place Order](../place-order.md) | Partial | Idempotency is DB-enforced and real. Payment guard misses common spellings (credit_card, paypal_email) — nothing leaks, but the stated invariant is false. |
