// Public legal pages, server-rendered.
//
// These are deliberately NOT part of the React SPA: Google's OAuth reviewers,
// crawlers, and anyone with JavaScript disabled must be able to fetch /privacy
// and /terms and read them. They share the marketing site's visual language so
// the seam is invisible.
import express from 'express'
import { env } from './env.js'
import { BRAND } from '../shared/site-content.js'

// Legal name and product name are the same — the Google consent screen must match this exactly.
export const APP_LEGAL_NAME = BRAND.name
export const APP_PRODUCT_NAME = APP_LEGAL_NAME

const LAST_UPDATED = '6 August 2026'

// Operator-specific details. Set these in .env before going live — the defaults
// are visibly marked so an unreviewed deployment cannot pass itself off as final.
const ENTITY = env.LEGAL_ENTITY_NAME || `${APP_LEGAL_NAME} (operating entity to be confirmed)`
const JURISDICTION = env.LEGAL_JURISDICTION || 'the operator’s place of business (to be confirmed)'
const PRIVACY_EMAIL = env.LEGAL_PRIVACY_EMAIL || BRAND.privacyEmail
const SUPPORT_EMAIL = env.LEGAL_SUPPORT_EMAIL || BRAND.supportEmail

const DOCS = [
  { path: '/privacy', title: 'Privacy Policy' },
  { path: '/terms', title: 'Terms of Service' },
  { path: '/acceptable-use', title: 'Acceptable Use Policy' },
  { path: '/dpa', title: 'Data Processing Addendum' },
  { path: '/sub-processors', title: 'Sub-processors' },
  { path: '/cookies', title: 'Cookie Policy' },
]

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function page({ path, title, summary, body }) {
  const origin = env.APP_URL || BRAND.defaultOrigin
  const canonical = `${origin}${path}`
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — ${esc(APP_LEGAL_NAME)}</title>
  <meta name="description" content="${esc(summary)}" />
  <link rel="canonical" href="${esc(canonical)}" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="${esc(title)} — ${esc(APP_LEGAL_NAME)}" />
  <meta property="og:description" content="${esc(summary)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta name="twitter:card" content="summary" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <style>
    :root {
      color-scheme: dark;
      --ink-950: #0b1622; --ink-900: #1b2a3d; --ink-800: #16222f;
      --ink-700: #23303e; --ink-600: #2c3b4b;
      --accent-300: #2fd79b; --accent-400: #2fd79b; --accent-500: #0f9d6e;
      --text: #cbd6e2; --heading: #ffffff; --muted: #93a9be;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--ink-950); color: var(--text); line-height: 1.65;
      font-family: "Avenir Next", "Segoe UI", ui-sans-serif, system-ui, -apple-system, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent-300); }
    a:hover { color: var(--accent-400); }
    header.site {
      border-bottom: 1px solid var(--ink-700); background: rgba(16,24,40,.7);
      position: sticky; top: 0; backdrop-filter: blur(8px);
    }
    .bar {
      max-width: 64rem; margin: 0 auto; padding: 0.9rem 1.25rem;
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
    }
    .wordmark {
      display: inline-flex; align-items: center; gap: 0.6rem;
      color: var(--heading); font-weight: 700; letter-spacing: -0.01em; text-decoration: none; font-size: 1rem;
    }
    .wordmark span { color: var(--accent-400); }
    .wordmark svg { display: block; }
    .bar nav { display: flex; gap: 1rem; font-size: 0.85rem; }
    .bar nav a { color: var(--muted); text-decoration: none; }
    .bar nav a:hover { color: var(--accent-300); }
    main { max-width: 44rem; margin: 0 auto; padding: 3rem 1.25rem 4rem; }
    h1 { font-size: clamp(1.75rem, 4vw, 2.25rem); line-height: 1.2; margin: 0 0 0.5rem; color: var(--heading); letter-spacing: -0.02em; }
    .sub { color: var(--muted); font-size: 0.9rem; margin: 0 0 2.5rem; }
    .summary {
      border: 1px solid var(--ink-700); border-left: 3px solid var(--accent-500);
      background: var(--ink-900); border-radius: 0.75rem; padding: 1rem 1.15rem; margin: 0 0 2.5rem;
      color: var(--text); font-size: 0.95rem;
    }
    .summary strong { color: var(--heading); }
    h2 { font-size: 1.2rem; margin: 2.5rem 0 0.6rem; color: var(--heading); letter-spacing: -0.01em; }
    h3 { font-size: 1rem; margin: 1.75rem 0 0.4rem; color: #e1e8ed; }
    p, li { font-size: 0.97rem; }
    ul { padding-left: 1.15rem; }
    li { margin: 0.35rem 0; }
    code {
      font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 0.85em;
      background: var(--ink-800); border: 1px solid var(--ink-700);
      border-radius: 0.3rem; padding: 0.1rem 0.35rem; color: var(--accent-300);
    }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; display: block; overflow-x: auto; }
    th, td { text-align: left; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--ink-700); vertical-align: top; }
    th { color: var(--heading); font-weight: 600; white-space: nowrap; }
    .todo { color: #d89a24; }
    footer.site { border-top: 1px solid var(--ink-700); margin-top: 3.5rem; background: var(--ink-900); }
    .foot { max-width: 44rem; margin: 0 auto; padding: 1.75rem 1.25rem 2.5rem; font-size: 0.85rem; color: var(--muted); }
    .docs { display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; margin-bottom: 1rem; }
    .docs a { text-decoration: none; }
    .docs a[aria-current] { color: var(--heading); }
    .skip { position: absolute; left: -9999px; }
    .skip:focus { left: 1rem; top: 0.75rem; background: var(--ink-800); padding: 0.5rem 0.9rem; border-radius: 0.5rem; z-index: 10; }
  </style>
</head>
<body>
  <a class="skip" href="#doc">Skip to content</a>
  <header class="site">
    <div class="bar">
      <a class="wordmark" href="/">
        ${markSvg(22)}
        ${esc(BRAND.nameLead)} <span>${esc(BRAND.nameAccent)}</span>
      </a>
      <nav>
        <a href="/pricing">Pricing</a>
        <a href="/security">Security</a>
        <a href="/login">Sign in</a>
      </nav>
    </div>
  </header>
  <main id="doc">
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(APP_LEGAL_NAME)} · Last updated ${LAST_UPDATED}</p>
    <div class="summary">${summary}</div>
    ${body}
  </main>
  <footer class="site">
    <div class="foot">
      <div class="docs">
        ${DOCS.map((d) =>
          d.path === path
            ? `<a href="${d.path}" aria-current="page">${esc(d.title)}</a>`
            : `<a href="${d.path}">${esc(d.title)}</a>`
        ).join('')}
      </div>
      <div>
        ${esc(ENTITY)} · <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>
        · <a href="/">Back to ${esc(APP_LEGAL_NAME)}</a>
      </div>
    </div>
  </footer>
