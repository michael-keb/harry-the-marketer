// Single source of truth for the public marketing site.
//
// Imported by BOTH the React site (web/src/site/*) and the Express server
// (server/site.js builds sitemap.xml + injects per-route <meta> so crawlers and
// social scrapers that never run JavaScript still see the right tags).
//
// Change copy, pricing, and page titles here — not in the components.

// ---- brand ------------------------------------------------------------------

// Matches APP_LEGAL_NAME in server/legal.js and the Google OAuth consent screen.
// Per LOGO-BRIEF.md §4 the casing is "Harry The Marketer" everywhere.
export const BRAND = {
  name: 'Harry The Marketer',
  // The wordmark splits here: "Harry The" + accent("Marketer").
  nameLead: 'Harry The',
  nameAccent: 'Marketer',
  tagline: 'Playbooks are diagrams.',
  promise: 'Outreach campaigns you can draw.',
  description:
    'Draw your outreach campaign as a flowchart. An AI agent runs it against your real inbox — composing each email, reading replies, classifying intent, and following the branch each lead earns.',
  supportEmail: 'support@harrythemarketer.com',
  privacyEmail: 'privacy@harrythemarketer.com',
  securityEmail: 'security@harrythemarketer.com',
  // Fallback only — the server always passes the real APP_URL through.
  defaultOrigin: 'https://harrythemarketer.com',
}

// ---- navigation -------------------------------------------------------------

export const SITE_NAV = [
  { to: '/product', label: 'Product' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/security', label: 'Security' },
  { to: '/about', label: 'About' },
  { to: '/contact', label: 'Contact' },
]

export const FOOTER_NAV = [
  {
    title: 'Product',
    links: [
      { to: '/product', label: 'How it works' },
      { to: '/product#playbooks', label: 'Playbook syntax' },
      { to: '/product#engine', label: 'The engine' },
      { to: '/product#reports', label: 'Reports & learning' },
      { to: '/pricing', label: 'Pricing' },
    ],
  },
  {
    title: 'Company',
    links: [
      { to: '/about', label: 'About' },
      { to: '/security', label: 'Security' },
      { to: '/contact', label: 'Contact' },
      { to: '/signup', label: 'Start free trial' },
      { to: '/login', label: 'Sign in' },
    ],
  },
  {
    title: 'Legal',
    // Server-rendered (server/legal.js) so they work without JavaScript —
    // Google's OAuth reviewers fetch /privacy and /terms directly.
    links: [
      { href: '/privacy', label: 'Privacy Policy' },
      { href: '/terms', label: 'Terms of Service' },
      { href: '/acceptable-use', label: 'Acceptable Use' },
      { href: '/dpa', label: 'Data Processing' },
      { href: '/sub-processors', label: 'Sub-processors' },
      { href: '/cookies', label: 'Cookies' },
    ],
  },
]

// ---- pricing ----------------------------------------------------------------
//
// PRICES ARE A STARTING PROPOSAL — benchmarked against the self-serve tier of the
// category (Smartlead $39, Instantly $47, Apollo Basic $49, Saleshandy $36) and
// its conventions: published tiers + "contact sales", ~2 months free on annual.
// Entry to the product is a free trial of a paid plan — there is no free tier.
// Every number below is safe to edit; nothing else in the codebase hardcodes them.

export const ANNUAL_DISCOUNT_NOTE = '2 months free'

export const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    monthly: 39,
    annual: 33,
    tagline: 'For a founder or operator running outreach themselves.',
    cta: 'Start free trial',
    ctaTo: '/signup?plan=starter',
    features: [
      '3 mailboxes (Gmail or sandbox)',
      '2,500 leads',
      'Unlimited campaigns',
      'Sandbox mailbox — simulate replies, no credentials needed',
      'AI composes every email from your business context',
      'AI reply classification routed through your diagram',
      'Inbox, Action Center, and thread view',
      'Open, click, and unsubscribe tracking',
    ],
    limits: { mailboxes: '3', leads: '2,500', campaigns: 'Unlimited', seats: '1' },
  },
  {
    id: 'growth',
    name: 'Growth',
    monthly: 99,
    annual: 82,
    featured: true,
    badge: 'Most popular',
    tagline: 'For a team that wants the agent planning as well as sending.',
    cta: 'Start free trial',
    ctaTo: '/signup?plan=growth',
    features: [
      '10 mailboxes',
      '25,000 leads',
      'Revenue Goals — state the outcome, the agent builds the campaign',
      'AI lead qualification with reasons and confidence',
      'AI company research profiles per lead',
      'Reports with per-step reply attribution',
      'Monitoring: every hop of the pipeline, graded live',
      '5 team seats on a shared workspace',
    ],
    limits: { mailboxes: '10', leads: '25,000', campaigns: 'Unlimited', seats: '5' },
  },
  {
    id: 'scale',
    name: 'Scale',
    monthly: null,
    annual: null,
    tagline: 'For agencies and teams with procurement, SSO, and a security review.',
    cta: 'Talk to us',
    ctaTo: '/contact?topic=scale',
    features: [
      'Unlimited mailboxes and leads',
      'SSO / SAML via Auth0',
      'Self-hosted or dedicated deployment',
      'Signed DPA and security review',
      'Uptime SLA and named support contact',
      'Onboarding and playbook design help',
    ],
    limits: { mailboxes: 'Unlimited', leads: 'Unlimited', campaigns: 'Unlimited', seats: 'Unlimited' },
  },
]

