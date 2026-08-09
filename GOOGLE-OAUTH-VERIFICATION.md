# Google OAuth verification — Harry The Marketer

This app connects Gmail with sensitive scopes (`gmail.send`, `gmail.readonly`). Google blocks any account that is not a listed **Test user** until the OAuth app finishes verification — the error looks like:

> Access blocked: Harry The Marketer has not completed the Google verification process

The OAuth consent screen app name must be **Harry The Marketer**.

## Ports

Web (Vite) on **:8131** — this is `APP_URL` and the one to open. API (Express) on **:8130**.
Do **not** move the web port to 1983: that belongs to the Ports Manager dashboard
(`/Users/mk/Documents/Clients/Ports`). Changing `APP_URL` changes the OAuth redirect URI, which
then has to be re-registered under **Credentials → OAuth client** or every new **Connect Gmail**
fails with `Error 400: redirect_uri_mismatch`. Already-connected mailboxes survive a port change
(token refresh does not use the redirect URI); new connections do not.

## Immediate unblock (dev / internal)

Do this in [Google Cloud Console](https://console.cloud.google.com/) for project **secure-approach-487708-b5** (“My First Project” — rename to **Harry The Marketer** if you want):

1. **Google Auth Platform → Overview → Get started** (configures branding + audience).
2. Keep **Publishing status** as **Testing** until Google verifies the app.
3. Under **Audience → Test users**, add every Gmail address that will click **Connect Gmail**.
4. **Branding**: app name **`Harry The Marketer`** (exact casing).
5. Fill required fields:
   - App name: `Harry The Marketer`
   - User support email: your Google account
   - Application home page: your `APP_URL` (e.g. `http://localhost:8131` for local, or `https://harrythemarketer.com`)
   - Privacy policy: `{APP_URL}/privacy`
   - Terms of service: `{APP_URL}/terms`
   - Authorized domains: `harrythemarketer.com` for production (skip for pure localhost testing)
6. **Data access**: add scopes:
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/drive.file` — the prospect sheet. This is a
     **non-sensitive** scope: it grants access only to files this app creates, which
     is why Harry creates the spreadsheet for you rather than asking for one. It does
     not add to the Gmail verification burden.
7. Enable **Gmail API** (+ **Google Drive API** if using the prospect sheet) under APIs & Services → Library.
8. **Clients → Create client → Web application**:
   - Name: `Harry The Marketer Web`
   - Authorized redirect URI: `http://localhost:8131/api/google/callback`
   - (Later production) also add `https://harrythemarketer.com/api/google/callback`
9. Copy Client ID + Client secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, restart the app, then **Connections → Email → Add email → Gmail** while signed into a listed test user.
10. When Google has approved verification and Publishing status is **In production**, set `GOOGLE_OAUTH_VERIFIED=1` in `.env` (and Render) so the Testing notice disappears from Connections.

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
- [ ] Consent screen app name = **Harry The Marketer**
- [ ] `hello@thedigitalba.com.au` added as a Test user — only needed if that account
      must connect; it is currently blocked with `Error 403: access_denied`
- [ ] Privacy + Terms URLs set to `http://localhost:8131/privacy` and `/terms`
- [ ] (Later) Verification submitted and approved before opening to all users

> Console access gotcha: `hello@thedigitalba.com.au` has no IAM access to project
> `amazing-source-504109-c1` (missing `resourcemanager.projects.get`,
> `oauthconfig.testusers.get`). The consent screen must be edited from the owning
> account. Grant `roles/oauthconfig.editor` to avoid switching accounts every time.

> Gotcha: restart the dev server after branding/legal URL changes, or Google's reviewers
> can see stale `/privacy` and `/terms`.
