# Inbound SMS webhook — required sequence

Harry **receives** inbound SMS. SMSFlow must **POST once per received message**. Harry never posts this URL and never pulls SMSFlow Inbox.

Webhook: `POST https://harrythemarketer.com/api/hooks/smsflow/sms?token=…`  
Handler: `server/channels/webhook.js` (`smsflowRouter.post('/sms')`)

---

## What must happen (two texts, same sender)

```mermaid
sequenceDiagram
    autonumber
    actor Phone as Phone +61422754149
    participant SF as SMSFlow
    participant Hook as Harry webhook
    participant Inbox as Harry Inbox

    Note over SF,Hook: Setup once — Developer Settings Webhook URL is our public HTTPS endpoint

    Phone->>SF: SMS 1 “Hi” to +61485937338
    SF->>SF: Store in SMSFlow Inbox
    SF->>Hook: POST JSON {from, to, body: Hi}
    Note right of SF: Required. SMSFlow is the only caller of this URL.
    Hook->>Hook: Verify token → processInboundSms
    Hook->>Inbox: INSERT messages (channel=sms, direction=in)
    Hook-->>SF: 200 {ok:true}

    Phone->>SF: SMS 2 (seconds or minutes later, same sender)
    SF->>SF: Store in SMSFlow Inbox
    SF->>Hook: POST JSON {from, to, body}
    Note right of SF: Required and independent of SMS 1.<br/>No coalescing. Harry does not pull Inbox.
    Hook->>Inbox: INSERT second row
    Hook-->>SF: 200 {ok:true}
```

SMSFlow confirmed (2 Sep 2026): no rate limiting, coalescing, or suppression for the same sender. Each inbound SMS is its own webhook delivery.

---

## What happened on 2 September (and 1 September)

```mermaid
sequenceDiagram
    autonumber
    actor Phone as Phone +61422754149
    participant SF as SMSFlow
    participant Hook as Harry webhook
    participant Inbox as Harry Inbox

    Phone->>SF: SMS 1 “Hi”
    SF->>SF: Store in Inbox
    SF->>Hook: POST JSON
    Hook->>Inbox: INSERT row
    Hook-->>SF: 200 {ok:true}

    Phone->>SF: SMS 2 (minutes later)
    SF->>SF: Store in Inbox
    SF--x Hook: No POST attempted
    Note over SF,Hook: SMSFlow engineering: no delivery record for message 2.<br/>No HTTP response from Harry — the request never left their queue.
    Inbox-->>Inbox: Harry never hears about SMS 2
```

SMSFlow does not retry failed deliveries. There is also nothing to retry when they never attempt the POST.

Harry does **not** make a second POST. The only POST we make is outbound send to `https://api.smsflow.com.au/v2/sms/send` (optional `callback_url` for delivery receipts of *our* texts). That path cannot recover a missed inbound.

---

## Who owns each hop

| Hop | Owner | Required? | If it fails |
|-----|--------|-----------|-------------|
| Phone → dedicated number | Carrier / SMSFlow | Yes | Nothing in either Inbox |
| Store in SMSFlow Inbox | SMSFlow | Yes (their log) | They would not see the text either |
| `POST /api/hooks/smsflow/sms` | SMSFlow queue | Yes — once per message | Harry never sees it. No poll. No retry. |
| Verify token + INSERT | Harry webhook | Yes, if POST arrives | SMSFlow would record 4xx/5xx. They recorded nothing. |
| HTTP 200 `{ok:true}` | Harry → SMSFlow | Yes, after insert | SMSFlow does not retry today |
| Second POST for SMS 2 | SMSFlow queue | Yes — independent of SMS 1 | Exactly the 2 Sep / 1 Sep miss |
| POST this webhook ourselves | Harry | **No** | Not a lever. We are the receiver. |
| Pull SMSFlow Inbox | Harry | **No — not built** | Missed texts stay in SMSFlow only |
