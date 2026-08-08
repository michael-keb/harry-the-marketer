# Email Warm-Up, Sender Reputation, and the Design of a Legitimate AI Deliverability Engine

## TL;DR
- **The durable product opportunity is a compliance-aligned "deliverability telemetry and decisioning engine" — one that ingests real reputation signals (Gmail Postmaster Tools API, Microsoft SNDS, feedback loops, bounce/complaint webhooks, seed tests), computes safe sending limits, and recommends corrective action — NOT a reciprocal-engagement warm-up pool.** Artificial warm-up networks are being detected, discounted, and in Google's case explicitly prohibited: Gmail forced GMass to shut its warm-up system in January 2023 or lose Gmail API access, with Google telling GMass it "now consider[s] it a violation of their terms of service."
- **Provider requirements have converged and hardened**: Gmail (Feb 2024), Yahoo (Feb 2024), and Microsoft/Outlook (May 2025) now all require SPF+DKIM+DMARC alignment, one-click unsubscribe (RFC 8058), and a spam-complaint rate kept below 0.30% (target <0.10%) for bulk senders (defined as 5,000+ messages/day). Enforcement moved from junking to outright 5xx rejections through late 2025 — Microsoft returns a permanent "550; 5.7.515 Access denied" bounce.
- **What actually drives inbox placement is empirically clear**: authentication, low complaint rates, list hygiene (avoiding spam traps and bounces), consistent volume, and genuine recipient engagement. Volume-ramping and "warm-up scores" are supporting practices at best; peer-reviewed and provider evidence shows reputation is an amalgam of complaint/engagement/authentication signals, and closed-loop artificial engagement is increasingly a liability, not an asset.

## Key Findings

1. **Warm-up methodology is partly evidence-based, partly folklore.** Gradual volume ramping is endorsed by Google's own guidance ("Start with a low sending volume to engaged users, and slowly increase the volume over time") and by M3AAWG. But the reciprocal "warm-up pool" model — networks of mailboxes emailing each other and rescuing messages from spam — rests on generating artificial engagement that providers' ML systems increasingly detect and discount.

2. **The three big consumer providers now enforce a near-identical baseline.** The convergence (Gmail/Yahoo Feb 2024; Microsoft May 5, 2025) means authentication + low complaints + easy unsubscribe are table stakes, enforced with hard SMTP rejections.

3. **Reputation is observable but only through lagging, aggregated, privacy-protected signals.** Gmail Postmaster Tools (spam rate, auth, delivery errors; domain/IP reputation grades deprecated in v2), Microsoft SNDS (IP color, complaint %, trap hits), and feedback loops each expose slices. All are delayed 24–48h, thresholded, and hidden at low volume.

4. **Artificial warm-up is a declining and risky tactic.** Google's 2023 GMass action is the clearest enforcement signal; the deliverability community increasingly treats pool engagement as "theater."

5. **A legitimate AI engine is buildable** from these signals using contextual bandits (send-time/volume), propensity models (engagement/complaint prediction), composite time-decayed reputation scoring, and time-series anomaly detection (EWMA/CUSUM/change-point/isolation forest) — subject to serious statistical caveats (low base rates, delayed noisy feedback).

6. **Legal frameworks constrain the product.** Australia's Spam Act 2003 requires consent (express or inferred), sender identification, and functional unsubscribe; CASL is strictest (opt-in), GDPR requires a lawful basis, CAN-SPAM is opt-out. Any legitimate tool should enforce consent provenance and suppression, not simulate engagement.

## Details

### 1. Current email warm-up methodologies

