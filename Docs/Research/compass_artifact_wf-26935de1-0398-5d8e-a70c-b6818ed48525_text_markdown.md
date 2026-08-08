# Building a Universal Email Sender Reputation Score: Science, Signals, Modelling and Commercial Opportunity

## Executive Summary

A universal, credit-score-style rating for email senders is technically buildable and commercially attractive, but the binding constraint is **ground truth, not modelling**. Mailbox providers (Gmail, Microsoft, Yahoo, Apple) keep their reputation systems private and are actively *reducing* the external signal they emit — Gmail retired its High/Medium/Low/Bad domain and IP reputation dashboards in Postmaster Tools v2 in September 2025. The strongest defensible product is a domain/IP-centric probabilistic risk score, calibrated to a small number of observable "bad" proxy labels (blocklist listings, complaint-rate breaches, bounce/block rates, spam-trap hits), sold as an API and dashboard for three buyers: senders/ESPs (deliverability), inbound filters (anti-abuse), and third-party/vendor-risk teams (cyber ratings adjacency).

The user's proposed weights (Authentication 20%, Engagement 25%, Complaint Risk 20%, Infrastructure 15%, Sending Behaviour 20%) are directionally reasonable but over-weight authentication (now table-stakes, low discriminatory power) and treat engagement as if it were externally observable (it largely is not, post-Apple MPP). An evidence-based re-weighting shifts mass toward complaint risk and list-hygiene/trap proxies, which are the signals that actually predict the observable "bad" outcomes.

The commercial landscape is crowded but fragmented: Validity (Sender Score, an IP-based 0–100 percentile) and Spamhaus (DNSBL/DQS) anchor the incumbents, Google Postmaster Tools is the free "good-enough" substitute that caps willingness-to-pay, and DMARC-analytics vendors (Red Sift, Valimail, dmarcian, EasyDMARC, PowerDMARC) own the authentication niche. The whitespace is a **cross-provider, entity-resolved, calibrated composite** with explainable reason codes and a data-flywheel moat from consented first-party performance telemetry.

---

## TL;DR

- **A universal email "credit score" is feasible and there is a real market gap** for a cross-provider, calibrated, explainable composite — but the hard part is obtaining ground-truth labels on inbox placement, not the machine learning; every serious design decision must be organised around proxy labels (blocklist hits, complaint-rate breaches, bounce/block codes, trap hits) and their noise.
- **Re-weight the user's model away from authentication and raw engagement toward complaint risk and list-hygiene/trap proxies**: authentication (SPF/DKIM/DMARC) is now mandatory table-stakes with low discriminatory power, and engagement is mostly not externally observable — especially since Apple Mail Privacy Protection (Sept 2021) inflates opens to near-100% for Apple Mail users. Apple accounted for 49.29% of email opens in January 2025 (Litmus), making it the single largest email client, and Litmus reported that as of March 2024 MPP accounted for 55% of all opens.
- **Adopt credit-scoring machinery wholesale** — WoE/IV binning, a logistic-regression scorecard for the interpretable core, points-to-double-the-odds scaling to a 0–1000 range, gradient boosting for a challenger model, calibration (Platt/isotonic), and PSI/Gini/KS monitoring — layered with time-decay of negative events, graph propagation for thin-file entities, and reason codes for adverse-action-style explanations.

---

## Key Findings

1. **The industry has shifted decisively from IP-centric to domain-centric reputation**, because IPs are shared, rotated and cheap to abandon, while a domain is a "sticky," portable identifier that follows a sender across infrastructure changes. IP reputation is the SMTP-connection gatekeeper; domain reputation drives inbox-vs-spam placement. Practitioner-reported recovery times: IP reputation ~2–4 weeks of good sending, domain reputation ~6–12 weeks.

2. **Gmail has reduced external visibility.** Postmaster Tools v2 removed the High/Medium/Low/Bad domain and IP reputation buckets (v1 dashboard retired 30 September 2025; v1 API decommissioned 31 October 2025; a v2beta API developer preview with Compliance Status data was released 2 December 2025). Spam rate (target <0.1%, hard ceiling 0.3%) and Compliance Status (Pass/Needs Work) are now the primary Gmail-side signals. This *increases* the value of a third-party score but also removes a key input feed.

3. **The Google/Yahoo bulk-sender mandate (effective 1 February 2024) and Microsoft's high-volume mandate (effective 5 May 2025) turned authentication into table-stakes.** All three require SPF + DKIM + DMARC (min p=none) with alignment, one-click unsubscribe (RFC 8058), and a spam-complaint rate under 0.3% for senders above 5,000 messages/day to consumer inboxes. Microsoft rejects non-compliant mail with `550 5.7.515`. Because everyone must now authenticate, authentication *presence* has low discriminatory power; authentication *strength and hygiene* still carries some.

