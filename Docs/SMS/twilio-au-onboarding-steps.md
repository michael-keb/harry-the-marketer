# Twilio Australia onboarding — steps

Isa Bell (Twilio Digital Sales) confirmed this is **AU-only**. Ignore US 10DLC.

Two possible blockers. Most Harry traffic needs **both**: a branded outbound sender ID, and a `+614` mobile if replies must land in the inbox.

---

## Path A — Register an alphanumeric sender ID

Use this if messages should show a brand name (for example `HARRY`) instead of a phone number.

Registration is **one sender ID at a time**. Twilio review, then ACMA. Typical total: about **2 weeks** after submission to ACMA. Unregistered IDs show as `Unverified` for Australian recipients from 1 July 2026.

### A1. Pick the legal entity and the exact sender ID string

The string must be **2–11 characters** and must match, as a name or clear abbreviation of:

- the ASIC company name, or
- a **currently registered** business name, or
- a **registered** trademark, or
- a domain you are the **registrant** of (live website or live corporate email)

Public ABR extract (4 Sep 2026) for **Elnakeeb Pty Ltd** (ABN `83 608 539 886`, ACN `608 539 886`):

| Name on record | Likely valid sender ID |
|---|---|
| ELNAKEEB PTY LTD | `ELNAKEEB` |
| THE DIGITAL BA (BN from 24 Dec 2019) | `DIGITALBA` |
| The Squad Institute Group (BN from 9 Aug 2026) | `SQUADINST` |
| harrythemarketer.com (domain, if WHOIS registrant is Elnakeeb) | `HARRYTHEMAR` (11 chars) |

`HARRY` or `HARRYTM` will likely fail unless you first register the business name **Harry The Marketer** (or a trademark for it).

Harry is a **direct customer** if you only send as your own brand. Harry is an **ISV** if workspace customers send as *their* brands — that is a different Twilio / ACMA path.

### A2. Get business proof (ASIC extract)

Twilio will not accept the free ABR page as the company proof. Download one of:

1. **ASIC Current Company Extract** (long form — officers + address), or
2. the latest **ASIC Annual Company Statement** (must list directors)