</body>
</html>`
}

// The H-with-a-branching-crossbar mark (LOGO-BRIEF.md §8, direction B), inlined
// so the legal pages need no asset requests.
function markSvg(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect width="32" height="32" rx="7" fill="#1b2a3d" stroke="#23303e" />
    <path d="M10 8v16M22 8v16M10 16h5" stroke="#2fd79b" stroke-width="2.4" stroke-linecap="round" />
    <path d="M15 16l7-4M15 16l7 4" stroke="#0f9d6e" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`
}

// ---- documents --------------------------------------------------------------

const privacy = {
  path: '/privacy',
  title: 'Privacy Policy',
  summary: `<strong>The short version:</strong> we store the leads, playbooks, and email metadata you put into your
    workspace, plus OAuth tokens for the mailboxes you connect. Gmail content is used only to run your campaigns —
    never for advertising, never for training a general model, and never sold. Disconnecting a mailbox deletes its
    tokens; deleting your account deletes your workspace.`,
  body: `
  <p>This policy explains how <strong>${esc(APP_LEGAL_NAME)}</strong> (“we”, “the service”) handles information when
  you use the platform and when you connect a Google account so the campaign agent can send and read email on your behalf.</p>

  <h2>1. Who is responsible for what</h2>
  <p>For your account details and how the service itself operates, we act as the <em>controller</em>.
  For the lead and prospect data you upload and the campaigns you run, you are the controller and we act as your
  <em>processor</em> — we handle that data on your instructions. See the
  <a href="/dpa">Data Processing Addendum</a> for the processor terms.</p>

  <h2>2. What we collect</h2>
  <table>
    <tr><th>Category</th><th>Examples</th><th>Why</th></tr>
    <tr><td>Account</td><td>Email address, display name, profile picture, identity provider subject</td><td>Authenticate you and scope your workspace</td></tr>
    <tr><td>Workspace content</td><td>Leads, playbook diagrams, campaigns, goals, business context, team invitations</td><td>Operate the features you use</td></tr>
    <tr><td>Mailbox credentials</td><td>Google OAuth access and refresh tokens, connected mailbox address</td><td>Send and read mail for your campaigns</td></tr>
    <tr><td>Email data</td><td>Sent message content and metadata, replies pulled from connected mailboxes, classified intent, thread identifiers</td><td>Advance each lead through your playbook and show you the thread</td></tr>
    <tr><td>Engagement</td><td>Open and click events on emails you send, unsubscribe events</td><td>Report campaign performance and honour opt-outs</td></tr>
    <tr><td>Operational telemetry</td><td>Engine tick durations, AI call latency and failures, delivery outcomes</td><td>Keep the pipeline healthy; shown on your Monitoring page</td></tr>
  </table>
  <p>We do not use advertising trackers, third-party analytics scripts, or cross-site cookies. See the
  <a href="/cookies">Cookie Policy</a>.</p>

  <h2>3. Google user data</h2>
  <p>When you connect Gmail we request only these scopes:</p>
  <ul>
    <li><code>gmail.send</code> — send campaign and reply emails from your mailbox</li>
    <li><code>gmail.readonly</code> — read replies so the engine can classify intent and advance playbooks</li>
    <li><code>userinfo.email</code> / <code>userinfo.profile</code> — identify which mailbox you connected</li>
    <li><code>drive.file</code> — create and update the one prospect spreadsheet you ask for, and nothing else
      in your Drive. This scope grants access only to files this app itself creates, which is why Harry
      creates the spreadsheet for you rather than asking you to pick an existing one.</li>
  </ul>
  <p>Our use of information received from Google APIs adheres to the
  <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Google API Services User Data Policy</a>,
  including the <strong>Limited Use</strong> requirements. Specifically, Gmail data is used only to provide and improve
  the user-facing features you enabled; it is not transferred to others except as needed to provide those features,
  to comply with applicable law, or as part of a merger or acquisition; it is not used for advertising; and it is not
  read by humans except with your explicit consent, to resolve a support issue you raised, for security purposes, or
  where required by law.</p>
  <p>Gmail content is not used to train generalised machine-learning models. Where you enable AI features, the
  relevant message text is sent to the AI provider configured for your deployment solely to compose a reply or
  classify an intent for your campaign — see <a href="/sub-processors">Sub-processors</a>.</p>

  <h2>4. Legal bases (UK/EU GDPR)</h2>
  <ul>
    <li><strong>Contract</strong> — providing the service you signed up for</li>
    <li><strong>Legitimate interests</strong> — securing the platform, preventing abuse, and operating the service reliably</li>
    <li><strong>Consent</strong> — connecting a Google mailbox, which you may withdraw at any time by disconnecting it</li>
    <li><strong>Legal obligation</strong> — where we must retain records or respond to lawful requests</li>
  </ul>
  <p>Where you upload prospect data, you are responsible for having a lawful basis to process and to contact those people.</p>

  <h2>5. Storage, security, and location</h2>
  <p>Data is held in the deployment you use. OAuth tokens are stored server-side and are never exposed to the browser.
  Sessions are signed, HTTP-only cookies. Self-hosted operators control their own storage location, backups, and
  encryption at rest; for hosted deployments, the region is stated in your order form. Details of the technical
  measures are on the <a href="/security">Security</a> page.</p>

  <h2>6. Sharing</h2>
  <p>We do not sell personal data and we do not share it for cross-context behavioural advertising. We share data only
  with the sub-processors needed to run the service (listed at <a href="/sub-processors">/sub-processors</a>), with your
  own team members inside your workspace, and where required by law.</p>

  <h2>7. Retention and deletion</h2>
  <ul>
    <li>Disconnecting a mailbox immediately removes its OAuth tokens from our database.</li>
    <li>Deleting a lead, campaign, or goal removes it and its dependent records.</li>
    <li>Closing your account deletes your workspace content; residual copies in encrypted backups age out on the backup cycle.</li>
    <li>Operational telemetry is self-pruning and retains only the most recent records.</li>
    <li>Self-hosted deployments: deleting the database file removes everything.</li>
  </ul>
  <p>To request deletion or a copy of your data, email <a href="mailto:${esc(PRIVACY_EMAIL)}">${esc(PRIVACY_EMAIL)}</a>.
  If you joined someone else's team workspace, the workspace owner controls that content.</p>

  <h2>8. Your rights</h2>
  <p>Depending on where you live you may have rights to access, correct, delete, port, or restrict processing of your
  personal data, and to object to it. Contact <a href="mailto:${esc(PRIVACY_EMAIL)}">${esc(PRIVACY_EMAIL)}</a> and we will
  respond within the period your law requires. You may also complain to your local supervisory authority.</p>
  <p>If you received an email sent through this platform and want your data removed, use the unsubscribe link in that
  email — it takes effect across every campaign in the sending workspace immediately — or contact the sender directly.</p>

  <h2>9. International transfers</h2>
  <p>Where data moves between jurisdictions, we rely on the transfer mechanisms available to us, including the
  Standard Contractual Clauses, and require equivalent commitments from sub-processors.</p>

  <h2>10. Children</h2>
  <p>The service is for business use and is not directed at anyone under 16.</p>

  <h2>11. Changes</h2>
  <p>We will post material changes on this page and update the date above. Continued use after a change means you accept it.</p>

  <h2>12. Contact</h2>
  <p>${esc(ENTITY)} — <a href="mailto:${esc(PRIVACY_EMAIL)}">${esc(PRIVACY_EMAIL)}</a></p>
`,
}