**Volume ramping.** The core practice is starting a new domain/IP at low volume to engaged recipients and increasing gradually. Google's official sender guidelines explicitly instruct senders to "Start with a low sending volume to engaged users, and slowly increase the volume over time," to "send email at a consistent rate, avoid sending in bursts," and warn that "immediately doubling previously sent volumes suddenly could result in rate limiting or reputation drops." Google tracks volume/feedback/limits per domain AND per IP, with distinct DKIM/SPF quotas and a shared IP quota. Vendor playbooks operationalize this as ~20–40 emails/inbox/day scaling over 2–4 weeks; lemwarm suggests capping at 40/day and increasing in 5–10% steps; SMTP2GO cites four-to-six weeks to reach 100k/day on a new dedicated IP. The evidence base for *specific* ramp curves is weak — these are vendor heuristics, not peer-reviewed findings. What IS supported by provider documentation is the *direction*: gradual, consistent, engagement-first sending.

**Inbox/domain/subdomain rotation and mailbox pooling.** M3AAWG's Sending Domains Best Common Practices recommends assigning a separate subdomain per distinct sending purpose (e.g., transactional vs. marketing vs. prospecting) to isolate reputation, and notes "sending from different subdomains does not mean that the visible From: must also use the subdomain, so long as the organizational domains match." This is legitimate reputation *segmentation*. However, cold-outreach "mailbox pooling" (spreading volume across many inboxes/domains to stay under per-inbox caps and dodge reputation concentration) is a gray practice: providers track reputation at domain AND IP level, and Google warns that shared-IP activity affects all senders on that IP. Rotation to evade limits is exactly the "circumvent filters / bypass account limitations" behavior Google's API policy prohibits.

**Commercial warm-up pool networks (reciprocal engagement).** These connect a subscriber's inbox to a pool of other accounts that automatically open, reply, mark-as-important, and rescue messages from spam. lemwarm states its network "spans 20,000+ healthy domains" of real accounts; peer-to-peer networks use "thousands" of real opted-in mailboxes. The mechanism's fatal flaw is well described in the industry: "if 100% of your positive engagement comes from a closed loop of mailboxes that only ever email each other, that pattern is itself detectable." Filters flag templated content, mechanically regular timing, and rings of accounts that email only each other.

**Legitimate alternatives.**
- *Engagement-based sending / progressive segmentation*: send first to your most-engaged recipients, then widen — endorsed directly by Google ("start with a low sending volume to engaged users").
- *Seed-list testing*: tools like GlockApps (70+ seeds across Gmail/Outlook/Yahoo) and Validity Everest (panel of 250M+ inboxes) show where mail lands. Caveat: seed accounts have no genuine engagement history, so they under-predict real Gmail behavior in Workspace/M365 environments.
- *Re-engagement campaigns and sunset policies*: remove or win back recipients with no opens/clicks in 90–180 days to protect complaint and trap metrics.

**Folklore vs. evidence.** Google explicitly states it "doesn't track open rates," "can't verify third-party open rates," and that "low open rates aren't necessarily an accurate indicator." So "open rate" as a warm-up KPI is partly folklore. The empirically supported drivers are: authentication, spam-complaint rate, list hygiene (bounces, traps), consistent volume, and genuine engagement/reply signals.

### 2. How mailbox providers evaluate senders

**Gmail (from Feb 1, 2024).** Google defines "bulk senders" as "those sending 5,000 or more messages a day to Gmail users." All senders must set up SPF or DKIM, valid forward+reverse DNS (PTR), TLS, RFC 5322 formatting, and keep spam rates reported in Postmaster Tools below 0.3%. Bulk senders must additionally set up SPF *and* DKIM, publish DMARC (p=none minimum), align the From: header with either the SPF or DKIM domain, and support one-click unsubscribe (RFC 8058) processed within 2 days. Google's own guidance sets the working ceiling: keep the reported spam rate "below 0.10%" and "avoid ever reaching 0.30% or higher." Bulk-sender classification is permanent once triggered. Enforcement escalated from percentage-based rejection (2024) to active rejection/rate-limiting through November 2025.

