# SMSFlow API — reference as captured

Captured from https://smsflow.com.au/api and the account's Developer Settings page
(SMSFlow dashboard → Account → Developers) on 2026-09-01. Kept here because the
public page is unversioned and has already changed once. Secrets are redacted:
the live API key lives in `.env` as `SMSFLOW_API_KEY`, nowhere else.

What Harry uses today, and where:

| Endpoint | Harry |
|---|---|
| `POST /sms/send` | `smsflowSendSms` in `server/channels/smsflow.js` |
| `GET /sms/status/{message_id}` | `smsflowMessageStatus`; polled by the `sms_receipts` upkeep job and Connections → *Fetch receipts* |
| `GET /account/balance` | `smsflowBalance`; Connections → *Check balance* |
| Webhook URL (Developer Settings) | `POST /api/hooks/smsflow/sms?token=…` in `server/channels/webhook.js` |
| Contacts / groups | not used — Harry keeps its own leads |

## Developer Settings

- **API Access Key** — one per account. Paste into `.env` / Settings → Connections. Redacted here.
- **Webhook URL** — one field for the whole account, not one per number. It must be
  the URL Harry shows on Connections (`{APP_URL}/api/hooks/smsflow/sms?token=<derived>`).
  The token is an HMAC of the API key, **not** the key itself; the field was once
  saved with the raw key and a `localhost` host, which is why nothing arrived
  (see [diagnosis-report-2026-09-01.md](diagnosis-report-2026-09-01.md)).
- Zapier integration is offered; not relevant to Harry.

## Basics

- Base URL: `https://api.smsflow.com.au/v2`
- Auth: `Authorization: Bearer <API key>` on every request; `Content-Type: application/json` on POSTs.
- Rate limit: soft 10 requests/second. Back off exponentially on retries.
- Timestamps are `YYYY-MM-DD HH:mm:ss`; `meta.timezone` on send responses says which zone (UTC in the sample).

## Send SMS — `POST /sms/send`

Body:

| Field | Type | Required | Notes |
|---|---|---|---|
| `to` | string | yes | E.164, e.g. `+61404123456` |
| `contact_id` | string | no | SMSFlow contact id, instead of `to` |
| `from` | string | no | Registered Sender ID, pool id, or dedicated number |
| `body` | string | yes | Documented max 160 chars (70 Unicode); longer bodies are accepted and billed as several credits |
| `callback_url` | string | no | Receives status webhooks for this message |
| `reference` | string | no | Free text for reporting (Harry sends `harry`) |
| `delay` | int | no | Minutes to hold before sending |
| `send_at` | string | no | `YYYY-MM-DD HH:mm:00` |
| `send_at_timezone` | string | no | Zone for `send_at`; defaults to the account setting |

Response `200`:

```json
{
  "meta": { "timezone": "UTC" },
  "data": [{
    "status": "queued",
    "message_id": "3c01905a518d4450b27a134fa0052950",
    "attributes": {
      "body": "…", "number": "0404 123 456", "to": "+61404123456",
      "contact": "<contact id>", "queue_time": "2026-09-01 11:07:41",
      "credits_used": 1, "warnings": ["…"]
    }
  }]
}
```

`data` is an array in the sample (and the sample's JSON is malformed — an array
literal containing bare key/value pairs). Harry's parser accepts an array, an
object, or `data.messages`.

## Message status — `GET /sms/status/{message_id}`

Query: `include_message=true` to get the original body back.

Response `200`:

```json
{
  "status": "Sent and confirmed from carrier",
  "destination": "+61404123456",
  "originator": "+61444123456",
  "delivery_time": "2026-09-01 11:07:41",
  "credits_used": 1,
  "encoding": "GSM_7BIT",
  "message": "Original message that was sent"
}
```

`status` is free text. Harry folds it with `mapSmsflowStatus`: anything with
*fail / error / reject / expired / denied / undeliver* → `failed`; *deliver /
confirm* → `delivered`; *sent / queued / pending / accepted* → `sent`.

## Account balance — `GET /account/balance`

```json
{
  "account_id": "acc_001b2c3d4e5f6g",
  "credit_balance": 12500,
  "last_purchase_date": "2026-09-01 11:07:41"
}
```

## Contacts and groups (not used by Harry)

- `GET /contacts?offset=0&limit=50` — max `limit` 200. Fields: `contact_id`, `first_name`, `last_name`, `phone_number`, `email`, `postcode`, `source`, `dimension_1`, `dimension_2`, `opted_out` (0/1), `external_id`, `notes`, `created_at`, `updated_at`.
- `PUT /contacts/external_id/{external_id}` — upsert by your id (max 50 chars). `first_name`, `last_name`, `phone_number` required on create; phone must be an Australian mobile. Returns `200` on update, `201` on create, with `contact_id` and `warnings`.
- `GET /groups` — `group_id`, `group_name`, `group_desc`, `contact_count`.
- `GET /groups/members/{group_id}` — the group plus its `contacts` array (same contact shape).

Page footer says "API Version 1.1" while the base path says `v2`. Treat the path as authoritative.
