# SMSFlow ↔ Harry — End-to-end diagnosis

**When:** 2026-09-01, last check 22:24 AEST  
**What you asked:** why texts show in SMSFlow but not in Harry  
**Verdict:** The phone is talking to SMSFlow. SMSFlow is **not** talking to Harry except for one lucky hit. Harry is not talking to the phone at all.

---

## One-line answer

SMSFlow **Inbox** is the source of truth for inbound SMS. Harry only sees a message if SMSFlow can **POST** it to a public URL that still reaches `localhost:8130`. That URL has been a free localhost.run tunnel whose hostname keeps changing. After it changed, SMSFlow kept the texts and Harry never heard about them.

You are hooked into Harry **in code**. You are **not** hooked in production-like operation, because the webhook host SMSFlow calls is a disposable laptop tunnel.

---

## The pipe (every hop)

```
Your phone  +61422754149
        │  SMS over the carrier
        ▼
SMSFlow number  +61485937338
        │  stored in SMSFlow Inbox  ← YOU ARE HERE (8 messages, all unread)
        │
        │  HTTP POST Webhook URL
        ▼
localhost.run  (https://????.lhr.life)
        │  hostname rotates every few minutes
        ▼
Harry API  127.0.0.1:8130
        /api/hooks/smsflow/sms?token=<hmac>
        ▼
SQLite  data/harry-the-marketer.db
        ▼
Harry Inbox  http://localhost:8131/app/inbox
```

| Hop | Status | Evidence |
|-----|--------|----------|
| 1. Phone → SMSFlow | **Works** | SMSFlow Inbox, 1 Sep 21:15–22:21, 8 rows from Michael Keb (`Hi`, `testing butt crack`, `Hello there`, …). Credits 47. |
| 2. SMSFlow → public webhook | **Broken** | SMSFlow will POST to whatever is in Developers → Webhook URL. That field has been `localhost`, then a dead `bc91a1…` host, then `370a55…`, then we asked you to switch to `a7a5fe…`. Free `lhr.life` names rotate. |
| 3. Tunnel → Harry `:8130` | **Works only while that exact host is live** | Curl to a live `*.lhr.life/api/health` returns Harry. Curl to a rotated host returns empty / `no tunnel here`. |
| 4. Harry webhook handler | **Works** | `POST /api/hooks/smsflow/sms?token=<webhook-token>` with JSON `{from,to,body}` returns 200 and inserts a row. That is how `diag tunnel probe` got into Harry. |
| 5. SMSFlow payload → Harry (live) | **Worked once** | `Hello there` at **22:04:35 AEST** is in **both** SMSFlow Inbox and Harry (`created_at` 12:04:35 UTC). Same second. That was a real webhook while `bc91a1e0b874a6.lhr.life` was still up. |
| 6. Later phone texts → Harry | **Failed** | `testing butt crack` (22:05:18), `Hi` (22:18:35, 22:21:58) are in SMSFlow only. Harry’s newest real inbound is still `Hello there`. |
| 7. Harry Inbox → phone | **Not hooked** | Reply `hi mate` used sandbox account `+61400000100`. Sandbox does not call SMSFlow. Phone never got it. SMSFlow Sent count stayed ~1. |
| 8. Campaign → phone | **Never sent** | Campaign paused (`mailbox missing`) then quiet hours (after 21:00 Sydney) then lead `needs_attention`. Zero Harry rows from `+61485937338` outbound. The `mailbox missing` pause and the sandbox-account pick are both **fixed in code** — see the addendum. |

SMSFlow’s **Dashboard** chart showing Received: 0 is misleading. The **Inbox** page is the real inbound log. Use Inbox, not the dashboard bars.

---

## Message-by-message (SMSFlow Inbox vs Harry)

Times on the left are SMSFlow **Received At** (Sydney). Harry timestamps are UTC (Sydney = UTC+10).

| SMSFlow Inbox | Harry? | Why |
|---------------|--------|-----|
| 22:21:58 `Hi` | **No** | Webhook host already rotated / not the URL SMSFlow is calling |
| 22:18:35 `Hi` | **No** | Same |
| 22:05:18 `testing butt crack` | **No** | 43 seconds after the one success; tunnel already failing |
| **22:04:35 `Hello there`** | **Yes** (Harry id 5, 12:04:35 UTC) | **Only live end-to-end inbound this session** |
| 22:01:31 `Hello` | No (not as a live row) | Tunnel/URL wrong |
| 21:54:26 `Hi` | No | Tunnel/URL wrong |
| 21:50:15 `Hello` | Backfill only | Harry id 3 is a **manual backfill** at 11:51:48 UTC, not this webhook |
| 21:15:32 `Yes ok` | Backfill only | Harry id 2 is a **manual backfill** at 11:51:26 UTC, not this webhook |

Harry rows that are **not** from your phone:

| Harry id | Body | What it actually is |
|----------|------|---------------------|
| 1 | test ping from curl | Local test, to sandbox number |
| 4 | live test now | Curl through tunnel |
| 6 | hi mate (out) | Inbox reply via **sandbox** — not on the carrier |
| 7–8 | diag … probe | Curl probes from this diagnosis |

So: **8 in SMSFlow Inbox, 1 live copy in Harry** (`Hello there`). The rest of Harry’s SMS list is tests and backfills.

---

## What “hooked into Harry” actually is

Harry does **not** log into SMSFlow and pull Inbox. There is no sync job. The only join is:

**SMSFlow Developers → Webhook URL** must be a public HTTPS URL that POSTs JSON to:

```
https://<reachable-host>/api/hooks/smsflow/sms?token=<webhook-token>
```

Handler: `server/channels/webhook.js` (`smsflowRouter.post('/sms')`), mounted in `server/index.js` at `/api/hooks/smsflow`.

The token is **not** the API key. It is:

```
HMAC-SHA256(SMSFLOW_API_KEY, "smsflow-webhook").hex.slice(0, 32)
= <webhook-token>   (redacted — derived from the live SMSFLOW_API_KEY)
```

Harry **Settings → Connections** copies:

```
http://localhost:8131/api/hooks/smsflow/sms?token=…
```

because `APP_URL=http://localhost:8131`. SMSFlow’s servers cannot open your laptop. That copy button is wrong for local inbound.

`callback_url` on send (`smsflow.js`) is also built from `APP_URL`, so delivery receipts would also go to localhost. Unrelated to inbound, but the same misconfig.

---

## Why the webhook keeps missing

1. **Localhost.run free domains rotate.** Same SSH session advertised `370a55d79ce5e3.lhr.life` then `a7a5fe232fb883.lhr.life`. SMSFlow does not follow the new name. It keeps POSTing to the URL you last Saved. Failed POSTs stay in **their** Inbox; Harry never gets a second chance unless SMSFlow retries (it did not, for the later `Hi`s).
2. **An earlier tunnel was started as `ssh … | head -40`.** After the banner, `head` exited and the tunnel died (`no tunnel here`) while looking “still running”.
3. **Two SSH forwards** to port 80 on localhost.run at once make the hostname even less stable.
4. **The earliest saved value was doubly wrong.** The Developer Settings capture (now [smsflow-api-reference.md](smsflow-api-reference.md), key redacted) shows the field held `http://localhost:8131/api/hooks/smsflow/sms?token=pGsqIl…` — localhost host **and** the raw **API key** as the token. Verified against the live handler: that token returns 403 `invalid_token`, so even a reachable host would have inserted nothing. The `Hello there` success at 22:04:35 proves the field later held the correct host **and** the derived token — so the confirmed killer for the later texts is the **host rotating**, not the token. Still worth a glance after every paste: click in the field, press End, confirm it ends with `d4640eb665d1`.

Harry’s API is up (`:8130`, `smsflow: true`). The break is **between SMSFlow and that port**, not inside the Inbox UI.

---

## Outbound (Harry → phone) — separate break

Even with a perfect inbound webhook, **Reply in Harry Inbox on the old thread does not text the phone.**

- First inbound test went to sandbox `+61400000100`.
- Thread key `sms:1:+61422754149` owns the conversation.
- Inbox sends with that account. Sandbox `twilioSendSms` returns a fake id and does **not** call `api.smsflow.com.au`.
- The other Harry thread (`SMS · via +61485937338`) is the real sender. A reply **there** would call SMSFlow. Campaign send would too, if it ran.

SMSFlow API from this machine: **OK** (Bearer key, 47 credits). Harry has simply not used it for a recorded outbound.

Campaign 2 is `running` but the lead is `needs_attention` (reply classified `other`; playbook has no `other` edge). Workspace window 08:00–21:00 Sydney — it is after 21:00, so the engine will not send until morning anyway.

---

## What would make this e2e green

**Inbound (phone → Harry Inbox)**

1. Stop using rotating `*.lhr.life` hosts, **or** paste the current live host into SMSFlow immediately after every rotation.
2. Stable options, in order:
   - Point SMSFlow at **production**: `https://harrythemarketer.com/api/hooks/smsflow/sms?token=<production token>` (token differs if Render’s API key differs).
   - Paid/reserved tunnel (ngrok reserved domain, localhost.run account) so the hostname does not change.
   - `APP_URL` for local must be that public origin, not `http://localhost:8131`, so Settings copies a URL SMSFlow can call.
3. After the URL is stable: text `+61485937338` once. A new row should appear in Harry within seconds on thread `sms:2:+61422754149`. SMSFlow Inbox will also show it (as tonight).

**Outbound (Harry → phone)**

1. Do not reply on the sandbox thread (`+61400000100` / `hi mate`).
2. Settings → Connections → **SMSFlow (env)** → Test send to `+61422754149`, **or** reply on the thread labelled `SMS · via +61485937338`.
3. ~~Detach sandbox from campaign 2 so live traffic cannot pick it.~~ Now defence-in-depth only: `smsAccountFor` orders sandbox accounts last (see addendum), so campaign 2 picks the live SMSFlow account. Detaching is still tidier.