**Microsoft/Outlook (from May 5, 2025).** For 5,000+/day to outlook.com, hotmail.com, live.com: SPF must pass, DKIM must pass, DMARC at least p=none aligned with SPF or DKIM. Per Microsoft's Defender for Office 365 blog "Strengthening Email Ecosystem: Outlook's New Requirements for High-Volume Senders," non-compliant mail is rejected with the permanent bounce string "550; 5.7.515 Access denied, sending domain [SendingDomain] does not meet the required authentication level." Microsoft announced it would initially route non-compliant high-volume mail to Junk after May 5 before moving to rejection. Microsoft weighs IP reputation heavily alongside domain reputation.

**Yahoo (from Feb 2024).** Mirrors Gmail: SPF+DKIM+DMARC with alignment, one-click unsubscribe, complaint rate under threshold, valid rDNS, TLS. Enforced "quietly but consistently."

**Postmaster Tools & SNDS signals.**
- *Gmail Postmaster Tools*: dashboards for spam rate, domain reputation (High/Medium/Low/Bad — being deprecated in the v2 transition), IP reputation (deprecated), authentication (SPF/DKIM/DMARC pass %), delivery errors, and a new Compliance Status (pass/fail vs. bulk requirements, assessed at parent-domain level). Data lags 24–48h, is hidden on low-volume days, and needs ~100+ (ideally a few hundred) daily Gmail recipients to populate. The Postmaster Tools API (RESTful, OAuth) exposes these programmatically; v1 was decommissioned Oct 31, 2025 and v2 became generally available in early 2026.
- *Microsoft SNDS*: IP-based; shows filter-result color (green = <10% spam verdicts), complaint rate (moves in tenths of a percent — anything above 0.1% signals a problem), spam trap hits (any hit warrants investigation), message volume, and sample data. Requires ~100+ msgs/day to Microsoft consumer domains; data appears in 24–48h. JMRP (Junk Mail Reporting Program) provides real-time complaint feedback for suppression.

**Signals used in reputation scoring** (synthesizing provider docs + peer-reviewed work): user-reported complaint rate (the single most damaging signal), engagement (opens/replies/"important"/deletes-without-reading), authentication pass/alignment, IP reputation, domain reputation (now weighted above IP at Gmail), list hygiene, spam-trap hits, hard/soft bounce rates, and content/URL reputation (Safe Browsing).

**Academic research on reputation and artificial-engagement detection.** IP-reputation filtering has documented limits: Esquivel, Mori & Akella, "On the Effectiveness of IP Reputation for Spam Filtering" (COMSNETS 2010), classify senders into legitimate servers, end-hosts, and spam gangs and show reputation alone is imperfect. Hao et al.'s SNARE (USENIX Security 2009) built a "Spatio-temporal Network-level Automatic Reputation Engine" using network-level features. Ramachandran, Feamster & Vempala, "Filtering Spam with Behavioral Blacklisting" (CCS 2007), cluster senders by *sending behavior* rather than IP — directly relevant to why coordinated warm-up rings are detectable: behavioral clustering catches accounts that behave alike regardless of identity. Stringhini et al.'s B@bel (USENIX Security 2012) detects bots via SMTP "dialects." Golbeck & Hendler's reputation-network analysis (CEAS 2004) formalizes graph-based email trust. The common thread: **filters model the graph and behavior of senders/recipients, so a closed loop of mailboxes exchanging templated mail on regular timing forms a detectable, low-diversity subgraph.** This is why reciprocal engagement gets discounted.

**Documented enforcement against warm-up.** The clearest primary-source action: in January 2023, GMass shut down its warm-up system after Google's ultimatum (details verified below). The broader trend — Gmail's Nov 2025 rejection enforcement, Microsoft's 550 rejections — reinforces that artificial signal generation is a declining, risky strategy.

### 3. AI-driven deliverability engine design (legitimate)

**Architecture (five layers):**