// Rows for the plan comparison table on /pricing. `values` is keyed by plan id.
export const PLAN_COMPARISON = [
  {
    group: 'Limits',
    rows: [
      { label: 'Mailboxes', values: { starter: '3', growth: '10', scale: 'Unlimited' } },
      { label: 'Leads stored', values: { starter: '2,500', growth: '25,000', scale: 'Unlimited' } },
      { label: 'Active campaigns', values: { starter: 'Unlimited', growth: 'Unlimited', scale: 'Unlimited' } },
      { label: 'Team seats', values: { starter: '1', growth: '5', scale: 'Unlimited' } },
    ],
  },
  {
    group: 'Campaign engine',
    rows: [
      { label: 'Diagram playbook editor', values: { starter: true, growth: true, scale: true } },
      { label: 'Server-side playbook validation', values: { starter: true, growth: true, scale: true } },
      { label: 'Sandbox mailbox + simulated replies', values: { starter: true, growth: true, scale: true } },
      { label: 'Gmail send + reply sync', values: { starter: true, growth: true, scale: true } },
      { label: 'Wait nodes and no-reply timeouts', values: { starter: true, growth: true, scale: true } },
      { label: 'Per-node performance breakdown', values: { starter: true, growth: true, scale: true } },
    ],
  },
  {
    group: 'AI agent',
    rows: [
      { label: 'Email composition', values: { starter: 'AI', growth: 'AI', scale: 'AI' } },
      { label: 'Reply intent classification', values: { starter: 'AI', growth: 'AI', scale: 'AI' } },
      { label: 'AI playbook generation', values: { starter: true, growth: true, scale: true } },
      { label: 'Revenue Goals (plan → campaign)', values: { starter: false, growth: true, scale: true } },
      { label: 'Lead qualification and ICP scoring', values: { starter: false, growth: true, scale: true } },
      { label: 'Company research profiles', values: { starter: false, growth: true, scale: true } },
    ],
  },
  {
    group: 'Insight & operations',
    rows: [
      { label: 'Inbox and Action Center', values: { starter: true, growth: true, scale: true } },
      { label: 'Open / click / unsubscribe tracking', values: { starter: true, growth: true, scale: true } },
      { label: 'Pipeline reports and conversion rates', values: { starter: true, growth: true, scale: true } },
      { label: 'Learning: reply attributed to playbook step', values: { starter: false, growth: true, scale: true } },
      { label: 'Live pipeline monitoring', values: { starter: false, growth: true, scale: true } },
    ],
  },
  {
    group: 'Governance',
    rows: [
      { label: 'One-click unsubscribe + List-Unsubscribe header', values: { starter: true, growth: true, scale: true } },
      { label: 'Per-mailbox daily send limits', values: { starter: true, growth: true, scale: true } },
      { label: 'Shared team workspace', values: { starter: false, growth: true, scale: true } },
      { label: 'SSO / SAML', values: { starter: false, growth: false, scale: true } },
      { label: 'Signed DPA', values: { starter: false, growth: false, scale: true } },
    ],
  },
]

// ---- product content --------------------------------------------------------

export const HERO_PLAYBOOK = `flowchart TD
    S([Start]) --> A[Send: short intro — one problem we solve for their role]
    A -- reply: interested --> B[Send: propose a 20-minute call, two time slots]
    A -- reply: question --> Q[Send: answer, then ask if a call makes sense]
    A -- reply: unsubscribe --> U([Unsubscribed])
    A -- no reply 3d --> F[Send: follow-up with one proof point]
    F -- no reply 4d --> L([Lost: no response])
    B -- reply --> W([Won: call booked])`

