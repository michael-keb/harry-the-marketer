# utilities — visual verification

2 endpoint specs. Regenerate with `npm run gallery`.

> A capture proves the surface renders with real data. Whether each spec's
> acceptance criteria are met is the **Verdict** column, from
> [../../REQUIREMENTS-MATRIX.md](../../REQUIREMENTS-MATRIX.md).

## Captures

### Settings — clients, webhooks, suppression, providers

Never-contact list, webhook registry with its delivery log, agency clients, and the honest provider status.

**mobile**

![Settings — clients, webhooks, suppression, providers — mobile](./settings-mobile.png)

**desktop**

![Settings — clients, webhooks, suppression, providers — desktop](./settings.png)

## What the specs in this category are judged at

| Spec | Verdict | Notes |
|---|---|---|
| [Domain Block List Management](../domain-block-list.md) | Not reviewed |  |
| [Send Single Email](../send-single-email.md) | Deliberately not shipped | `POST /api/send/one-off` is the compose-screen backdoor Docs/README forbids. Exported as `sendSingleEmail()` for internal callers instead; parks a draft when approvals are on. |
