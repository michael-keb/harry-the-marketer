# Google OAuth verification — submission pack

Everything Google asks for, written out and ready to paste, plus the parts only
the account owner can do.

`GOOGLE-OAUTH-VERIFICATION.md` covers unblocking development (Testing mode, test
users). This file is about the other thing: going public.

---

## 1. Read this before spending anything

The five scopes this app requests are not equal, and one of them changes the
size of the job entirely.

| Scope | Google's class | What that means |
|---|---|---|
| `userinfo.email`, `userinfo.profile` | Non-sensitive | No verification burden |
| `drive.file` | Non-sensitive | Access only to files this app creates. No burden |
| `gmail.send` | **Sensitive** | Verification: forms, demo video, privacy policy. Free. Weeks |
| `gmail.readonly` | **Restricted** | All of the above **plus an annual third-party security assessment (CASA)** |

`gmail.readonly` is the expensive one. Restricted-scope apps that touch that
data from a third-party server must pass a CASA assessment from a
Google-empanelled assessor, and must repeat it **every 12 months** to keep
access. Reported cost for CASA Tier 2 is roughly **$540–$4,500 a year**, and the
whole verification typically runs **4–8 weeks**.

There is no cheaper Gmail scope for reading replies. Every scope that can read a
message body — `gmail.readonly`, `gmail.modify`, `gmail.metadata`,
`gmail.compose`, `mail.google.com` — is restricted. Reading replies from Gmail
means restricted-scope verification. There is no way to word around it.

So there are three honest paths:

**A. Stay in Testing.** No verification, no assessment, no cost, available now.
Up to 100 test users, each added by hand in the console. Refresh tokens expire
about every 7 days, so each user reconnects weekly. Correct for pilots, a first
cohort, and paying customers you can name. This is where the app is today.

**B. Verify with the restricted scope.** Everything in section 3, plus CASA,
plus annual renewal. Correct once you have public sign-ups you cannot enumerate.

**C. Drop the restricted scope.** Keep `gmail.send` (sensitive, no assessment)
and stop reading the mailbox: route replies to an address on
`harrythemarketer.com` with inbound parsing, so replies arrive as webhooks
instead of being fetched from Gmail. This is real engineering — the engine's
reply sync, threading and intent classification all read from Gmail today — but
it removes an annual assessment and a recurring bill, permanently. Worth costing
before committing to B.

**Nothing below is wasted whichever you choose.** A deployed public app with a
real privacy policy and a verified domain is required for B, and is worth having
for A and C anyway.

---

## 2. What is ready, and what is not

Ready in this repo:

- [x] `/privacy` and `/terms` served by the app on every host it runs on
- [x] Limited Use disclosure, verbatim, in the privacy policy (`server/legal.js`)
- [x] Scope-by-scope table in the privacy policy, now including `drive.file`
- [x] Operator identity — `Elnakeeb Pty Ltd`, New South Wales, Australia — set as
      real environment values rather than the "(operating entity to be confirmed)"
      placeholder that would otherwise render
- [x] Homepage explaining what the app does, at the domain that will be verified
- [x] No human reads mailbox content; stated in the policy and true in the code

Ready on our side (confirmed 2026-08-10):

- [x] Deploy is live at `https://harrythemarketer.com` — `/privacy`, `/terms`,
      `/api/health` return 200; Render `APP_URL=https://harrythemarketer.com`
- [x] GoDaddy DNS for `harrythemarketer.com` — apex → Render; Search Console
      TXT live (`google-site-verification=SNMChkRk…`)
- [x] Consent screen branding — app name **Harry The Marketer**, home/privacy/
      terms on `harrythemarketer.com`, authorised domain `harrythemarketer.com`,
      support email `michael@praxis-au.com`
- [x] Domain verified in Google Search Console for `harrythemarketer.com`
- [x] OAuth Web client `975026656566-…` has production redirect
      `https://harrythemarketer.com/api/google/callback` (+ localhost for dev)
- [x] Render production `GOOGLE_CLIENT_ID` / `SECRET` pointed at that same
      client (was `346879…`; reconnect any Gmail linked under the old client)

Still to do (owner):

- [ ] Demo video recorded and uploaded unlisted to YouTube (shot list §3.5 —
      use **Connections → Email → Connect Gmail**, not Mailboxes)
- [ ] Submit for verification in Google Auth Platform (+ CASA if keeping
      `gmail.readonly`)
- [ ] After Google approves: Audience → **In production**, then set
      `GOOGLE_OAUTH_VERIFIED=1` on Render
- [ ] Until then: keep Publishing **Testing** and add every Connect-Gmail
      address under Audience → Test users

---

## 3. The submission itself

### 3.1 Consent screen fields

| Field | Value |
|---|---|
| App name | `Harry The Marketer` |
| User support email | `michael@praxis-au.com` (live) — `support@harrythemarketer.com` also fine |
| App logo | Optional — **omit it** before submit. A logo triggers a separate brand review; remove if you uploaded one only for Testing |
| Application home page | `https://harrythemarketer.com` |
| Privacy policy | `https://harrythemarketer.com/privacy` |
| Terms of service | `https://harrythemarketer.com/terms` |
| Authorized domain | `harrythemarketer.com` |
| Developer contact | your Google account address |