const terms = {
  path: '/terms',
  title: 'Terms of Service',
  summary: `<strong>The short version:</strong> use it for outreach you are legally allowed to send, from mailboxes you
    are allowed to use, and honour opt-outs. Your data stays yours. The service is provided without warranty, and
    liability is capped at what you paid.`,
  body: `
  <p>These Terms govern your use of <strong>${esc(APP_LEGAL_NAME)}</strong>, a lead-generation platform that executes
  campaign playbooks — flowchart diagrams — against connected email mailboxes. By creating an account you agree to them.</p>

  <h2>1. Your account</h2>
  <ul>
    <li>You must give accurate details and keep your credentials secure.</li>
    <li>You are responsible for everything done under your account and by members you invite to your workspace.</li>
    <li>A workspace owner controls the workspace's content and membership, including data belonging to invited members.</li>
  </ul>

  <h2>2. Plans, billing, and trials</h2>
  <ul>
    <li>Paid plans are billed in advance on the interval you choose. Annual plans are billed for the full term.</li>
    <li>Prices are shown on the <a href="/pricing">pricing page</a> and exclude taxes unless stated.</li>
    <li>You may cancel at any time; cancellation stops the next renewal and access continues to the end of the paid period.</li>
    <li>We may change prices with at least 30 days' notice before your next renewal.</li>
    <li>Where a free trial is offered, its length and conditions are stated at signup. Unless you cancel before it
    ends, the plan continues at the published price.</li>
  </ul>

  <h2>3. Your responsibilities when sending</h2>
  <p>This is the part that matters most. You agree to:</p>
  <ul>
    <li>Comply with every applicable anti-spam, privacy, and marketing law in each jurisdiction you message — including
    GDPR, CAN-SPAM, CASL, and the Australian Spam Act as relevant to you</li>
    <li>Only connect mailboxes you are authorised to use</li>
    <li>Only contact people you have a lawful basis to contact, using data you obtained lawfully</li>
    <li>Identify yourself truthfully as the sender and keep a working opt-out in every message</li>
    <li>Honour unsubscribe and do-not-contact requests promptly</li>
    <li>Keep daily send limits conservative and warm new mailboxes gradually</li>
    <li>Follow the <a href="/acceptable-use">Acceptable Use Policy</a></li>
  </ul>
  <p>The platform provides one-click unsubscribe, a <code>List-Unsubscribe</code> header, per-mailbox daily limits, and
  automatic honouring of opt-outs. Those are controls, not compliance — compliance is yours.</p>

  <h2>4. The AI agent</h2>
  <p>The agent drafts email copy, classifies replies, researches companies, and can plan campaigns. Its output is
  generated automatically and may be wrong. <strong>You are the publisher of every email your account sends.</strong>
  Review your playbook instructions and your business context, and use the sandbox mailbox to check behaviour before
  sending to real people.</p>

  <h2>5. Your data and ours</h2>
  <p>You keep all rights in the leads, playbooks, copy, and business context you put into the service. You grant us the
  limited licence needed to host and process it to provide the service. We keep all rights in the platform itself.
  Aggregate, de-identified statistics that cannot identify you or your contacts may be used to improve the service.</p>

  <h2>6. Availability and support</h2>
  <p>We aim for continuous availability but do not promise it except where an order form states an SLA. We may perform
  maintenance and change features. Material reductions in functionality will be notified.</p>

  <h2>7. Suspension and termination</h2>
  <p>We may suspend or terminate an account that breaches these Terms or the Acceptable Use Policy, creates a security
  or deliverability risk, or is used unlawfully. Where practical we will warn you first. You may close your account at
  any time.</p>

  <h2>8. Third-party services</h2>
  <p>Connecting Gmail is optional and governed by Google's terms. You can revoke our access at any time from your
  <a href="https://myaccount.google.com/permissions" rel="noopener">Google Account permissions</a> or by removing the
  mailbox in the app. AI providers, identity providers, and hosting are listed under
  <a href="/sub-processors">Sub-processors</a>.</p>

  <h2>9. No warranty</h2>
  <p>The service is provided “as is” and “as available”, without warranties of any kind to the fullest extent the law
  allows. We do not warrant any particular deliverability rate, reply rate, or business outcome. Self-hosted operators
  are responsible for securing their deployment, secrets, and backups. Nothing here excludes rights that cannot be
  excluded under consumer law that applies to you.</p>

  <h2>10. Limitation of liability</h2>
  <p>To the extent permitted by law, neither party is liable for indirect, incidental, special, or consequential loss,
  or for lost profits, revenue, goodwill, or data. Our total aggregate liability is limited to the fees you paid in the
  twelve months before the event giving rise to the claim, or one hundred dollars if you have paid us no fees.</p>

  <h2>11. Indemnity</h2>
  <p>You will indemnify us against claims arising from your outreach, your lists, or your breach of these Terms —
  including regulatory action and recipient complaints.</p>

  <h2>12. Changes to these Terms</h2>
  <p>We may update these Terms; material changes will be posted here with a new date and, for paid accounts, notified
  by email. Continued use after the effective date means you accept them.</p>

  <h2>13. Governing law</h2>
  <p>These Terms are governed by the laws of <span class="todo">${esc(JURISDICTION)}</span>, and the courts there have
  exclusive jurisdiction, without prejudice to mandatory consumer protections in your own country.</p>

  <h2>14. Contact</h2>
  <p>${esc(ENTITY)} — <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a></p>
`,
}