export const HOW_IT_WORKS = [
  {
    step: '01',
    title: 'Draw the playbook',
    body:
      'Write the campaign as a flowchart: send here, wait there, branch on what the reply actually says. The diagram renders as you type and is validated server-side — a campaign cannot launch on a broken graph.',
  },
  {
    step: '02',
    title: 'Connect a mailbox',
    body:
      'Connect Gmail with OAuth and the agent sends from your own address, in your own threads. Not ready for that? A sandbox mailbox runs the entire campaign locally and lets you simulate replies.',
  },
  {
    step: '03',
    title: 'Let the agent run it',
    body:
      'Every 20 seconds the engine works the graph: composes and sends, pulls new replies, classifies intent, follows the matching edge, honours no-reply timeouts, and parks anything ambiguous for you.',
  },
]

export const FEATURES = [
  {
    icon: 'goal',
    title: 'Revenue Goals',
    body:
      'Type the outcome in plain English — "20 qualified meetings with Australian SaaS companies using Jira". The agent extracts the target, builds the ICP, writes the playbook, scores your leads against it, and attaches the ones that fit.',
  },
  {
    icon: 'campaigns',
    title: 'Playbooks as diagrams',
    body:
      'The flowchart is not a picture of the campaign — it is the campaign. Change an edge, save, and the engine routes differently on the next tick. No drag-and-drop sequence builder to fight.',
  },
  {
    icon: 'inbox',
    title: 'Replies that route themselves',
    body:
      'Every reply is classified against your own edge labels — interested, question, not now, unsubscribe — and the lead follows the branch it earned. A reply that matches nothing is flagged for a human, never silently dropped.',
  },
  {
    icon: 'search',
    title: 'Research before the first line',
    body:
      'The agent researches each company before it writes: situation, likely pain, trigger, and personalisation hooks. Unknown data lowers confidence rather than being invented.',
  },
  {
    icon: 'reports',
    title: 'Reports that name the step',
    body:
      'A pipeline funnel with stage conversion, per-campaign reply and win rates, and a learning section that attributes every reply to the playbook step that earned it — so you know which step to rewrite.',
  },
  {
    icon: 'monitor',
    title: 'Monitoring, not vibes',
    body:
      'Every hop is instrumented: API, database, engine ticks, AI latency and failures, mailbox delivery, and success factors graded against cold-outreach benchmarks. When something stalls, the page says which hop.',
  },
]

export const DIFFERENTIATORS = [
  {
    title: 'It shows its working',
    body:
      'Most tools hide the sequence behind a builder UI and the AI behind a black box. Here the logic is a diagram you can read in ten seconds, and every decision the agent made is in the activity trail.',
  },
  {
    title: 'It degrades honestly',
    body:
      'No AI key configured? Template composition and a keyword classifier keep everything running, and the UI says which mode is active. No Gmail yet? Sandbox mailboxes run the full loop. Nothing pretends.',
  },
  {
    title: 'It respects the inbox',
    body:
      'Conservative per-mailbox daily limits, one-click unsubscribe with the List-Unsubscribe header, unsubscribe honoured even when your diagram forgets the edge, and hard stops on finished leads.',
  },
]

// Playbook DSL reference, mirrored from server/playbook.js conventions.
export const PLAYBOOK_SYNTAX = [
  { token: 'S([Start])', meaning: 'Exactly one start node.' },
  { token: 'A[Send: <instruction>]', meaning: 'The agent writes and sends an email from your instruction.' },
  { token: 'W2[Wait: 30d]', meaning: 'Pause, then continue. Units: m / h / d / w.' },
  { token: 'D{Reply?}', meaning: 'Optional decision diamond — a branch point.' },
  { token: 'A -- reply: interested --> B', meaning: 'Follow when a reply classifies to this intent.' },
  { token: 'A -- reply --> B', meaning: 'Any reply (catch-all edge).' },
  { token: 'A -- no reply 3d --> C', meaning: 'Timeout measured from the last email sent.' },
  { token: 'Won([Won: call booked])', meaning: 'Terminal. The first word sets the outcome: Won / Lost / Unsubscribed.' },
]

// ---- FAQ --------------------------------------------------------------------

