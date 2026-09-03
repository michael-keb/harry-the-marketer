# Bug report to SMSFlow — inbound webhook not firing for every message

**Status:** draft, ready to send via https://smsflow.com.au/contact (no support email published; the form is their channel).
**Before sending:** fill in the two `[confirm …]` placeholders with the exact times you sent the texts from your phone (Messages app shows them).

---

## Email / contact-form text

**Subject: Inbound SMS webhook fires for some messages but not others (same URL, endpoint verified up)**

Hi SMSFlow team,

We're integrating your inbound SMS webhook and are seeing messages arrive in our SMSFlow Inbox without the corresponding webhook POST ever reaching our endpoint. The endpoint is public, stable, and verified working — some messages trigger the webhook and others, minutes or seconds apart, do not.

**Account details**

- Organisation: Praxis / Harry The Marketer (account holder: Michael Keb)
- Dedicated number: +61485937338
- Webhook URL (Developer Settings): `https://harrythemarketer.com/api/hooks/smsflow/sms?token=…665d1` (happy to confirm the full URL privately)
- All test messages sent from: +61422754149

**What happens**

On 2 September (AEST), with the webhook URL set to our production HTTPS endpoint and unchanged throughout:

1. Text 1 ("Hi"), sent ~[confirm time, ~23:00] — appeared in the SMSFlow Inbox **and** your webhook POSTed it to us. Received and processed fine.
2. Text 2, sent a few minutes later [confirm time] — appeared in the SMSFlow Inbox, but **no webhook POST ever arrived** at our endpoint.

Nothing changed on our side between the two messages. To rule ourselves out, we POSTed two synthetic payloads to our own endpoint 5 seconds apart immediately afterwards — both returned HTTP 200 in well under a second and were processed. Our server logs show no incoming request from SMSFlow for text 2 at all (no 4xx/5xx — no connection).

We also saw the same pattern on 1 September: a message at 22:04:35 fired the webhook, while the next one at 22:05:18 (43 seconds later, same sender, same number) never did.

**Questions**

1. Is the inbound webhook expected to fire once per received message, or is there any coalescing/suppression when several messages arrive from the same sender in a short window?
2. Does SMSFlow retry webhook deliveries on failure? If so, on what schedule?
3. Can you check your webhook delivery logs for +61485937338 on 2 September ~23:00–23:15 AEST and tell us what happened to the delivery for the second message — was a POST attempted, and if so what response did you record?
4. Is there any way for us to see webhook delivery attempts/failures ourselves (a log in the dashboard, or an API)?

Reliable inbound delivery is the one thing we need from the webhook — happy to jump on a call or provide request logs from our side if useful.

Thanks,
Michael Keb
michael@praxis-au.com

---

## Supporting evidence (internal, keep out of the email unless asked)

- Endpoint: `POST /api/hooks/smsflow/sms` on https://harrythemarketer.com (Render, Singapore). Health-checked, TLS valid, responds < 1 s.
- 2 Sep ~23:0x AEST: Harry recorded exactly one live SMSFlow POST (body "Hi"). Two synthetic probes ("diag probe A"/"B", 5 s apart) both inserted fine seconds later — endpoint and rapid-succession handling proven.
- 1 Sep session (see [diagnosis-report-2026-09-01.md](diagnosis-report-2026-09-01.md)): 8 messages in SMSFlow Inbox, exactly 1 live webhook delivery ("Hello there", 22:04:35). The 22:05:18 miss happened 43 s after that success — the tunnel-host rotation explains the *later* misses that night but is weak as an explanation for one 43 s later.
- Caveat we've been honest about internally: on both nights the *first* miss is contaminated by setup timing (URL freshly saved / account freshly connected). The clean two-texts-30-seconds-apart experiment on the stable URL is what makes this report airtight — run it before sending if possible, and update the timeline with its result.