const acceptableUse = {
  path: '/acceptable-use',
  title: 'Acceptable Use Policy',
  summary: `<strong>The short version:</strong> no purchased or scraped lists you have no basis to contact, no deception
    about who you are, no phishing or malware, no harassment, and no volume that damages the shared reputation of the
    platform. Breaching this policy is grounds for immediate suspension.`,
  body: `
  <p>This policy applies to everyone using ${esc(APP_LEGAL_NAME)} and to every message sent through it.</p>

  <h2>Prohibited outreach</h2>
  <ul>
    <li>Messaging people you have no lawful basis to contact, including lists bought from a broker or scraped without
    a legitimate interest assessment where one is required</li>
    <li>Falsifying sender identity, reply-to addresses, headers, or the nature of your business</li>
    <li>Misleading subject lines, fake reply threads (“Re:” on a first contact), or fabricated prior relationships</li>
    <li>Removing, obscuring, or breaking the unsubscribe mechanism</li>
    <li>Continuing to contact anyone who opted out or asked you to stop</li>
    <li>Sending to addresses harvested from the platform's own inbound replies for unrelated campaigns</li>
  </ul>

  <h2>Prohibited content</h2>
  <ul>
    <li>Phishing, credential harvesting, malware, or links to either</li>
    <li>Fraud, deceptive financial offers, or impersonation of another organisation</li>
    <li>Harassment, threats, hate speech, or content that targets a person or protected group</li>
    <li>Sexually explicit material, or promotion of illegal goods and services</li>
    <li>Content that infringes someone else's intellectual property</li>
  </ul>

  <h2>Prohibited technical behaviour</h2>
  <ul>
    <li>Circumventing per-mailbox daily limits, rate limits, or plan limits</li>
    <li>Automating account creation, or operating accounts to evade a suspension</li>
    <li>Probing, scanning, or load-testing the platform without written permission</li>
    <li>Reselling or white-labelling access unless your agreement permits it</li>
  </ul>

  <h2>Deliverability hygiene we expect</h2>
  <ul>
    <li>Authenticate your sending domain with SPF, DKIM, and DMARC</li>
    <li>Warm new mailboxes gradually rather than starting at the daily cap</li>
    <li>Keep an unsubscribe edge in every playbook and a terminal node for lost leads</li>
    <li>Remove hard bounces and stop campaigns that draw complaints</li>
  </ul>

  <h2>Enforcement</h2>
  <p>We investigate reports of abuse. Depending on severity we may warn you, throttle sending, suspend a mailbox,
  suspend the account, or terminate it — and we will cooperate with lawful requests from regulators and mailbox
  providers. Report abuse to <a href="mailto:${esc(SUPPORT_EMAIL)}">${esc(SUPPORT_EMAIL)}</a>.</p>
`,
}