Order: [ASIC Connect](https://connectonline.asic.gov.au/) → search ACN `608 539 886` → Current Company Extract. Keep the PDF.

The extract must name the person who will verify, **or** you need a signed LOA (step A5).

### A3. Get proof the sender ID belongs to the brand

Collect **one** of:

- ASIC **Business Name** extract for the matching name
- IP Australia trademark record (status **Registered**)
- WHOIS record showing Elnakeeb (or the chosen entity) as **registrant**, plus the live site or a matching corporate email

GoDaddy holds `harrythemarketer.com` (registered 8 Aug 2026, expires 8 Aug 2027, nameservers `NS77/78.DOMAINCONTROL.COM`). Public WHOIS does **not** show the registrant — GoDaddy privacy redacts it. Twilio will want a **GoDaddy account export** (registrant = Elnakeeb Pty Ltd) or a matching corporate email on that domain, not a terminal `whois` printout.

`praxis-au.com` and `harrythemarketer.com.au` were not useful from public WHOIS in the same check (no registrant surfaced for brand proof).

### A4. Government ID for the authorised representative

Scan of an Australian government photo ID or passport. Name must match the extract (or the LOA).

Use a **corporate email** that matches the representative’s name. Gmail / Yahoo / Hotmail are not accepted.

`michael@praxis-au.com` is a corporate domain, but it must match the person named on the ID. Prefer something like `michael@harrythemarketer.com` or `michael@thedigitalba.com.au` if that mailbox exists.

**Do not** put the ID scan in git. Keep it in the Twilio Console upload or a private folder.

### A5. Signed LOA — only if the verifier is not on the extract

If the person filling Console is **not** a director / officer / authorised contact on the ASIC extract:

1. Download Twilio’s template: Console help → *LOA for Aus Sender ID (AR).docx*, or ask Isa / `senderid@twilio.com`
2. A **named director** signs it, authorising the verifier
3. Upload the signed PDF with the application

If Michael is a director of Elnakeeb Pty Ltd, skip this.

### A6. Write the use-case pack (one per sender ID)

Twilio / ACMA need:

| Field | What to say |
|---|---|
| Use case | What the SMS is for (consent-based B2B outreach, replies, STOP/START) |
| Sample message | Exact text, including identify-the-sender and opt-out |
| Traffic type | Mixed (transactional + commercial). Marketing SMS needs consent under the Spam Act |
| Estimated monthly volume | Honest first-90-days number, then steady-state |
| Classification | Direct customer **or** ISV |

Draft once the sender ID and 2-way decision are locked (questions below).

### A7. Submit in Twilio Console

1. Upgrade off trial if the account is still trial
2. [Create an Australia sender ID application](https://console.twilio.com/us1/develop/phone-numbers/sender-ids/applications/create)
3. Upload extract, brand proof, ID, LOA (if needed), use-case pack
4. Twilio reviews, then submits to ACMA Assist
5. Authorised contact completes ACMA Assist / myID (Standard strength) when emailed
6. Twilio provisions the sender ID on the account

Guides Isa sent:

- [Registering Your Alphanumeric Sender ID for Australia in the Twilio Console](https://www.twilio.com/docs/sms/a2p-10dlc)
- [Regulatory information: Your Sender ID registrations via Twilio (Australia)](https://help.twilio.com/articles/46266521342747-Help-with-registering-your-Alphanumeric-Sender-ID-via-Twilio-in-Australia)

Alternate ABN path (email, then you finish KYC on ACMA Assist yourself): `senderid-notify@twilio.com` with subject `[Your Sender ID] Australia Alpha Manual Onboarding`.

---

## Path B — Keep or add a `+614` mobile (2-way SMS)

Isa’s rule: **only `+614` mobiles support Voice + SMS on Twilio**. `+612` / `+613` / `+617` / `+618` and toll-free can port, but they are **voice-only**. No amount of KYC makes a landline SMS-capable.

Harry’s inbox, STOP/START, and campaign replies need **2-way**. An alphanumeric ID is outbound-only. So:

- branded outbound → Path A
- replies / 2-way → a Twilio `+614` mobile (new or ported)

Current Harry SMS number (SMSFlow, not Twilio): `+61485937338`.

### B1. Decide: new Twilio mobile vs port

**New `+614`:** buy in Console after the AU regulatory bundle. Faster. Number changes.

**Port existing `+614`:** keep the number. About **1 week** once docs are complete. Account must be **upgraded** (not trial). Number must stay **active** at the current provider during the port.

Twilio accepts AU mobile ports from Telstra, Vodafone/TPG family, Lebara, Lyca Mobile, Pivotel, and Telstra wholesale.

### B2. Porting pack (only if porting)

- CAAA form
- MNP spreadsheet
- recent bill from the current provider
- number verification in the Twilio account
- AU regulatory bundle + Australian street address (no PO Box)
- keep the service active until the port completes

Guides: [Australia Porting](https://www.twilio.com/docs/phone-numbers/port-in) · Australia (AU) Porting Guidelines.

---

## Suggested order

1. Answer the questions in chat (entity, sender ID, 2-way vs outbound, who verifies).
2. If you want `HARRY` / `HARRYTM`, register business name **Harry The Marketer** on ASIC first (or a trademark). Wait until it shows as Registered.
3. Buy the ASIC Current Company Extract.
4. Export domain WHOIS / registrant proof from GoDaddy.
5. Scan government ID (private; not in this repo).
6. Sign LOA only if the verifier is not on the extract.
7. Finalise use-case + sample message + volume.
8. Upgrade Twilio account if still trial.
9. Submit Path A in Console (or email Isa the pack).
10. If 2-way is required: buy or port a `+614`.
11. Complete ACMA Assist when the email arrives.
12. Point Harry at the Twilio sender ID / number once provisioned.

---

## What this repo can produce vs what only you can produce

| Item | Status |
|---|---|
| Use case, sample SMS, traffic type, volume draft | Can write once you answer the questions |
| LOA text ready to sign | Can draft from Twilio’s template |
| ABR snapshot (Elnakeeb + Reqops) | Public record pulled 4 Sep 2026 — **not** a substitute for the ASIC extract |
| ASIC Current Company Extract | You order and pay |
| Domain / trademark proof | You export from GoDaddy / IP Australia |
| Government ID | You scan; never commit it |
| Signed LOA | You (or a listed director) sign |
| Console submission / ACMA myID | You |

---

## Public records already pulled (4 Sep 2026)

**Elnakeeb Pty Ltd** — ABN `83 608 539 886` · ACN `608 539 886` · Active from 1 Oct 2015 · GST registered · Main location NSW 2111 · Business names: THE DIGITAL BA (24 Dec 2019), The Squad Institute Group (9 Aug 2026) · ABN last updated 10 Aug 2026.

**Reqops Pty Ltd** — ABN `70 683 152 034` · ACN `683 152 034` · Active from 16 Dec 2024 · GST registered · Main location NSW 2160. Separate company. Only use this entity if the sender ID is for ReqOps, not Harry.

Harry legal pages and Google pack already name **Elnakeeb Pty Ltd**, NSW, `https://harrythemarketer.com`. Support historically `michael@praxis-au.com`.