export const FAQS = [
  {
    q: 'Do I need to know Mermaid to use this?',
    a: 'No. Every campaign starts from a working default playbook, and the AI can generate a whole diagram from a one-line brief. The syntax is roughly eight conventions — the editor validates as you type and tells you exactly what is wrong.',
  },
  {
    q: 'Does it send from my own Gmail?',
    a: 'Yes. You connect Gmail with Google OAuth and every email goes out through the Gmail API from your address, inside its own thread. Replies land in your normal inbox and are pulled back into the engine.',
  },
  {
    q: 'Can I try it without connecting a mailbox?',
    a: 'Yes. A sandbox mailbox records sends locally and lets you simulate replies, so you can run a complete campaign — branching, timeouts, outcomes and all — before any credentials change hands.',
  },
  {
    q: 'What happens when a reply does not match any branch?',
    a: 'The lead is flagged as needing attention and appears in the Action Center on the dashboard with the full thread. Nothing is silently dropped. You can reply by hand, or reclassify and let the engine re-route.',
  },
  {
    q: 'How do you handle unsubscribes?',
    a: 'Every outgoing email carries a one-click unsubscribe link and a List-Unsubscribe header. An unsubscribe is honoured immediately across every campaign, even if your diagram has no unsubscribe edge.',
  },
  {
    q: 'Is cold outreach legal where I am?',
    a: 'That depends on your jurisdiction and your list. GDPR, CAN-SPAM, and CASL all impose consent, sender-identification, and opt-out obligations, and the Google and Microsoft bulk-sender rules add authentication requirements. The product gives you the controls; complying is your responsibility, and the Terms say so plainly.',
  },
  {
    q: 'Which AI model runs the agent?',
    a: 'Either Anthropic Claude or OpenAI, configured per deployment. Without a key the agent falls back to deterministic templates and a keyword classifier, and the dashboard shows which mode is active.',
  },
  {
    q: 'Can I self-host it?',
    a: 'Yes. It is a single Node server with a SQLite database and no external runtime dependencies. Self-hosting is part of the Scale plan, and you keep every byte on your own infrastructure.',
  },
]

// ---- SEO --------------------------------------------------------------------

const t = (title) => `${title} — ${BRAND.name}`

// Per-route metadata. The server injects these into index.html for crawlers;
// the client re-applies them on navigation via web/src/site/seo.js.
export const PAGE_META = {
  '/': {
    title: `${BRAND.name} — outreach campaigns you can draw`,
    description:
      'Draw your outreach campaign as a flowchart and an AI agent runs it against your real inbox: composing each email, reading replies, classifying intent, and following the branch each lead earns.',
    changefreq: 'weekly',
    priority: '1.0',
  },
  '/product': {
    title: t('How it works'),
    description:
      'The playbook is a diagram, the engine executes it, and every reply routes itself. See the DSL, the tick loop, the inbox, and the reports that name which step earned the reply.',
    changefreq: 'monthly',
    priority: '0.9',
  },
  '/pricing': {
    title: t('Pricing'),
    description:
      'Starter $39/mo, Growth $99/mo with Revenue Goals and AI qualification, Scale for SSO and self-hosting. Every plan starts with a free trial. Two months free on annual.',
    changefreq: 'monthly',
    priority: '0.9',
  },
  '/security': {
    title: t('Security & data handling'),
    description:
      'What we access, what we store, where OAuth tokens live, how Gmail data is used under Google API Limited Use, sub-processors, retention, and how to revoke access.',
    changefreq: 'monthly',
    priority: '0.7',
  },
  '/about': {
    title: t('About'),
    description:
      'A quieter tool in a loud category: built for founders and operators who want outreach that shows its working, degrades honestly, and respects the inbox.',
    changefreq: 'monthly',
    priority: '0.6',
  },
  '/contact': {
    title: t('Contact'),
    description: `Questions about the product, security review, or the Scale plan — reach the team at ${BRAND.supportEmail}.`,
    changefreq: 'yearly',
    priority: '0.5',
  },
  '/login': {
    title: t('Sign in'),
    description: 'Sign in to your workspace.',
    noindex: true,
    changefreq: 'yearly',
    priority: '0.3',
  },
  '/signup': {
    title: t('Create your account'),
    description: 'Start your free trial and run your first playbook — no card, no mailbox required to start.',
    changefreq: 'yearly',
    priority: '0.8',
  },
}

// Server-rendered legal pages (server/legal.js) also belong in the sitemap.
export const LEGAL_ROUTES = [
  { path: '/privacy', title: 'Privacy Policy' },
  { path: '/terms', title: 'Terms of Service' },
  { path: '/acceptable-use', title: 'Acceptable Use Policy' },
  { path: '/dpa', title: 'Data Processing Addendum' },
  { path: '/sub-processors', title: 'Sub-processors' },
  { path: '/cookies', title: 'Cookie Policy' },
]

// Everything a crawler should see. /login is deliberately excluded (noindex).
export const SITEMAP_ROUTES = [
  ...Object.entries(PAGE_META)
    .filter(([, meta]) => !meta.noindex)
    .map(([path, meta]) => ({ path, changefreq: meta.changefreq, priority: meta.priority })),
  ...LEGAL_ROUTES.map((r) => ({ path: r.path, changefreq: 'yearly', priority: '0.3' })),
]

export const DEFAULT_META = PAGE_META['/']

export function metaForPath(pathname) {
  const clean = pathname.replace(/\/+$/, '') || '/'
  return PAGE_META[clean] || null
}