const dpa = {
  path: '/dpa',
  title: 'Data Processing Addendum',
  summary: `<strong>The short version:</strong> for the prospect data you upload, you are the controller and we are your
    processor. We process it only on your instructions, keep it confidential, use the sub-processors listed publicly,
    help you answer data-subject requests, notify you of breaches without undue delay, and delete it when you leave.`,
  body: `
  <p>This Addendum forms part of the <a href="/terms">Terms of Service</a> between you (“Controller”) and
  ${esc(ENTITY)} (“Processor”) and applies whenever we process personal data on your behalf. Customers who need a
  countersigned copy, or the Standard Contractual Clauses executed separately, should contact
  <a href="mailto:${esc(PRIVACY_EMAIL)}">${esc(PRIVACY_EMAIL)}</a>.</p>

  <h2>1. Scope of processing</h2>
  <table>
    <tr><th>Subject matter</th><td>Providing the lead-generation and outreach platform</td></tr>
    <tr><th>Duration</th><td>The term of your subscription, plus the deletion window in §7</td></tr>
    <tr><th>Nature and purpose</th><td>Storage, enrichment, email composition and delivery, reply retrieval and classification, reporting</td></tr>
    <tr><th>Types of personal data</th><td>Business contact details (name, work email, employer, job title), notes you add, email correspondence with those contacts, engagement events</td></tr>
    <tr><th>Categories of data subject</th><td>Your prospects and contacts; your own team members</td></tr>
  </table>
  <p>You must not upload special-category data, payment card numbers, health data, or government identifiers. The
  platform is not designed for them.</p>

  <h2>2. Our obligations</h2>
  <ul>
    <li>Process personal data only on your documented instructions, including the instruction inherent in your use of the product</li>
    <li>Ensure people authorised to process it are bound by confidentiality</li>
    <li>Implement appropriate technical and organisational measures (see <a href="/security">Security</a>)</li>
    <li>Assist you, so far as reasonably possible, with data-subject requests, impact assessments, and regulator consultations</li>
    <li>Make available the information needed to demonstrate compliance and allow audits on reasonable notice, no more than once a year unless a regulator requires otherwise</li>
  </ul>

  <h2>3. Your obligations</h2>
  <ul>
    <li>Ensure you have a lawful basis to process and to contact every person you upload</li>
    <li>Provide any notice and obtain any consent your law requires</li>
    <li>Keep your instructions lawful; we will tell you if an instruction appears to breach data-protection law</li>
  </ul>

  <h2>4. Sub-processors</h2>
  <p>You give general authorisation for the sub-processors listed at <a href="/sub-processors">/sub-processors</a>. We
  will give notice before adding a new one, and you may object on reasonable data-protection grounds — if we cannot
  resolve the objection you may terminate the affected service and receive a pro-rata refund. Each sub-processor is
  bound by terms no less protective than these.</p>

  <h2>5. International transfers</h2>
  <p>Where personal data is transferred out of the UK, EEA, or another restricted jurisdiction, we rely on an adequacy
  decision or the Standard Contractual Clauses with any required supplementary measures.</p>

  <h2>6. Personal data breaches</h2>
  <p>We will notify you without undue delay after becoming aware of a personal data breach affecting your data, with
  the information available to us, and will keep you updated as we investigate.</p>

  <h2>7. Return and deletion</h2>
  <p>You can export or delete your data at any time from the product. On termination we delete workspace content within
  30 days, other than copies in encrypted backups which age out on the backup cycle, and anything we must retain by law.</p>

  <h2>8. Precedence</h2>
  <p>If this Addendum conflicts with the Terms of Service on the processing of personal data, this Addendum prevails.</p>
`,
}