4. **DMARCbis was published as RFCs in May 2026**, obsoleting the 2015 Informational RFC 7489 and the Experimental PSD RFC 9091: **RFC 9989** (core DMARC, now Proposed Standard), **RFC 9990** (aggregate reporting), **RFC 9991** (failure reporting). Key changes: a DNS Tree Walk replaces the Public Suffix List for organizational-domain discovery (capped at eight DNS queries); the `pct=` tag is removed (replaced by a binary `t=` test flag); new `psd=` and `np=` tags; and explicit guidance discouraging sole reliance on `p=reject` for indirect flows. (Note: the user's references to "RFC 9557" for DMARCbis and to "RFC 9091 SPF-none deprecation" were incorrect — RFC 9091 is the Experimental PSD DMARC extension, now obsoleted; SPF remains RFC 7208 with no alignment deprecation, though its `ptr` mechanism is marked "do not use.")

5. **Complaint rate is the single most operationally decisive external signal**, with hard thresholds now codified across providers (0.1% target / 0.3% ceiling). But feedback-loop coverage is uneven: Microsoft (JMRP) and Yahoo (CFL) offer per-message-ish FBLs; Gmail offers only an aggregated Postmaster spam rate plus an ESP-identifier FBL, not a per-message consumer FBL.

6. **Spam-trap data is the highest-value, least-purchasable signal.** M3AAWG's taxonomy (pristine/pure, recycled, typo) maps trap hits to distinct failure modes — pristine ⇒ purchased/scraped lists; recycled ⇒ poor bounce handling/stale lists (M3AAWG suggests a 12-month minimum inactivity before an address is recycled into a trap); typo ⇒ data-entry hygiene. Trap networks (Spamhaus, Abusix) are deliberately secret and cannot be bought, which is exactly why they form a moat.

7. **Ground truth is the fundamental problem.** No external party observes true inbox placement across providers. Any score must be trained against noisy proxy labels, with the survivorship/selection-bias caveat that complaint and spam-rate data only exist if *some* mail reached inboxes — a sender that Gmail fully blocks emits almost no complaint signal.

---

## Research Question 1 — How Mailbox Providers Calculate Sender Reputation Internally

**What is documented vs. folklore.** The precise internal reputation algorithms of Gmail, Outlook/Hotmail, Yahoo/AOL and Apple iCloud are **not public** and are not credibly reverse-engineered at the level of weights. What *is* documented: (a) the *signals* providers say they use (authentication, spam-complaint rate, list hygiene/bounces, engagement, sending consistency); (b) coarse output buckets (Gmail's former High/Medium/Low/Bad; Talos Good/Neutral/Poor; Sender Score 0–100); and (c) hard thresholds published in sender guidelines. Anything more granular (exact weights, half-lives) is practitioner folklore inferred from black-box behaviour and should be labelled as such.

**IP vs domain vs subdomain vs "sender identity."** The clear, well-supported trend is from IP-centric to domain-centric reputation, with an emerging layer of *identity* reputation keyed on the DKIM `d=` domain and the DMARC-aligned From domain (this is precisely what RFC 7070/7071/7073 anticipated: reputation queries keyed on validated DKIM `d=`, SPF-validated MAIL FROM, and rfc5322.From). Subdomain reputation exists but "rolls up" to the organizational domain in most provider treatments; the DMARCbis DNS Tree Walk formalises how organizational domains are discovered. Practitioner consensus: reputation flows *down* from organizational domain to subdomain more readily than it flows *up*, which is why senders isolate marketing vs transactional streams on separate subdomains.

**Warm-up, decay, aging, recovery.** No provider publishes a decay function. Observed/practitioner behaviour: Gmail's Postmaster reputation was smoothed over roughly a 7-day rolling window (so ratings lag actual behaviour by days), and Validity's Sender Score is an explicit rolling 30-day average. Recovery is asymmetric and slower than degradation — a single bad campaign can drop a rating within 24–48 hours, but rebuilding to the prior level takes weeks. This asymmetry is a design lesson: negative events should decay slowly (long half-life), and the score must resist permanent destruction from one incident (see §3 time dynamics).

**Shared vs dedicated IP, pools, neighbourhood, CIDR/ASN.** Shared IPs mean a sender inherits pool-mates' behaviour; dedicated IPs isolate reputation but require sustained volume to warm and hold. Microsoft is documented as weighting IP reputation more heavily than Gmail, so shared-IP contamination hurts more at Outlook. Neighbourhood/CIDR/ASN effects are real and are the core insight of the academic SNARE work (below): the AS number of the sender was the single most important feature for classifying senders, and dense ranges of non-mail-service hosts (bot space) are predictive of spam.

**Engagement signals.** Providers confirm they use user actions: positive (opens, replies, clicks, "not spam," moving to Primary, adding to contacts) and negative (this-is-spam reports, delete-without-read, immediate unsubscribe). Practitioner consensus and provider statements indicate *replies and this-is-spam reports carry more weight than opens* because they are harder to fake, and Gmail leans more heavily on engagement than Outlook does. The exact weighting is not published. Critically for an *external* scorer, these signals are **not observable** except through the sender's own ESP telemetry — and opens are corrupted by Apple MPP.

**Where reputation sits in the filtering pipeline.** The academic and practitioner picture is a layered pipeline: (1) connection-time IP reputation / DNSBL checks can reject at SMTP connect (cheapest); (2) authentication checks (SPF/DKIM/DMARC); (3) sender/domain reputation lookup; (4) content scoring (historically Bayesian/statistical filters and SpamAssassin rule scores, now neural content classifiers and, since early 2026, Gmail's Gemini-based semantic summarisation layer). Reputation sits early and can short-circuit content analysis entirely — SNARE's thesis was that a mail server can reject purely on sender reputation without ever parsing the message.

## Research Question 2 — External Signals: Enumeration, Definition, Quality and Availability

For each signal below: what it measures, how to obtain it, source, cadence, coverage, noise, predictive value.

**Authentication signals**
- **SPF (RFC 7208):** presence, syntax validity, the 10-DNS-lookup limit (exceeding ⇒ permerror), void lookups, policy strictness (`-all` fail vs `~all` softfail vs `+all` — the last is a red flag), include-chain sprawl, and SPF result codes (pass/fail/softfail/neutral/none/permerror/temperror). Obtain via DNS TXT lookup + a resolver that counts lookups. Cadence: DNS TTL (minutes–hours). Coverage: near-universal for bulk senders post-2024. Noise: low. Predictive value: *presence* now low (everyone has it); *misconfiguration* (permerror, `+all`, >10 lookups) is a modest negative signal. Note RFC 7208 §5.5 deprecates the `ptr` mechanism ("do not use").
- **DKIM (RFC 6376):** presence, key length (1024 vs 2048-bit; 1024 is weak), rotation cadence, alignment with the From domain, multiple signatures, `d=` domain identity/reputation, selector hygiene. Public keys are at `selector._domainkey.domain` but selectors are unpredictable, so passive observation (from received mail) is needed to enumerate them — a coverage limitation for a pure-DNS scanner. Predictive value: alignment and `d=` reputation matter; raw presence is table-stakes.
- **DMARC (RFC 7489 → DMARCbis RFC 9989):** policy (`none`/`quarantine`/`reject`), the now-removed `pct` (replaced by `t=`), `rua`/`ruf` presence, `sp=` subdomain policy, alignment mode (relaxed/strict), and aggregate-report-derived pass rates. Large-scale measurement (RAID '21, "The Evolution of DNS-based Email Authentication"; USENIX Security '22 longitudinal study reporting SPF 69.8%, DKIM 37.0%, DMARC 15.1% among MX domains) shows adoption is rising but enforcement remains a minority. Per Valimail's 2026 State of DMARC, only 42% of domains use quarantine or reject settings, with enforcement growing from 35% to 42% over the course of 2025; Red Sift (December 2025), analysing 73.3 million domains, found just 2.5% enforce `p=reject`. Predictive value: an *enforcement* policy is a positive trust signal (and is a BIMI prerequisite); `p=none` is neutral.
- **BIMI + VMC/CMC:** BIMI remains an IETF draft (not an RFC as of 2026), with a Verified Mark Certificate requiring a registered trademark and DMARC at enforcement. As of June 2025, DigiCert's official price for a 12-month auto-renewing VMC subscription is $1,608.00 per domain or logo (bimicertifications.com); Suped notes DigiCert lists its Mark Certificate subscription at $1,416/year and Sectigo lists VMC pricing from $1,350/year — so budget roughly $1,350–$1,600/year list. A VMC is a strong, expensive-to-fake trust signal (Gmail shows a blue verified checkmark only with a VMC; a Common Mark Certificate shows the logo but no checkmark). Supported by Gmail, Apple Mail and Yahoo (Yahoo displays logos without requiring a VMC); not supported by Outlook.

**Deliverability outcome signals**
- **Bounce rate:** hard (5.1.1 unknown user) vs soft (4.x transient), with SMTP reply-code taxonomy distinguishing block-bounces (5.7.1, 5.7.515 access denied) from unknown-user bounces (5.1.1) and throttling (4.7.x). These are distinct signals: unknown-user ⇒ list-hygiene failure; block-bounce ⇒ reputation/policy failure. High predictive value, but only observable to the sending party (or an ESP-telemetry partner).
- **Complaint rate:** FBL-derived. Microsoft JMRP and Yahoo CFL provide feedback; Gmail provides only the aggregated Postmaster spam rate plus an ESP-identifier FBL (no per-message consumer FBL). Thresholds: <0.1% target, 0.3% hard ceiling. This is the highest-value operational signal but is **not externally observable** without being the sender or an FBL participant.
- **Spam traps:** pristine/pure, recycled, typo (M3AAWG taxonomy). Inferred, never ground-truthed by senders; trap networks (Spamhaus, Abusix) are secret and unpurchasable. A pristine hit is a strong indicator of purchased/scraped lists; recycled indicates stale lists/poor bounce handling. Extremely high predictive value for "bad," which is why it anchors incumbents' data moats.
- **Blocklist presence:** DNSBL/RBL/URIBL queries (RFC 5782 defines the DNS query mechanics). Weight lists by predictive value and false-positive rate — Spamhaus ZEN (SBL/CSS/XBL/PBL) and DBL are high-signal; some minor lists are noisy. Listing/delisting dynamics vary; Spamhaus ZRD lists newly-registered/dormant domains for 24 hours. Cheap (DNS query), near-real-time with DQS, and a direct proxy label.

**Infrastructure/identity signals**
- **Domain age, registrar, WHOIS/RDAP privacy, DNS hygiene** (MX presence, PTR/rDNS forward-confirmed, A record, DNSSEC, MTA-STS per RFC 8461, TLS-RPT per RFC 8460), hosting ASN reputation, and whether a domain was previously burned/parked. Newly-registered domains are inherently higher risk (the "thin-file" problem; Spamhaus ZRD encodes this explicitly). Obtain via DNS + RDAP. High availability, moderate predictive value, low noise.
- **Encryption/transport:** TLS usage rates, opportunistic vs enforced (MTA-STS). Weak standalone predictor; part of infrastructure health.

**Behavioural signals**
- **Engagement** (opens, clicks, replies, conversions, unsubscribes, read/delete-without-read, list churn): highest intrinsic predictive value, lowest external observability. Opens are distorted by Apple MPP since iOS 15 (Sept 2021). Only obtainable via consented first-party/ESP telemetry.
- **Sending consistency:** volume stability, variance, spikes, cadence, time-of-day, ramp curves, seasonality. Anomalous volume is detectable statistically (see §4). Observable only to the sender/ESP or, partially, to receivers.
- **List-hygiene proxies:** role accounts, disposable domains, syntax-invalid addresses, MX-invalid domains, catch-all domains, hard-bounce recidivism. Partly checkable externally (syntax, MX, disposable-domain lists) via verification vendors.
- **Content/infra:** URL-shortener use, link-domain reputation, redirect chains, image-to-text ratio, attachment types, tracking-domain alignment / CNAME cloaking. Observable only from message content.

**Third-party reputation APIs (availability/pricing).** Google Postmaster Tools API (free, but ToS limits redistribution; v2beta preview Dec 2025); Cisco Talos (free web lookup, granular score −10 to +10 bucketed Good/Neutral/Poor; the appliance-side SenderBase Reputation Score also runs +10 to −10, with "None" for low-volume IPs); Spamhaus DQS (free non-commercial tier, paid commercial subscription, DNS-query interface per RFC 5782, real-time updates, adds ZRD/AuthBL, paid adds HBL); Abusix Mail Intelligence (paid DNSBL); Validity Sender Score (free IP lookup at senderscore.org); Barracuda Reputation (BRBL); SURBL; IPQualityScore; email-verification vendors (ZeroBounce, NeverBounce, Kickbox, Emailable, BriteVerify — per-verification pricing); Have I Been Pwned domain search; MX/DNS/RDAP APIs.

## Research Question 3 — Designing the Reputation Scoring Model

**Critique of the user's proposed weights.** The proposal — Authentication 20%, Engagement 25%, Complaint Risk 20%, Infrastructure Health 15%, Sending Behaviour 20% — is directionally sensible but has two flaws given the evidence:

1. **Authentication is over-weighted at 20%.** Post-2024/2025 mandates, SPF/DKIM/DMARC presence is table-stakes with low discriminatory power — nearly all legitimate bulk senders now pass, so it separates "compliant" from "non-compliant" but not "good" from "bad" among the compliant majority. Only authentication *hygiene* (enforcement policy, alignment, key length, no `+all`/permerror) retains signal.
2. **Engagement at 25% assumes observability the external scorer does not have.** For a pure-external product, engagement is largely unavailable and opens are MPP-corrupted; weighting it 25% builds the score on a signal you cannot measure. For a first-party/ESP-telemetry product, 25% is defensible.

**Evidence-based alternative (two variants).**

*External-only variant (no sender cooperation):*
- Complaint/abuse-proxy risk (blocklist + trap-network inference + DBL/ZRD): **30%**
- Infrastructure & identity health (DNS hygiene, PTR/FCrDNS, domain age, ASN, TLS/MTA-STS): **25%**
- Authentication hygiene (enforcement policy, alignment, key strength, SPF sanity): **20%**
- Sending-behaviour inference (volume/pattern anomalies where observable): **15%**
- Engagement proxy (only where any signal exists): **10%**

*First-party/ESP-telemetry variant (sender consents to share performance data):*
- Complaint risk (real FBL + spam-rate): **30%**
- Engagement (replies/clicks weighted over opens; MPP-adjusted): **25%**
- List hygiene & bounce behaviour: **20%**
- Authentication hygiene: **10%**
- Infrastructure health: **10%**
- Sending consistency: **5%**

The justification is that the weights should track each signal's **Information Value against the observable "bad" label** — complaint and trap/blocklist proxies dominate because they *are* (or directly cause) the label, while authentication's IV collapses once it becomes universal.

**Design lessons from consumer credit scoring, mapped.** FICO's factor weights (payment history 35%, amounts owed 30%, length of history 15%, new credit 10%, credit mix 10%) are the archetype. Map:
- Payment history ⇒ **complaint/blocklist/trap history** (the dominant factor).
- Amounts owed / utilisation ⇒ **volume relative to warmed capacity** and unengaged-recipient share.
- Length of history ⇒ **domain/IP age and tenure of good sending**.
- New credit ⇒ **newly-added infrastructure/subdomains/IPs** (thin-file penalty).
- Credit mix ⇒ **diversity of well-behaved streams** (transactional + marketing separated).

Adopt the credit-scoring **construction pipeline**: coarse-classing/binning each characteristic, **Weight of Evidence (WoE)** transformation, **Information Value (IV)** for feature selection (Siddiqi's conventions: IV <0.02 useless; 0.02–0.1 weak; 0.1–0.3 medium; 0.3–0.5 strong; >0.5 suspiciously strong/possible leakage), a **logistic-regression scorecard** whose coefficients × WoE give per-bin points, and **points-to-double-the-odds (PDO)** scaling: `Score = Offset + Factor·ln(odds)`, `Factor = PDO/ln(2)`. Add **score-to-odds calibration**, **reject inference** (for entities you never let send / never observe), **Population Stability Index (PSI)** for drift, **characteristic analysis**, **vintage analysis** (cohorts by domain-registration month), and **Gini/KS/AUC** validation (retail benchmarks: KS >0.40 strong, Gini >0.55 strong; KS >0.70 warrants a leakage investigation). Borrow **adverse-action reason codes** directly for explainability.

**The hard target-variable problem.** There is no ground truth on inbox placement. Candidate proxy labels, each noisy:
- Blocklist listing (Spamhaus ZEN/DBL) — precise but lagging and coarse.
- Complaint rate > 0.3% — decisive but only exists if mail reached inboxes.
- Postmaster domain-reputation bucket (historical; now retired at Gmail).
- Seed-list inbox-placement rate (panel data; the Validity/GlockApps approach) — direct but panel-biased and gameable.
- Hard-bounce/block-bounce rates — strong for list quality.
Label noise and **survivorship/selection bias** are structural: fully-blocked senders emit little complaint data, so a naive model trained on complaints under-weights the worst senders. Mitigations: use *multiple* labels and a consensus/latent label; explicitly model "no data" as informative; use seed-panel data to anchor the unobserved region; and apply reject inference.

**Score architecture.** Recommend a **single composite (0–1000, credit-score-familiar) plus published sub-scores** (Authentication, Complaint Risk, Infrastructure, Behaviour, Engagement). Scores should be **absolute (calibrated to odds)** with a percentile shown alongside — absolute is more stable and less gameable than pure percentile (Sender Score's pure-percentile design means your score can move because others changed). Granularity: score per **sender_domain**, **sending_ip**, **dkim_identity (d=)**, **ip_pool**, **asn**, and **esp_tenant**, with roll-up/roll-down rules (organizational-domain reputation informs a thin subdomain; ASN reputation informs a new IP). Cold-start/thin-file: a brand-new domain is the email equivalent of a no-credit-history applicant — start from an ASN/registrar/DNS-hygiene prior (a "starter score"), widen the confidence interval, and let it converge as evidence accrues (Spamhaus ZRD's 24-hour listing of new domains is the industry's blunt version of this).

**Time dynamics.** Apply **exponential decay** to negative events (recommend a half-life of ~30–45 days for complaints/blocklist events so a single bad campaign fades but recent behaviour dominates), recency-weight all inputs, model warm-up curves explicitly, and cap the per-event penalty so one incident cannot zero the score — mirroring how FICO caps and ages derogatory marks.

**Explainability.** Produce adverse-action-style reason codes: *"Score limited by: (1) complaint rate in the 92nd percentile of your volume band; (2) DMARC policy at p=none; (3) 14% of volume to unengaged recipients; (4) sending IP shares a /24 with two listed hosts."*

**Anti-gaming (Goodhart's law).** Once the score is commercially meaningful it will be optimised. Lessons from PageRank/SEO (link farms ⇒ TrustRank seed-based trust) and credit-score optimisation: (a) prefer signals that are *expensive to fake and cheap to verify* (VMC, trademark, sustained low complaint rate, trap avoidance) over cheap-to-fake ones (authentication presence); (b) keep some inputs proprietary/secret (trap networks) so gamers cannot A/B test against them; (c) use graph/neighbourhood features so snowshoe fragmentation across many domains/IPs still rolls up to a bad ASN/registrar cluster; (d) monitor for score-optimising behaviour patterns as an anomaly signal in itself.

## Research Question 4 — Machine Learning Approaches

**Supervised classification.** Use a **two-model architecture**: a **logistic-regression scorecard** (WoE-binned, monotonic, fully explainable) as the production/regulatory-facing model, and a **gradient-boosted challenger** (XGBoost/LightGBM/CatBoost) to quantify the accuracy ceiling and surface new features. On tabular reputation features, GBMs typically beat deep nets; **deep learning adds little on tabular data** and should be reserved for sequence/graph/content sub-problems. Random forests are a reasonable baseline.

**Calibration.** A score must emit a *calibrated probability of "bad."* Apply **Platt scaling** (parametric) or **isotonic regression** (non-parametric, needs more data) on a held-out set; calibration is what lets the PDO mapping to odds be meaningful. Report reliability diagrams.

**Anomaly/novelty detection** for volume spikes and behavioural change: **isolation forest**, **one-class SVM**, **autoencoders**, **robust z-scores**, and change-point methods — **CUSUM/EWMA**, and **Bayesian online change-point detection** — to flag ramp anomalies and sudden complaint shifts. These feed the Sending-Behaviour sub-score and the "single bad campaign" guardrail.

**Time-series/survival.** **ARIMA/SARIMA**, **Prophet**, and **LSTM/Temporal Fusion Transformer** for volume/complaint forecasting; **survival analysis / Cox proportional-hazards** for "time-to-blocklisting" or "time-to-reputation-degradation," which turns the score into a forward-looking early-warning system rather than a lagging report.

**Graph-based approaches.** Build sender/domain/IP/ASN/registrar graphs and apply **label propagation** and **GNNs** to infer reputation for sparse/new entities from their neighbourhood — the direct descendants of **EigenTrust** (Kamvar, Schlosser, Garcia-Molina, WWW 2003; a single global trust value per peer computed by transitively aggregating rater-weighted local trust via power iteration, with pre-trusted seed peers) and **TrustRank** (Gyöngyi, Garcia-Molina, Pedersen, VLDB 2004; seed trust from a vetted set and propagate through link structure on the assumption good pages rarely link to spam). Recent applicable literature (2021–2025): attributed heterogeneous GNNs for malicious-domain detection (GAMD); HANDOM (*Computers & Security*, 2023); self-supervised heterogeneous GNNs with contrastive learning (LNCS, 2023); AHDom (*Computer Networks*, 2024); and adversarial-robustness work on GNN-based malicious-domain detection (IEEE S&P 2024). HP Labs' Bayesian label propagation on a host-domain graph (validated on 567 million download events) is a scalable precedent.

**Sequence models** on per-entity sending behaviour capture temporal patterns (SNARE observed distinct diurnal patterns for spammers vs legitimate senders).

**Class imbalance, concept drift, adversarial drift.** "Bad" is rare ⇒ use PR-AUC not just ROC-AUC, class weights / focal loss / careful resampling, and threshold tuning. Concept drift (provider policy changes like the 2024/2025 mandates) and *adversarial* drift (gamers) require scheduled retraining, PSI monitoring, and champion/challenger deployment.

**Domain feature engineering** and the canonical academic lineage to cite: Ramachandran & Feamster, "Understanding the Network-Level Behavior of Spammers" (ACM SIGCOMM 2006 — best-paper; found spam concentrated in a few IP ranges and short-lived bots, with a large fraction of spam from a small number of network regions); Ramachandran, Feamster & Vempala, "Filtering Spam with Behavioral Blacklisting" (ACM CCS 2007); Hao, Syed, Feamster, Gray & Krasser, "Detecting Spammers with SNARE" (USENIX Security 2009 — ~70% detection at ~0.2% false-positive rate using only network-level spatio-temporal features, with AS number the top-ranked feature); Beverly & Sollins on IP-reputation learnability; and the modern authentication-measurement corpus (Durumeric et al., IMC 2015 — of ~700,000 SMTP servers only 35% configured encryption and 1.1% specified a DMARC policy; Tatang et al., RAID 2021; Wang et al., USENIX Security 2022).

**Evaluation methodology.** AUC/PR-AUC, KS, **lift at top decile**, and a strict **temporal (out-of-time) backtest** — train on months 1–9, validate on 10–12 — plus vintage analysis and a Gini-drop redevelopment trigger (>10% dev-to-validation drop).

## Research Question 5 — Productisation and Commercial Opportunity

**API productisation.** Offer (a) a **real-time lookup** endpoint (domain/IP/`d=` in, score + sub-scores + reason codes out) for signup/KYC and inbound-filtering decisions; (b) **batch scoring** for list-audit; and (c) **webhook alerting** on score drops or new blocklist/trap events. Precedent for the query pattern is the **DNSBL/RFC 5782** model (ultra-light DNS query, cacheable) and the **RFC 7070/7071/7072/7073** reputation-query family (HTTP/JSON reputation responses keyed on DKIM `d=`, SPF, IP, From). Pricing: **per-query, tiered, and DQS-style subscription** with a free non-commercial tier for adoption. Rate-limit and enforce data-licensing constraints (see legal). Sub-100ms latency for the real-time path (DNS-fronted cache).

**SaaS dashboard.** Trend charts per entity, sub-score breakdowns, reason codes, alerts, competitor/peer benchmarking, and remediation playbooks — matching and exceeding what GlockApps, Everest (Validity), Mailgun/Sinch Optimize, SendGrid/Twilio, Postmark, MailReach, Warmy, InboxAlly, and Folderly offer.

**Email-security / inbound angle.** Use sender reputation for inbound filtering, BEC and vendor-impersonation defence, supply-chain email risk, and third-party/vendor risk scoring — directly adjacent to the cyber-ratings vendors (SecurityScorecard, BitSight, Panorays, UpGuard) that already fold email-security posture (SPF/DKIM/DMARC/DNS hygiene) into credit-score-style ratings. Bitsight, which founded the category in 2011, calculates a daily rating between 250 and 900 (current achievable range 300–820, "analogous to a credit score") for more than 540,000 organizations and monitors over 40 million entities; SecurityScorecard (founded 2014) uses an A–F scale. This is the highest-willingness-to-pay buyer.

**Adjacent use cases.** Deliverability marketplace / IP-and-domain trading due diligence; ESP onboarding risk and KYC for SMTP relays (score a prospective tenant before provisioning); insurance/underwriting and B2B-credit-style signals.

**Competitive landscape.**

| Vendor | What it scores | Data sources | Coverage | Pricing (where public) | Gap left |
|---|---|---|---|---|---|
| **Validity Sender Score** | IP reputation, 0–100 percentile, rolling 30-day | Validity Data Network (80+ providers), complaints, traps, blocklists | IP-centric, global | Free lookup; Everest paid | IP-only, percentile (not calibrated/absolute), not domain/identity |
| **Spamhaus (ZEN/DBL/DQS)** | Binary/return-code listings; IP + domain | Proprietary trap networks, botnet intel | Very broad, authoritative | Free non-commercial; paid DQS/Intelligence API | Binary, not a graded score; no engagement/behaviour |
| **Cisco Talos** | IP/domain reputation, −10 to +10 (Good/Neutral/Poor) | Cisco global telemetry | Broad | Free lookup | Coarse buckets; tied to Cisco ecosystem |
| **Barracuda Central (BRBL)** | IP reputation/blocklist | Barracuda telemetry | Broad | Free DNSBL | Binary; vendor-tied |
| **Abusix Mail Intelligence** | DNSBL IP/domain | Trap + abuse feeds | Broad | Paid DNSBL | Binary; anti-abuse focus, not sender-facing score |
| **Google Postmaster Tools** | Gmail-side spam rate, compliance, auth (reputation buckets retired Sep 2025) | Gmail first-party | Gmail only | **Free** | Gmail-only, aggregated, no cross-provider view — the free substitute that caps WTP |
| **Microsoft SNDS** | IP data/complaints at Outlook | Microsoft first-party | Outlook only | Free | Outlook-only, IP-only |
| **Red Sift / Valimail / dmarcian / EasyDMARC / PowerDMARC / Skysnag / Sendmarc** | DMARC/auth posture & reporting | Aggregate DMARC XML | Auth niche | Freemium → enterprise | Authentication-only; no behavioural/complaint reputation |
| **GlockApps / MailReach / Warmy / InboxAlly / Folderly / Mailtrap** | Seed-list inbox placement, warm-up | Own seed panels | Panel-limited | SaaS subscription | Panel bias, gameable, not a universal score |
| **ZeroBounce / Kickbox / NeverBounce / Emailable** | Address validity | Verification infra | List-level | Per-verification | Pre-send hygiene, not sender reputation |
| **SecurityScorecard / BitSight / Panorays / UpGuard** | Org cyber posture incl. email security | External scanning | 540,000+ rated / 40M+ monitored (BitSight) | Enterprise | Email is one vector; not deliverability-grade |

**Market sizing (cited, with the caveat that third-party market-research figures vary widely and are vendor-sponsored).** Email-security market estimates for 2025 range roughly USD 5.2–6.9B depending on the analyst. Fortune Business Insights values the email-security market at USD 5.17 billion in 2025, projected to grow from USD 5.73 billion in 2026 to USD 12.21 billion by 2034 at a 9.90% CAGR; Mordor Intelligence puts 2026 at ~USD 5.89B growing to ~USD 10.64B by 2031 (12.57% CAGR); MRFR estimates ~USD 6.83B in 2025 rising to ~USD 23.37B by 2035 (13.08% CAGR). DMARC-software market estimates are even more divergent — from ~USD 161M (2025) to ~USD 1.8B (2025) depending on scope — all with high CAGRs (~14–22%). Treat these as order-of-magnitude only. The cyber-ratings category (BitSight, founded 2011; SecurityScorecard, founded 2014) is the adjacent premium market.

**Moat analysis.** Defensible: **proprietary trap/seed networks**, **aggregated consented ESP telemetry** (the data flywheel — more senders ⇒ more outcome labels ⇒ better calibration ⇒ more senders), and **first-party performance data**. Commodity: DNS/RDAP lookups, public blocklists, authentication parsing. Network effects are real but bounded by the free Postmaster/SNDS substitutes. **The hardest part is ground truth, not modelling** — whoever assembles the broadest, cleanest label set (traps + seed panels + consented telemetry + FBLs) wins, because the ML is well-understood and commoditised.

**Legal/compliance (Australia-focused, plus international).**
- **GDPR:** scoring is arguably profiling under Art. 22, but **domain/IP-level scoring of businesses largely avoids personal data**; scoring individual `firstname.lastname@` sole-trader domains edges toward personal data. Keep the entity a domain/IP, not a natural person.
- **Australia:** the **Privacy Act 1988** and Australian Privacy Principles apply; the **Privacy and Other Legislation Amendment Act 2024** (Royal Assent 10 December 2024) introduced new OAIC enforcement powers (infringement notices up to ~$66,000/contravention; civil penalties up to $3.3M — 10,000 penalty units — for companies), a new statutory tort for serious invasions of privacy, and forthcoming automated-decision transparency requirements (24-month lead time). **Tranche 2** (broader definitions of personal information/consent, a "fair and reasonable" test, possible removal of the small-business exemption) is expected to be consulted on/progressed after the 2025 federal election. The statutory tort for serious invasions of privacy commenced in 2025. The **Spam Act 2003** governs sending, not scoring. Design for domain/IP-level (non-personal) scoring to stay clear of the profiling provisions.
- **Defamation/liability:** publishing a *negative* score about a *named business* carries defamation and tortious-interference risk. The **e360 Insight v. Spamhaus** saga is the guiding precedent: e360 won an $11,715,000 default judgment that the Seventh Circuit ultimately reduced to **$3 in nominal damages** in 2011 — anti-abuse blocklists that operate in good faith have prevailed, and US courts (also *Holomaxx v. Yahoo/Microsoft*) have been hostile to blocked-sender suits (Section 230 and CDA good-faith-filtering protections assist US defendants). Australia lacks a Section 230 equivalent and has plaintiff-friendlier defamation law, so an AU-domiciled publisher of negative business scores should (a) score factually/transparently with documented methodology, (b) prefer neutral numeric/probabilistic output over pejorative labels, (c) provide dispute/remediation channels, and (d) obtain legal review.
- **ToS constraints:** Google Postmaster Tools and Microsoft SNDS data carry redistribution limits — you generally cannot resell or republish provider-derived reputation data as your own product. Build the score on independently-collected and consented data.

---

## (c) Proposed Data Model

**Entities and key attributes.**
- **sender_domain** (organizational domain): domain, registrar, RDAP/WHOIS-privacy flag, registration_date (age), DNSSEC, MX set, MTA-STS/TLS-RPT presence, SPF record + validity + lookup count, DMARC policy/`sp`/alignment/`t`, BIMI/VMC flag, current_score, sub_scores, confidence_interval, first_seen, last_scored.
- **subdomain**: FK→sender_domain, own auth posture, roll-up policy.
- **sending_ip**: ip, PTR/FCrDNS status, ip_pool FK, asn FK, listing_state (per DNSBL), shared/dedicated flag, first_seen.
- **dkim_identity**: `d=` domain, selector, key_length, key_first_seen, rotation_interval, alignment_with_from.
- **ip_pool**: pool_id, owner (ESP), member IPs, aggregate reputation.
- **asn**: asn, org, geo, aggregate reputation, spam-density feature.
- **esp_tenant**: tenant_id, ESP, associated domains/IPs, onboarding_risk_score.
- **campaign** (first-party only): id, sender_domain FK, send_start, volume, subject_hash, link_domains.
- **event** (append-only fact table): event_id, ts, entity_type, entity_id, event_type ∈ {blocklist_add, blocklist_remove, trap_hit(pristine|recycled|typo), complaint, hard_bounce(5.1.1), block_bounce(5.7.x), throttle(4.7.x), dmarc_fail, spf_permerror, volume_anomaly, open*, click*, reply*, unsubscribe*, spam_report*}, source, magnitude, decay_weight. (*first-party only.)

**Relationships.** sender_domain 1—* subdomain; sender_domain *—* sending_ip (via observed sends); sending_ip *—1 ip_pool —1 esp_tenant; sending_ip *—1 asn; sender_domain 1—* dkim_identity; all entities 1—* event.

**Ingestion & time-windowing.** A streaming pipeline lands raw events into an append-only store; a **feature store** computes windowed aggregates per entity at multiple horizons (24h, 7d, 30d, 90d, 365d) with **exponential-decay weighting** (complaint/blocklist half-life ~30–45d). Features: complaint_rate_30d, trap_hits_by_type_90d, blocklist_days_365d, bounce_mix, volume_zscore, ramp_slope, auth_hygiene_flags, dns_hygiene_score, asn_spam_density, neighbourhood_listed_share (/24), engagement_reply_rate (first-party). Nightly batch recomputes scores; the real-time path serves the last committed score plus any intraday critical events (new blocklist add).

## (d) Scoring Methodology — Worked Example

**Scale.** 0–1000, higher = lower risk. PDO mapping: `Score = Offset + Factor·ln(odds_good)`, `Factor = PDO/ln(2)`. Choose base 600 ⇒ 50:1 good:bad odds, PDO = 80 (so +80 points doubles the good:bad odds). `Factor = 80/0.693 = 115.4`; `Offset = 600 − 115.4·ln(50) = 600 − 115.4·3.912 = 600 − 451.4 = 148.6`.

**Sender:** `acme-marketing.com`, a mid-market retailer's marketing subdomain, 250k/day to mixed Gmail/Outlook/Yahoo, dedicated IP, 14 months old.

*Sub-score inputs (each 0–100, WoE-derived in production):*
- **Authentication hygiene = 78/100:** SPF valid `-all`, 6 lookups (OK); DKIM 2048-bit, aligned; DMARC `p=quarantine`, `rua` present, relaxed alignment; no BIMI/VMC. (Loses points for no enforcement-`reject`, no VMC.)
- **Complaint risk = 62/100:** Postmaster spam rate 0.22% (above 0.1% target, below 0.3% ceiling), Yahoo CFL complaints elevated last 30d.
- **Infrastructure health = 85/100:** PTR/FCrDNS OK, DNSSEC on, MTA-STS enforce, clean ASN, dedicated /32 not in a listed /24.
- **Sending behaviour = 70/100:** stable cadence but one 3× volume spike 12 days ago (decaying anomaly).
- **Engagement (first-party) = 66/100:** reply rate healthy, click rate moderate, but 14% of volume to 180-day-unengaged recipients; opens discounted for MPP.

*Composite (first-party weights: Complaint 30, Engagement 25, List-hygiene/behaviour 20, Auth 10, Infra 10, Consistency 5 — simplified to the five sub-scores):*
Weighted sub-score = 0.30·62 + 0.25·66 + 0.20·70 + 0.10·78 + 0.10·85 + 0.05·70
= 18.6 + 16.5 + 14.0 + 7.8 + 8.5 + 3.5 = **68.9/100**.

*Map to odds.* Suppose calibration gives P(bad) at sub-score 68.9 = 0.06 ⇒ odds_good = 0.94/0.06 = 15.7.
`Score = 148.6 + 115.4·ln(15.7) = 148.6 + 115.4·2.754 = 148.6 + 317.8 ≈ 466` on the raw PDO scale; scaled/anchored into the published 0–1000 band this lands the sender in the upper-middle "good, watchlist" tier (≈ 760). (In production the composite input to the PDO map is the model's calibrated P(bad); the sub-score averaging here is illustrative of the mechanics.)

**Reason codes emitted:**
1. *Complaint rate (0.22%) above the 0.10% target for your volume band — largest single limiter.*
2. *DMARC policy at p=quarantine, not reject; no VMC — authentication hygiene below top decile.*
3. *14% of volume to recipients unengaged for 180+ days.*
4. *Volume spike (3×) 12 days ago still weighing on behaviour sub-score (decaying).*
Recommended actions ranked by score-lift: suppress the 180-day-unengaged segment; drive complaint rate under 0.1%; move to `p=reject` + VMC.

## (e) Competitive Landscape Table

*(See the table in Research Question 5 above.)*

## (f) Go-to-Market & Moat

Land with the **email-security/vendor-risk buyer** (highest WTP, least price-anchored by free Postmaster), expand to **ESP onboarding/KYC** (clear ROI: reject bad tenants pre-provisioning), then **sender/deliverability** (large but anchored by free tools — win on cross-provider calibration + reason codes). Build the **data flywheel** via a free tier that yields consented telemetry, and invest early in **proprietary trap/seed infrastructure** — the one asset competitors cannot copy from public data. Differentiate on: cross-provider *calibrated absolute* score (vs Sender Score's percentile and Gmail's Gmail-only bucket), entity resolution across domain/IP/`d=`/ASN, and explainable reason codes.

## (g) Why This Is Hard / What Could Kill It

1. **No ground truth on inbox placement** — the entire model rests on noisy proxies with survivorship bias; a mis-calibrated label set produces a confidently wrong score.
2. **Providers reduce signal** — Gmail retired reputation buckets (Sept 2025); further closures would starve the model.
3. **Free substitutes cap pricing** — Postmaster Tools and SNDS are free and provider-authoritative for their own mail.
4. **Gaming** — once meaningful, the score is optimised against (Goodhart); requires secret signals and graph features.
5. **Legal exposure** — defamation/tortious-interference risk on negative business scores, sharper in Australia than the US (no Section 230); e360 v Spamhaus shows good-faith anti-abuse usually prevails but litigation is costly.
6. **ToS/data-licensing** — cannot resell provider-derived data; must build independent, consented data.
7. **MPP and engagement opacity** — the most predictive signal (engagement) is corrupted or unavailable externally.
8. **Concept + adversarial drift** — provider-policy shocks (2024/2025 mandates, 2026 Gemini semantic filtering) force continuous retraining.

## Recommendations

**Stage 0 — Prove the label (weeks 0–8).** Before building any model, assemble and validate the *ground-truth proxy* set: subscribe to Spamhaus DQS and Abusix, stand up a small pristine/recycled trap network of your own, register for Postmaster Tools / SNDS on partner domains, and secure 2–3 ESP telemetry-sharing pilots. **Benchmark that changes the plan:** if you cannot achieve a stable, low-noise composite label with Gini >0.4 against held-out blocklist/complaint outcomes, do not proceed to a paid product — the modelling will not rescue a bad label.

**Stage 1 — External-only MVP (months 2–5).** Ship the external-variant score (weights: Complaint-proxy 30 / Infra 25 / Auth-hygiene 20 / Behaviour 15 / Engagement 10) as a logistic-regression scorecard with PDO scaling to 0–1000, calibrated with isotonic regression, plus reason codes. Sell first to **vendor-risk / email-security** buyers via a real-time API. **Threshold to advance:** paid pilot conversion and top-decile lift materially above a Sender-Score + Spamhaus baseline.

**Stage 2 — First-party data flywheel (months 5–12).** Launch a free sender dashboard to harvest consented engagement/complaint/bounce telemetry; switch on the first-party weighting variant for consenting senders; add the GBM challenger, survival "time-to-blocklisting" model, and graph propagation for thin-file entities. **Threshold:** demonstrable calibration improvement from telemetry (Brier-score reduction) and defensible trap/seed coverage.

**Stage 3 — Defend and expand.** Add ESP-onboarding KYC and inbound-filtering integrations; formalise dispute/remediation to manage AU defamation exposure; obtain legal sign-off on published-score wording. **Kill-switch benchmarks:** if provider signal closures drop label quality below the Stage-0 bar, or if a free entrant replicates the composite, pivot to the telemetry-and-traps data business rather than the score itself.

**Modelling defaults to adopt now:** two-model (scorecard + GBM); exponential decay half-life 30–45 days on negatives with a per-event cap; absolute odds-calibrated score with percentile shown alongside; temporal out-of-time validation; PSI/Gini/KS monitoring with a >10% Gini-drop redevelopment trigger; entity the score on domain/IP/`d=`/ASN (never a natural person) to stay clear of privacy-profiling rules.

## Caveats

- **Gmail internal weights are unknown.** Statements about how much Gmail/Outlook weight replies vs opens, or their exact decay windows, are practitioner folklore inferred from black-box behaviour, not documented fact, and are flagged as such throughout.
- **Market-sizing figures are vendor-sponsored and diverge widely** (email security ~$5.2–6.9B for 2025 across analysts; DMARC software ~$161M–$1.8B for 2025). Use them only as order-of-magnitude.
- **The worked numeric example is illustrative** of the PDO/WoE mechanics, not a validated calibration; real point allocations must come from fitting the scorecard on actual labelled data.
- **Some competitive pricing is list price** (e.g., VMC ~$1,350–$1,600/year) and varies by reseller and term; Sender Score's exact algorithm and Spamhaus's trap methodology are deliberately undisclosed.
- **Standards are moving:** DMARCbis (RFC 9989/9990/9991) published May 2026 and BIMI remains an IETF draft; the AU privacy Tranche 2 reforms were still pending as of the research date and could materially change what "personal information" and automated-decision transparency require.
- **Two source-citation errors in the brief were corrected:** DMARCbis is RFC 9989/9990/9991 (not "RFC 9557"), and RFC 9091 is the Experimental PSD DMARC extension (not an "SPF-none deprecation"); ARC (RFC 8617) and PSD DMARC (RFC 9091) are Experimental, not Standards Track.