### 3.2 Redirect URI

Under **Credentials → OAuth client (Web application)** add, keeping the
localhost one for development:

```
https://harrythemarketer.com/api/google/callback
```

This must match `APP_URL` exactly. A mismatch is `Error 400: redirect_uri_mismatch`
on every new Connect Gmail.

### 3.3 Domain verification

Google will only accept a homepage and privacy policy on a domain you have
proven you own.

1. Add `harrythemarketer.com` in [Google Search Console](https://search.google.com/search-console)
   as a **Domain** property.
2. It gives you a TXT record — add it at GoDaddy alongside the records in the DNS
   section of the reply.
3. Verify, then make sure the *same Google account* owns the Cloud project.

### 3.4 Scope justifications — paste these

Google asks "why does your app need this scope?" per scope. Answer what the app
actually does; a vague answer is the most common cause of a rejection round-trip.

**`gmail.send`**
> Harry The Marketer runs outreach sequences that the user designs as a diagram.
> When a sequence reaches a send step, the app composes an email and sends it
> from the user's own connected Gmail account, so the message comes from the
> person the recipient is actually corresponding with rather than from a shared
> platform address. Nothing is sent without the user's explicit approval of that
> individual email. This scope is used for exactly that send, and for replies the
> user writes inside the app's inbox. It is the minimum scope that can send mail
> as the user.

**`gmail.readonly`**
> The product's function is a conversation, not a broadcast: what happens next in
> a sequence depends on how the recipient replied. The app reads replies on the
> threads it started in order to (a) detect that a reply arrived at all, so
> follow-ups stop immediately, (b) classify the intent of the reply — interested,
> not now, unsubscribe, out of office — and route the sequence down the matching
> branch the user drew, and (c) show the user the thread in the app's inbox so
> they can answer without switching tools. It also detects unsubscribe requests
> in free text, which is how the app honours opt-outs it is legally required to
> honour. Message content is read only for threads the app itself created. We use
> `gmail.readonly` rather than a narrower scope because Google offers no Gmail
> scope that reads message bodies with a narrower grant; we deliberately do not
> request `gmail.modify` or `mail.google.com`, since the app never needs to
> alter or delete anything in the user's mailbox.

**`drive.file`**
> Users can sync their prospect list to a Google Sheet. The app creates that one
> spreadsheet itself and keeps it up to date. `drive.file` grants access only to
> files the app created, so the app can never see anything else in the user's
> Drive — which is why the app creates the sheet rather than asking the user to
> choose an existing one.

**`userinfo.email` / `userinfo.profile`**
> To show which mailbox is connected and label it in the app's mailbox list, and
> to associate the connected mailbox with the correct workspace.

### 3.5 Demo video

Unlisted YouTube, no narration required, but every item below must be visible on
screen. Reviewers reject videos that skip the consent screen or the address bar.

1. Start on `https://harrythemarketer.com` — show the homepage and the app name.
2. Sign in, go to **Connections → Email → Connect Gmail**.
3. **Hold on the Google consent screen for several seconds.** It must clearly
   show the app name *Harry The Marketer* and every scope being requested. Keep
   the browser address bar visible — the OAuth client ID in the URL is what
   proves the video is of the app under review.
4. Grant consent, land back in the app, show the mailbox now connected.
5. **`gmail.send` in use:** open a campaign, approve one queued email, show it
   sending, and show it in the recipient's inbox.
6. **`gmail.readonly` in use:** reply from the recipient's account, then show the
   reply appearing in Harry's inbox, classified, with the sequence advancing to
   the branch that reply matched. This is the scope reviewers scrutinise most —
   show it doing the thing the justification claims.
7. **`drive.file` in use:** Settings → create the Google Sheet, show the created
   spreadsheet.
8. Show disconnecting the mailbox and that its tokens are removed.

### 3.6 Limited Use confirmation

The reviewer will check the privacy policy contains the Limited Use language.
It does — `/privacy`, section 3 "Google user data". Point them at that anchor in
the submission notes.

---

## 4. Order of operations

1. [x] Deploy to `https://harrythemarketer.com` and confirm `/privacy` and `/terms`
   return 200 on the public internet.
2. [x] Rename the consent screen to **Harry The Marketer**.
3. [x] Verify the domain in Search Console.
4. [x] Add the production redirect URI and authorized domain; align Render
   `GOOGLE_*` with that client.
5. Decide path A, B or C from section 1. If A, stop here and keep managing test
   users.
6. [ ] Record the demo video.
7. [ ] Submit, and expect questions rather than a straight approval.
8. [ ] If restricted-scope verification proceeds, begin the CASA assessment — it
   runs in parallel and is usually the long pole.
9. [ ] After approval: Publishing → In production + `GOOGLE_OAUTH_VERIFIED=1`.

---

## Sources

- [Gmail API scopes and their classification](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Restricted scope verification, CASA and exemptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google API Services User Data Policy — Limited Use](https://developers.google.com/terms/api-services-user-data-policy)