const subProcessors = {
  path: '/sub-processors',
  title: 'Sub-processors',
  summary: `<strong>The short version:</strong> the list below is every third party that can touch your data, and what
    each one is for. Which ones apply depends on how your deployment is configured — a self-hosted instance with no AI
    key set uses none of the AI providers.`,
  body: `
  <p>We give notice before adding a sub-processor. To be told when this page changes, email
  <a href="mailto:${esc(PRIVACY_EMAIL)}">${esc(PRIVACY_EMAIL)}</a>.</p>

  <table>
    <tr><th>Sub-processor</th><th>Purpose</th><th>Data it can see</th><th>Applies when</th></tr>
    <tr>
      <td>Auth0 (Okta)</td>
      <td>Authentication and identity</td>
      <td>Email address, name, profile picture</td>
      <td>Auth0 sign-in is configured</td>
    </tr>
    <tr>
      <td>Google LLC</td>
      <td>Gmail send and read for connected mailboxes</td>
      <td>Your mailbox contents accessed under the granted scopes</td>
      <td>You connect a Gmail mailbox</td>
    </tr>
    <tr>
      <td>Anthropic PBC</td>
      <td>Email composition, reply classification, research, goal planning</td>
      <td>Prompt content: business context, lead fields, thread text</td>
      <td>An Anthropic key is configured for the deployment</td>
    </tr>
    <tr>
      <td>OpenAI</td>
      <td>Same AI functions, when selected as the provider</td>
      <td>Prompt content: business context, lead fields, thread text</td>
      <td>An OpenAI key is configured for the deployment</td>
    </tr>
    <tr>
      <td>Hosting provider</td>
      <td>Running the application and its database</td>
      <td>All workspace data at rest</td>
      <td>Hosted deployments; self-hosted operators are their own provider</td>
    </tr>
  </table>

  <h3>Not used</h3>
  <p>No advertising networks, no third-party analytics or session-recording scripts, and no data brokers. The platform
  ships with no tracking scripts of any kind on its marketing pages.</p>

  <h3>AI provider terms</h3>
  <p>The AI providers above act as processors and, under their standard API terms, do not train their general models on
  API inputs or outputs. Where a deployment has no AI key configured, the agent falls back to deterministic templates
  and a keyword classifier and no content leaves the deployment.</p>
`,
}