SMSFlow will **not** backfill the missed `Hi` / `testing butt crack` into Harry. Those exist only in SMSFlow unless we insert them by hand. New texts after a working webhook will flow.

---

## Current live webhook

**Re-checked 22:28 AEST: `a7a5fe232fb883.lhr.life` is dead** (`no tunnel here`). An ssh tunnel process from 22:27 is still running, but its output went to a closed shell, so its current hostname is unrecoverable — it is useless. Kill it and start one whose output you can read:

```bash
pkill -f 'ssh.*-R 80:127.0.0.1:8130.*localhost.run'
```

```bash
nohup ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes -R 80:127.0.0.1:8130 nokey@localhost.run > /tmp/lhr-tunnel.log 2>&1 &
```

```bash
sleep 6 && grep -oE '[a-z0-9]+\.lhr\.life' /tmp/lhr-tunnel.log | tail -1
```

Then confirm the host answers before pasting into SMSFlow:

```bash
curl -sS https://<that-host>.lhr.life/api/health
```

If it returns `"ok":true`, paste:

```
https://<that-host>.lhr.life/api/hooks/smsflow/sms?token=<webhook-token>
```

When texts stop arriving again, `tail /tmp/lhr-tunnel.log` — a new hostname line means it rotated and SMSFlow needs the new paste. This is the whole bug; a reserved domain or production URL is the only real cure.

---

## Session outcome

| Question | Answer |
|----------|--------|
| Are you hooked into SMSFlow? | Yes: API key, from-number, webhook route, token. |
| Are phone texts reaching SMSFlow? | **Yes.** Inbox 8 / unread. |
| Are those texts reaching Harry? | **No**, except `Hello there` at 22:04:35. |
| Why? | Webhook URL is a laptop tunnel that SMSFlow cannot keep; later POSTs never arrive. Harry does not pull Inbox. |
| Can Harry send to the phone? | API can. Inbox reply path used sandbox, so **no** real send yet. |

Nothing in Harry’s SMS parser is required to explain tonight’s gap: SMSFlow already has the bodies, and Harry never received the HTTP call.

---

## Addendum — re-verified and partially fixed, 22:30 AEST

Every checkable claim above was re-verified against the code and the live database:

- **Token derivation** — `HMAC-SHA256(key, "smsflow-webhook").hex.slice(0,32)` over the current API key computes exactly `b1c325b47d431cb7f41ad4640eb665d1` (`server/channels/smsflow.js`, `smsflowWebhookTokenFromKey`). ✓
- **Database rows** — the 8 SMS message rows, both channel accounts (id 1 sandbox `+61400000100`, id 2 smsflow `+61485937338`), campaign 2 `running` / lead `needs_attention` all match the tables above. ✓
- **Handler behaviour** — live probes against `127.0.0.1:8130`: the raw API key as token → 403 `invalid_token`; the derived token with an empty payload → 400 `missing_message` (i.e. auth passes). ✓
- **Tunnel** — `a7a5fe232fb883.lhr.life` returns `no tunnel here`. The surviving ssh process's hostname is unrecoverable; replacement procedure is in “Current live webhook” above.

**Code fixes now in the working tree** (uncommitted; all 1467 server tests pass, including a new regression test):

| File | Fix | Report item it closes |
|------|-----|----------------------|
| `server/engine.js` | SMS-only campaigns (`channel_mode = 'sms'`) no longer get paused with `mailbox missing`; the mailbox bounce-brake and inbound email sync are skipped when there is no mailbox. | Hop 8 first failure — the campaign will no longer re-pause on its next tick. |
| `server/channels/send.js` | `smsAccountFor` orders sandbox accounts last, so a campaign with both sandbox and live accounts attached (campaign 2 has both) picks the live SMSFlow sender. | Outbound fix 3 — sandbox can no longer swallow live campaign sends. |
| `tests/channels-sms.test.js` | New test: an SMS-only campaign with no mailbox stays `running` and actually sends. | Regression guard for both. |

**Still outstanding (needs you, not code):**

1. A stable public webhook host — production URL or reserved tunnel domain — pasted into SMSFlow Developer Settings. Until then, re-paste after every rotation (procedure above).
2. One live outbound to prove Harry → phone: reply on the `SMS · via +61485937338` thread or use Settings → Test send. Note it is before 08:00 / after 21:00 Sydney quiet hours for campaign sends.
3. The lead on campaign 2 is `needs_attention` (reply classified `other`, no `other` edge in the playbook) — resolve it in the leads board or add the edge, or the campaign will not advance even once sending works.
4. The missed texts (`Hi` ×2, `testing butt crack`) exist only in SMSFlow; backfill by hand if you want them in Harry.