- **(A) Telemetry ingestion layer.** Connectors: Gmail Postmaster Tools API (OAuth; daily domainStats — spam rate, auth pass %, delivery errors, compliance status); Microsoft SNDS (IP color, complaint %, trap hits — via authenticated data access / CSV); ESP bounce/complaint webhooks (real-time hard/soft bounces, ARF complaint reports); feedback loops (Yahoo CFL, Microsoft JMRP, others); seed-list testing (GlockApps/Everest APIs for inbox-placement %); DNS/auth monitors (SPF/DKIM/DMARC records, DMARC aggregate RUA reports); blocklist checks (Spamhaus and other public RBLs). Store raw responses before normalizing; record "unavailable/permission-denied/no-data" distinctly from a true zero (a Postmaster Tools best practice).
- **(B) Normalization & feature store.** Harmonize to a per-(domain, subdomain, IP, mailbox-provider, day) schema. Reconcile latency: Postmaster/SNDS lag 24–48h; webhooks are near-real-time; seed tests on demand. Maintain rolling 7/30-day aggregates because daily data is noisy and privacy-thresholded.
- **(C) Decision layer.** (1) Safe-sending-limit calculator: current volume × reputation state × engagement mix → next-day cap, with conservative ramp when reputation is unproven. (2) Anomaly detectors on time-series metrics. (3) Propensity/segmentation models to prioritize recipients by predicted genuine engagement and suppress predicted complainers. (4) Contextual bandit for send-time/volume within safety caps.
- **(D) Action layer.** Throttle/pause, suppress addresses (bounces, complaints, traps, unsubscribes within required windows), route segments to different subdomains, flag content/URL/auth fixes, open incidents on blocklist hits or auth failures.
- **(E) Governance/compliance layer.** Consent provenance per contact, suppression enforcement, unsubscribe SLA (24–48h best practice; 2 days for Gmail; 10 business days max under CAN-SPAM), audit logging.

**Early risk detection.** Trigger on: rising 7-day spam rate approaching 0.10%; SNDS color shift green→yellow; DMARC/SPF/DKIM pass-rate drops; any spam-trap hit; blocklist appearance; bounce-rate spikes; sudden inbox-placement drop in seed tests; Gmail "USERS_DONT_WANT_MAIL" deliverability verdict despite low spam rate (signals high delete-without-open).

**Corrective action mapping.** Reputation degradation → throttle + revert to most-engaged segment. Trap hit → freeze acquisition source, audit list. Auth failure → fix DNS/alignment. High complaints → suppress source, cut frequency, review content. Blocklist → follow M3AAWG blocklist remediation (fix root cause, then delisting request).

### 4. Algorithmic approaches

**Contextual bandits / RL for send-volume and send-time.** Send-time optimization is well-modeled as a multi-armed/contextual bandit: choose a day-hour (or volume step), observe engagement reward, update. A leading production example is Yancey & Settles, "A Sleeping, Recovering Bandit Algorithm for Optimizing Recurring Notifications" (KDD 2020, doi:10.1145/3394486.3403351), which introduces the "Recovering Difference Softmax Algorithm" to "successfully optimize millions of daily reminders for the online language-learning app Duolingo," reporting "a 0.5% increase in total daily active users (DAUs) and a 2% increase in new user retention over a strong baseline." Epsilon-greedy and Thompson Sampling are the standard implementations. **Limitations**: reward is delayed and noisy (engagement arrives over days), the environment is non-stationary (recipient behavior and provider filters drift), and — critically — optimizing engagement must be *constrained* by deliverability safety so the bandit cannot "explore" into a volume spike that damages reputation. Cold-start is severe for new domains with no history.

**Predictive engagement / complaint models.** Open/click/reply propensity and churn/complaint prediction use logistic regression, gradient-boosted trees, and survival models. Sinha, Vinay & Singh, "Modeling Time to Open of Emails with a Latent State for User Engagement Level" (WSDM 2018), use a Cox proportional-hazards / survival framing with a latent engagement state — a strong fit for "time-to-open" and for deciding whom to keep mailing. Propensity-to-churn and propensity-to-engage models are standard in marketing. For a deliverability engine, the most valuable model is **complaint/negative-signal propensity**, used to *suppress* high-risk recipients before sending.

