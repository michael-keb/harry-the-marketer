# Google OAuth verification — Harry The Marketer

This app connects Gmail with sensitive scopes (`gmail.send`, `gmail.readonly`). Google blocks any account that is not a listed **Test user** until the OAuth app finishes verification — the error looks like:

> Access blocked: Harry The Marketer has not completed the Google verification process

> **The consent screen is still branded `ReqOps Leadgen`.** Renaming it to **Harry The Marketer**
> is an outstanding console task (see the checklist), so the block message you see today still
> quotes the old name.

## Ports

Web (Vite) on **:8131** — this is `APP_URL` and the one to open. API (Express) on **:8130**.
Do **not** move the web port to 1983: that belongs to the Ports Manager dashboard
(`/Users/mk/Documents/Clients/Ports`). Changing `APP_URL` changes the OAuth redirect URI, which
then has to be re-registered under **Credentials → OAuth client** or every new **Connect Gmail**
fails with `Error 400: redirect_uri_mismatch`. Already-connected mailboxes survive a port change
(token refresh does not use the redirect URI); new connections do not.

## Immediate unblock (dev / internal)

Do this in [Google Cloud Console](https://console.cloud.google.com/) for project **amazing-source-504109-c1** (“My Project 17560”):

1. **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Audience**).
2. Set **Publishing status** to **Testing** (do **not** leave it in Production while unverified — that hard-blocks everyone).
3. Under **Test users**, add every Gmail address that will click **Connect Gmail**.
4. **Branding**: rename the app from `ReqOps Leadgen` → **`Harry The Marketer`** (match this repo’s legal name).
5. Fill required fields:
   - App name: `Harry The Marketer`
   - User support email: your Google account
   - Application home page: your `APP_URL` (e.g. `http://localhost:8131` for local, or the public URL)
   - Privacy policy: `{APP_URL}/privacy`
   - Terms of service: `{APP_URL}/terms`
   - Authorized domains: your production host (skip for pure localhost testing)
6. Confirm scopes include:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/drive.file` — the prospect sheet. This is a
     **non-sensitive** scope: it grants access only to files this app creates, which
     is why Harry creates the spreadsheet for you rather than asking for one. It does
     not add to the Gmail verification burden.
7. **Credentials → OAuth client** (Web application): authorized redirect URI must match `.env`:
   - Local: `http://localhost:8131/api/google/callback`
8. Retry **Mailboxes → Connect Gmail** while signed into a listed test user.

Tokens for test users expire after ~7 days; reconnect when that happens.

## Production verification (public users)

> **The full submission pack is [GOOGLE-VERIFICATION-PACK.md](GOOGLE-VERIFICATION-PACK.md)** —
> scope justifications ready to paste, the demo-video shot list, the console fields, and an
> honest account of what `gmail.readonly` costs. Read that before starting; the summary below
> is the short version.
>
> The headline: `gmail.readonly` is a **restricted** scope, so verification requires an annual
> third-party CASA security assessment (~$540–$4,500/yr) on top of the usual forms. `gmail.send`
> alone would only be *sensitive*, which is free. Staying in **Testing** avoids both.

When non-test users must connect Gmail:

1. Deploy so `{APP_URL}/privacy` and `{APP_URL}/terms` are reachable on the public internet.
2. Complete the OAuth consent screen branding (logo optional — a logo can force extra review).
3. On the consent screen, **Prepare for verification** / **Submit for verification**.
4. Provide:
   - Written justification for each Gmail scope (send outreach; read replies to route playbooks)
   - Demo video showing Connect Gmail → consent → send/read in-product
   - Link to this privacy policy and confirmation of [Limited Use](https://developers.google.com/terms/api-services-user-data-policy)
5. Wait for Google’s review (often days to weeks for sensitive scopes). Restricted-scope cases may need a security assessment.

Until verification is **approved**, keep status **Testing** and manage the test-user list.

## App URLs this repo exposes

| Purpose | Path |
|---------|------|
| Privacy Policy | `/privacy` |
| Terms of Service | `/terms` |
| OAuth start | `/api/google/connect` |
| OAuth callback | `/api/google/callback` |

Web dev server runs on `:8131`; the API runs on `:8130`. In Vite dev, `/api`, `/privacy` and
`/terms` are proxied from `:8131` to the API on `:8130`.

## Checklist

App side (verified locally 6 Aug 2026):

- [x] `/privacy` and `/terms` serve 200 on both `:8131` (Vite proxy) and `:8130` (API)
- [x] Scopes sent = `gmail.send`, `gmail.readonly`, `userinfo.email`, `userinfo.profile`
- [ ] `drive.file` added for the prospect sheet (non-sensitive). Add it to the consent
      screen's scope list, then **reconnect each Gmail mailbox** — tokens issued before
      it was added do not carry it, and Sheets returns 403 until they are re-granted.
      Harry says exactly that in the error when it happens.
- [x] Client ID `346879117652-nk0hc5f…apps.googleusercontent.com` is live (not deleted)
- [x] App name is `Harry The Marketer` throughout the code, legal pages and docs

Proven live against Google (6 Aug 2026):

- [x] Publishing status = **Testing** (Google's own 403 says "currently being tested")
- [x] Gmail API enabled — `gmail/v1/users/me/profile` returns 200 with a real token
- [x] Connect Gmail succeeds for a test user — `elnakeebm@gmail.com` is connected, its
      refresh token still exchanges (200), and all four original scopes are granted
- [x] `elnakeebm@gmail.com` is an approved Test user

Console side (still needs Google Cloud Console):

- [x] Redirect URI `http://localhost:8131/api/google/callback` registered (Google returns no
      `redirect_uri_mismatch` for it)
- [ ] Consent screen app name = **Harry The Marketer** (still reads `ReqOps Leadgen`)
- [ ] `hello@thedigitalba.com.au` added as a Test user — only needed if that account
      must connect; it is currently blocked with `Error 403: access_denied`
- [ ] Privacy + Terms URLs set to `http://localhost:8131/privacy` and `/terms`
- [ ] (Later) Verification submitted and approved before opening to all users

> Console access gotcha: `hello@thedigitalba.com.au` has no IAM access to project
> `amazing-source-504109-c1` (missing `resourcemanager.projects.get`,
> `oauthconfig.testusers.get`). The consent screen must be edited from the owning
> account. Grant `roles/oauthconfig.editor` to avoid switching accounts every time.

> Gotcha: this directory was renamed from `ReqOps_Leadgen` → `Harry The Marketer`. A dev server
> started before the rename keeps serving the old module graph and returns 404/500 for `/privacy`
> and `/terms`. Restart the dev server after renaming, or Google's reviewers see broken legal URLs.