const cookies = {
  path: '/cookies',
  title: 'Cookie Policy',
  summary: `<strong>The short version:</strong> one cookie, and it only exists once you sign in. No advertising cookies,
    no analytics cookies, and nothing to consent to on the marketing pages — which is why you were not shown a banner.`,
  body: `
  <h2>What we set</h2>
  <table>
    <tr><th>Name</th><th>Purpose</th><th>Type</th><th>Lifetime</th></tr>
    <tr>
      <td><code>htm_session</code></td>
      <td>Keeps you signed in to your workspace. Contains a signed reference to your user record — no personal data in the value itself.</td>
      <td>Strictly necessary, first-party, HTTP-only, <code>SameSite=Lax</code>, <code>Secure</code> in production</td>
      <td>7 days, or until you sign out</td>
    </tr>
  </table>

  <h2>What we do not set</h2>
  <ul>
    <li>No advertising or retargeting cookies</li>
    <li>No third-party analytics, heatmap, or session-recording cookies</li>
    <li>No cross-site tracking of any kind</li>
  </ul>
  <p>Because the only cookie is strictly necessary for a service you asked for, no consent banner is required under the
  ePrivacy rules — so we do not show one.</p>

  <h2>Third parties during sign-in</h2>
  <p>If your deployment uses Auth0, signing in redirects you to Auth0, which sets its own cookies on its own domain
  under its own policy. Connecting Gmail redirects you to Google, likewise. Neither sets cookies on our domain.</p>

  <h2>Email tracking</h2>
  <p>Emails sent by campaigns can include an open pixel and signed click-through links. These do not use cookies; they
  record that a specific message was opened or clicked so the sending workspace can measure its campaign. Recipients
  can stop all of it with the unsubscribe link in any message.</p>

  <h2>Controlling cookies</h2>
  <p>You can clear or block cookies in your browser, but blocking <code>htm_session</code> will prevent you from
  staying signed in.</p>
`,
}

// ---- router -----------------------------------------------------------------

export const LEGAL_DOCS = [privacy, terms, acceptableUse, dpa, subProcessors, cookies]

export const legalRouter = express.Router()

for (const doc of LEGAL_DOCS) {
  legalRouter.get(doc.path, (_req, res) => {
    res.type('html').send(page(doc))
  })
}