**Reputation scoring design.** Build a composite score from normalized sub-signals (complaint rate, auth pass, trap hits, bounce rate, engagement, blocklist status). Apply **time decay** (exponential/EWMA weighting so recent behavior dominates — matching how provider reputation "builds slowly and recovers slowly"). Weight complaint rate and trap hits most heavily (they require deliberate action / indicate list rot). Keep the composite interpretable and per-provider (Gmail and Microsoft disagree; don't average across them blindly).

**Anomaly detection on reputation time-series.** Appropriate methods, matched to metric behavior:
- *EWMA control charts* — detect small, gradual mean shifts (good for slow reputation drift); assign more weight to recent data.
- *CUSUM* — detect persistent shifts in the mean quickly (good for complaint-rate creep); classic SPC method (Page, 1954).
- *Change-point detection* (binary segmentation, Bayesian online change-point) — locate the day a regime changed (e.g., a bad campaign).
- *Seasonal decomposition* — separate weekly send-cycle seasonality from true anomalies.
- *Isolation Forest* (Liu, Ting & Zhou, 2008) — multivariate outlier detection across correlated metrics; outperforms Hotelling's T² in non-Gaussian settings; needs careful sliding-window sizing.
- *Autoencoders/LSTM* — for high-dimensional multivariate detection, but overkill and data-hungry at per-domain scale.
Recommendation: start with EWMA + CUSUM per metric (simple, interpretable, low-data) and add Isolation Forest for multivariate signals once enough history exists.

**Statistical caveats (critical).** (1) *Low base rates*: a 0.1% complaint threshold means 1 complaint per 1,000; at cold-outreach volumes, single events swing the rate wildly. SNDS complaint % only moves in tenths, so it is coarse. (2) *Delayed, noisy feedback*: 24–48h lag plus low-volume suppression means daily reactions chase noise; use rolling windows. (3) *Confounding*: content, list source, timing, and volume change together, making causal attribution hard. (4) *Small-sample per-domain metrics*: many cold-email setups never reach Postmaster's display threshold, so the engine must degrade gracefully to seed tests, webhooks, and DMARC when provider dashboards are empty. (5) *Provider opacity*: Gmail's deprecation of domain/IP reputation scores in v2 means the engine must infer reputation from complaint/auth/engagement proxies, not a published grade.

### 5. Competitive landscape

**Reciprocal-engagement warm-up vendors** (all use pool-based engagement simulation; the model is under pressure):
- **Warmbox** — standalone warm-up, ~$19–29/inbox/month. Core value now bundled free by sequencers; "if you're paying Warmbox while on Instantly or Smartlead, stop today."
- **Mailreach** — standalone, ~$25–45/inbox/month; strongest reporting depth (spam placement across many clients by provider), Modern Auth/OAuth support, larger Gmail network; positioned as best standalone in 2026.
- **Lemwarm (lemlist)** — ~$29–49/inbox/month standalone, bundled in lemlist; network of "20,000+ healthy domains"; long track record; pricing has trended up.
- **Instantly** — warm-up bundled free in its platform (from ~$30/month, no inbox cap); rotates inboxes, simulates reads, runs inbox-placement tests.
- **Smartlead** — warm-up bundled (~$39/month flat, unlimited inboxes); per-inbox warm-up stats; auto spam-to-inbox rescue.
- **Newer/adjacent**: Warmforge, TrulyInbox (~$10–12/inbox), Warmup Inbox (~$15), Mailivery, Warmy, Folderly, plus "pre-warmed inbox" sellers (e.g., Litemail from ~$4.99/inbox) that sidestep warm-up entirely.

**Viability of the reciprocal-pool model.** Declining. Google prohibits it; ML behavioral clustering detects closed loops; the community increasingly calls it "theater." Vendors have shifted toward (a) real-account peer-to-peer networks (opted-in real mailboxes) to make signals more authentic, (b) placement *testing/reporting* rather than just engagement generation (Mailreach's pivot), and (c) bundling warm-up as a free feature while monetizing sending/analytics. Vendor effectiveness claims (e.g., "4–5x placement gap," "40–60% better than no warm-up," "91.3% vs 68.4% placement") are directional marketing figures not traceable to independent peer-reviewed research — treat with skepticism.

**Legitimate adjacent tooling** (the durable category):
- *Deliverability monitoring / seed testing*: GlockApps (~$59–129/month; 70+ seeds; DMARC + blocklist monitoring), Validity Everest (250M+ inbox panel; enterprise), plus free MxToolbox, Google Postmaster Tools, Sender Score, Talos.
- *ESP-native reputation tooling*: SendGrid, Mailgun, Postmark expose bounce/complaint/SNDS-backed reputation and enforce AUP bounce/complaint limits.
- *DMARC/auth platforms*: dmarcian, Valimail, EasyDMARC, PowerDMARC, Red Sift OnDMARC.

### 6. Legal and policy constraints

- **Australia — Spam Act 2003 (Cth), enforced by ACMA.** Consent-based: a commercial electronic message needs express or inferred consent. ACMA (Statement of Expectations, 1 July 2024) prefers documented express consent. Inferred consent supports B2B cold email where a work address is "conspicuously published" and the message is relevant to the recipient's role. Every CEM must (1) have consent, (2) identify the sender with accurate contact info, (3) include a functional unsubscribe. Address-harvesting software and harvested lists are prohibited. This was tested in *ACMA v Clarity1 Pty Ltd* [2006] FCA 1399 (Federal Court, Justice Nicholson, 27 Oct 2006) — ACMA's first successful Spam Act prosecution — where the Court imposed a total A$5.5M penalty ("$4.5 million against Clarity1 Pty Ltd and $1 million against its managing director, Mr Wayne Mansfield") for sending "at least 231 million commercial emails" using harvested address lists. Note also that ACMA states "you cannot send an electronic message to ask for consent" — a consent-request email is itself marketing.
- **CASL (Canada)** — strictest: express or implied consent *before* sending; B2B "conspicuously published" exception exists; penalties up to CAD $10M per violation.
- **GDPR (EU/UK)** — requires a lawful basis; B2B cold email often relies on "legitimate interest" with a documented balancing test; must honor access/erasure and opt-out "without undue delay" (24–48h best practice); sole-trader/personal addresses get full protection; Germany effectively requires prior consent. Under Art. 83(5) GDPR, fines reach "up to 20 000 000 EUR, or in the case of an undertaking, up to 4 % of the total worldwide annual turnover of the preceding financial year, whichever is higher."
- **CAN-SPAM (US)** — most permissive: opt-out, no prior consent; requires honest headers/subject, physical postal address, functional opt-out honored within 10 business days. The FTC's inflation-adjusted maximum is $53,088 per email, effective January 17, 2025 (Federal Register Doc. 2025-01361); the largest CAN-SPAM settlement to date is Verkada Inc.'s $2.95M (FTC, Aug. 2024).
- **Provider ToS** — Gmail/Google Workspace AUP and API policy prohibit using multiple accounts to bypass limitations, circumvent filters/spam, or subvert restrictions — the basis for the warm-up crackdown. Microsoft and Yahoo require valid P2 sender addresses, functional unsubscribe, and list hygiene.

**How this constrains product design.** A legitimate engine must: enforce consent provenance and per-jurisdiction rules per contact; build to the highest common standard (CASL/GDPR) to satisfy looser regimes; make suppression and unsubscribe SLAs first-class; and *not* generate artificial engagement or rotate accounts to evade limits. The compliance layer is a differentiator, not overhead.

## Recommendations

**Phase 0 — Foundation (weeks 0–6): "Measure, don't manipulate."**
Build the telemetry ingestion + normalization layers and a monitoring dashboard. Connect Postmaster Tools API, SNDS, DMARC aggregate reports, ESP bounce/complaint webhooks, feedback loops, and one seed-testing provider. Ship EWMA+CUSUM alerting on spam rate, SNDS color, auth pass-rate, bounce rate, and trap hits. This alone is a sellable MVP (a "single pane of glass" reputation monitor) and is fully compliant.
*Benchmark to advance*: reliable daily ingestion across ≥2 providers; alert precision good enough that operators act on ≥80% of alerts.

**Phase 1 — Decisioning (weeks 6–14): safe-limit calculator + suppression.**
Add the safe-sending-limit engine (reputation-state-aware ramp), complaint/bounce-propensity suppression, engagement-based segmentation, and automated corrective-action recommendations. Enforce the compliance layer (consent provenance, unsubscribe SLA).
*Benchmark*: demonstrably keep pilot senders' spam rate <0.10% and bounce rate <2% while maintaining or growing engaged volume.

**Phase 2 — Optimization (weeks 14–24): bandits + predictive models.**
Add contextual-bandit send-time/volume optimization *constrained by* Phase-1 safety caps, and propensity models for prioritization. Add Isolation Forest multivariate anomaly detection once ≥90 days of history exists.
*Benchmark*: bandit lifts engagement without breaching any safety threshold in holdout tests.

**Phase 3 — Scale/differentiate:** multi-domain/agency reporting (Postmaster batchQuery up to 100 domains), predictive reputation forecasting, and content/URL risk scoring.

**Thresholds that should change the strategy:**
- If a provider **publishes richer programmatic reputation data**, lean harder into decisioning.
- If a provider **further restricts APIs or feedback loops**, pivot toward DMARC + seed testing + first-party engagement as the signal base.
- If pilot data shows warm-up-pool features correlate with **reputation drops**, drop them entirely — the risk asymmetry (one ruined domain = months of lost output) favors caution.

**Do NOT build**: a reciprocal-engagement pool, account-rotation-to-evade-limits, or open-rate-pixel-based "warm-up scores" as a core value prop. These are the eroding, non-durable, ToS-adjacent approaches.

## Caveats
- **Vendor effectiveness numbers are marketing, not research.** Claims like "4–5x placement," "91.3% vs 68.4%," and specific warm-up ramp curves come from vendor blogs; none trace to peer-reviewed studies. The peer-reviewed literature covers spam filtering and reputation mechanics, not the efficacy of commercial warm-up products.
- **Provider internals are opaque and changing.** Gmail deprecated domain/IP reputation grades in Postmaster v2; exact filtering signals are unpublished. The engine must infer reputation from proxies and accept that "reputation" is an amalgam, per Google's own framing.
- **Data is lagging, thresholded, and often empty at cold-email volumes.** Postmaster needs ~100+ daily Gmail recipients; SNDS needs ~100+/day to Microsoft; both lag 24–48h and hide low-volume days. Small-sample per-domain metrics are statistically fragile.
- **The GMass action is one documented case, not a comprehensive enforcement record.** Google has not published a warm-up "ban" as formal policy; the prohibition is expressed through API policy language and direct enforcement. Some third-party accounts conflate dates and figures.
- **Legal summaries here are not legal advice.** Consent rules (especially GDPR national variations and CASL) are fact-specific; an Australian operator emailing globally must apply the strictest applicable regime per contact.

---
*Primary-source verification of the GMass enforcement action*: On January 19, 2023, GMass founder Ajay Goel published "GMass's Email Warmup System Is Shutting Down," announcing the warm-up system would cease January 31, 2023. Goel wrote that "Google flat out told us to shut down our warmup system or we'd lose our Gmail API access," and that Google "made it clear they don't want warmup taking place at all" and "now consider it a violation of their terms of service." The blog cited "more than 80,000 email accounts at any given time." In a February 1, 2023 tweet, Goel reported the system had sent "1,295,152,830 warm-up emails for 236,084 email accounts over two years." A follow-up (Feb 8, 2023) stated Google would not even allow GMass to "MENTION warmup of Google accounts" on its site. This is the clearest documented enforcement action against artificial warm-up and the strongest evidence that the reciprocal-pool model is a non-durable foundation for a product.