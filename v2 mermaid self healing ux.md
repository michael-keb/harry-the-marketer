flowchart TD

%% ═══════════════════════════════════════════════════════════════
%% SELF-HEALING UX AUDIT — BRAIN ARCHITECTURE
%% restructured against the research report:
%% serial spine over parallel cortex · predictive coding as the healing loop
%% L0 thalamic relay · L1 default mode network · L2 cortical columns
%% L3 salience hub · L4 basal ganglia gate · L5 global workspace
%% ═══════════════════════════════════════════════════════════════

EX0["EXECUTIVE INTENT<br/>Choose journey / customer moment<br/>a top-down goal opens the audit and projects to relay and model"]

subgraph L0["LAYER 0 · THALAMIC RELAY — the evidence bus · Sherman–Guillery"]
DRV["DRIVER CHANNEL — collect the evidence FIRST<br/>full-res screenshots of every screen in every state<br/>empty · loading · partial · error · success · edge · offline<br/>A state you cannot screenshot is a state you cannot audit"]
DRV --> FC["Screenshot the TRUE first contact<br/>store listing · ad · email · notification · cold open<br/>The journey starts before your first screen"]
FC --> MODC["MODULATOR CHANNEL — context gain, never content<br/>journey type · money and data moments flagged ·<br/>device, lighting and attention-budget context<br/>tunes each column's gain without altering the raw evidence"]
MODC --> BUS["ONE RELAY · ONE BUNDLE<br/>every column reads the SAME evidence, broadcast in parallel<br/>a column may request a re-fetch — it never scrapes privately"]
BUS --> EGATE{"Evidence complete?<br/>An opinion without an image is not a finding"}
end

subgraph L1["LAYER 1 · DEFAULT MODE NETWORK — simulate the customer's mind · build the EXPECTED experience · Raichle"]
M1["Name every moment by its emotional job<br/>orient · decide · act · wait · recover · celebrate<br/>Each screenshot owes ONE primary feeling"]
M1 --> M2["Infer the customer's REAL state of mind at entry<br/>what they want · what they fear · what they already know<br/>and how little attention they are giving you"]
M2 --> M3["Name the SHADOW audiences<br/>the person the phone gets handed to · the screen-reader user ·<br/>the one on 2-year-old mid-range hardware in sunlight<br/>A missing audience is a gap, not an edge case"]
M3 --> M4["Cast the personas who will crawl<br/>first-timer · returning regular · distracted on mobile ·<br/>the sceptic deciding whether to trust you with money or data"]
M4 --> M5["Define FELT completion<br/>What must the customer believe and feel to walk away?<br/>Done includes 'I trust it happened'"]
M5 --> M6["Open the TASTE ledger<br/>2-3 best-in-class reference flows for the same job,<br/>screenshotted the same way, side by side<br/>Taste is comparative — no reference set, no grade"]
M6 --> M7["Memory prediction<br/>what must the customer know on each screen —<br/>what may they NEVER be asked to remember from a previous one?<br/>The right answer is: nothing"]
M7 --> M8["Surface prediction — every element pays rent in clarity or is removed<br/>a label labels · an example demonstrates · nothing does double duty"]
M8 --> MOUT["PREDICTIONS BROADCAST DOWN to every column<br/>feedback carries expectation — Rao–Ballard"]
end

CGATE["COLUMNS FIRE — parallel scan mode<br/>only when the evidence bundle AND the predictions are both present<br/>each column runs once per persona<br/>feedforward then carries residual error only — Rao–Ballard"]

subgraph L2["LAYER 2 · CORTICAL COLUMNS — massively parallel · every column is the same canonical microcircuit"]
TMPL["CANONICAL MICROCIRCUIT — the internal flow of EVERY column<br/>input layer: the shared evidence bundle<br/>deep layer: this column's slice of the expected experience<br/>superficial layer: typed prediction error + precision — confidence x severity<br/>output: the triple gap · confidence · severity, sent to the salience hub<br/>a column may request an evidence re-fetch — Mountcastle · Douglas–Martin · Bastos"]
CATT["ATTENTION and SALIENCE-MAP column<br/>draw the attention path: first fixation · second · the ONE primary action<br/>SQUINT test — blur it: does the hierarchy survive,<br/>does the primary action still win the fixation contest?<br/>FIVE-SECOND cold test: what is this · what can I do · what happens next —<br/>wrong answers are the screen's fault, not the viewer's<br/>look away 10 seconds and come back — do they still know where they are?<br/>signal vs decoration: a flag draws attention without outranking the primary action<br/>one screen · at most one raised voice — the map must show ONE peak<br/>Desimone–Duncan · Itti–Koch"]
CVOX["VOICE column<br/>read every word across the sequence, aloud —<br/>does the interface speak as one calm person, or a committee?<br/>an action keeps its name through the whole flow:<br/>the button that says Publish yields a toast that says Published<br/>words are the customer's, never the system's"]
CTST["TASTE column — vs the reference set, per screenshot<br/>spacing rhythm · type scale discipline · colour restraint ·<br/>alignment truth · density matched to the moment<br/>Name the defect precisely — 'looks off' is not a finding"]
CECH["ACTION-ECHO column<br/>after every action: what does the customer SEE change, immediately, on-screen?<br/>Silence after a tap is a broken promise<br/>waiting states narrate: what is happening · roughly how long ·<br/>what the customer may do meanwhile — a spinner is not an answer"]
CERR["ERROR-EXPERIENCE column<br/>error catalogue — one row per screenshot-able failure:<br/>what it says · in whose language · what the customer can DO from right there ·<br/>what is preserved — specific, never vague, and it never scolds<br/>second order per error: blame lands on the system, never the customer ·<br/>the way back is one tap · typed work is sacred — never lost<br/>one voice per moment: competing toasts, banners, modals<br/>collapse into a single next step — they do not stack"]
CSTA["STATE and CONTINUITY column<br/>beats stay distinct: see · understand · decide · act · confirm —<br/>merge only where the images prove the customer already finished them<br/>empty states have opposite jobs: first-run teaches and invites ·<br/>post-completion confirms and releases — never one screenshot serving both<br/>interruption is recoverable — returning is resuming<br/>no screen demands memory of a previous screen"]
CTRU["TRUST column<br/>reassurance exactly where fear peaks — the money and data moments<br/>when upsell and task collide, the task keeps the primary position. Always.<br/>completion is felt: celebration present, not hollow, never undercutting trust<br/>the end releases: outcome visible · trust earned · exit graceful"]
CACC["ACCESSIBILITY column — visible in the image<br/>contrast · touch target · text size · colour-only meaning<br/>the shadow audiences pass here or nowhere"]
DGN["DELIBERATE DEGENERACY<br/>critical failures are watched by more than one column via different routes<br/>Edelman–Gally: redundancy is robustness"]
TMPL -.- CATT
DGN -.- CTRU
end

subgraph L3["LAYER 3 · SALIENCE HUB — dACC + anterior insula analog · detect, triage, switch · Seeley · Menon–Uddin"]
SAL["THE GAP DETECTOR<br/>receives every gap · confidence · severity triple in parallel,<br/>plus the interoceptive runtime stream<br/>a salient gap wins: switch the network from parallel scan to serial fix"]
SAL --> ECLS["Two error classes<br/>DEFECT — a prediction violated outright<br/>CONFLICT — two simultaneously credible claims,<br/>such as two elements both reading as the primary —<br/>the monitor's specialty · Botvinick"]
ECLS --> GOR & GVT & GFB & GER & GST & GTR & GAX & GMT
GOR["ORIENTATION and HIERARCHY errors<br/>H1 customer cannot tell where they are — no orientation, no sense of progress<br/>H2 primary action loses the fixation contest — buried, tied, or below the fold<br/>H3 two elements shout at once — hierarchy collision on one screen<br/>H9 screen demands memory of a previous screen"]
GVT["VOICE and TASTE errors<br/>H4 words are the system's, not the customer's —<br/>jargon · internal states leaking · labels naming the build<br/>H10 taste defect vs reference — spacing arrhythmia · type scale drift ·<br/>colour noise · false alignment<br/>H11 tone seam — the voice changes mid-flow,<br/>or an action changes its name between screens<br/>H19 delight in the wrong place — decoration where clarity was owed"]
GFB["FEEDBACK and WAITING errors<br/>H5 action gives no immediate visible echo — the tap fell into silence<br/>H6 waiting without narration — no progress · no time sense · no permission to leave"]
GER["ERROR-HANDLING errors<br/>H7 error blames or strands the customer — or typed work was lost"]
GST["STATE errors<br/>H8 same job done two visual ways — customer must relearn a component mid-flow<br/>H14 empty state neither teaches nor confirms<br/>H15 interruption is unrecoverable — returning is not resuming"]
GTR["TRUST and RELEASE errors<br/>H12 trust gap at the money or data moment — no reassurance where fear peaks<br/>H13 completion feels like nothing — celebration missing, hollow, or undercutting trust<br/>H16 upsell or notification outranks the task<br/>H20 the end does not release — customer unsure whether to wait, check, or leave"]
GAX["ACCESS errors<br/>H17 accessibility failure visible in the image —<br/>contrast · touch target · text size · colour-only meaning"]
GMT["META error — about the audit itself, not the product<br/>H18 the screenshot set itself is incomplete —<br/>the state exists but no one can show it"]
GOR & GVT & GFB & GER & GST & GTR & GAX --> TRI
TRI["PRECISION TRIAGE<br/>weight every gap by confidence x severity — Friston precision<br/>low-precision findings park for the adversarial pass — they do not die"]
TRI --> REM["REMAINING LEDGER<br/>Record gap as REMAINING · Never ship as done<br/>recurrence raises that gap type's prior salience —<br/>the taxonomy learns · Holroyd–Coles"]
end

MODQ{"Which is wrong — the PRODUCT or the EXPECTATION?"}
FXA["ROUTE A — act on the world<br/>Specify the fix AS a screenshot — mock the corrected screen<br/>the fix is an image, not a sentence"]
BLD["Build / update the experience"]
RSH["RE-SCREENSHOT everything touched<br/>stale screenshots poison the audit"]
FXB["ROUTE B — update the model<br/>revise the persona, criterion or reference set the evidence defeated<br/>perception is the other way to kill an error — Friston"]

subgraph L4["LAYER 4 · BASAL GANGLIA GATE — winner-take-all selection · Redgrave"]
BG["ALL REMAINING GAPS SIT TONICALLY INHIBITED<br/>exactly ONE is disinhibited at a time, in strict precision order<br/>one primary fix in flight per surface —<br/>the audit obeys its own rule: one voice per moment"]
end

subgraph L5["LAYER 5 · GLOBAL WORKSPACE — the serial executive spine · Baars · Dehaene"]
WSN["THE SPINE CARRIES ONLY IGNITED CONTENT<br/>current phase gate · the one selected gap · OPEN, CLOSED, version<br/>everything else stays parallel and local"]
FE{"FREE-ENERGY READOUT<br/>Does the customer FEEL finished?<br/>is the total precision-weighted error below threshold?<br/>outcome visible · trust earned · exit graceful"}
WSN -.- FE
FE -- "Yes — below threshold" --> CAND["Candidate for Closure"]
CAND --> HID{"Any hidden moment of confusion,<br/>doubt, or lost work?"}
end

subgraph APX["ADVERSARIAL PASS — active inference · elicit the errors the passive crawl missed"]
ADV["Ask: how could this customer STILL feel<br/>lost, cheated, or stupid?"]
ADV --> P1["Hand a cold screenshot to someone outside the team<br/>have them narrate it back — where does the story break?"]
P1 --> P2["The distracted test<br/>could they finish this one-handed, interrupted twice,<br/>on a moving train?"]
P2 --> P3["The screenshot-to-support test<br/>if the customer screenshots this screen to complain,<br/>does the screen defend itself?"]
P3 --> P4["Strip the copy from a screenshot<br/>do layout and affordance alone<br/>still suggest the correct action?"]
P4 --> P5["Line every screenshot end-to-end on one wall<br/>does it read as one product, one voice, one hand?<br/>Then remove one accessory — what still asks to go?"]
P5 --> ADVQ{"Critical experience gap found?"}
end

subgraph RCX["RECONSOLIDATION — closure is a memory · Nader–Schafe–LeDoux"]
STQ{"Has the UI shipped changes<br/>since these screenshots were taken?"}
STQ -- "Yes — the verdict reactivates" --> LAB["LABILE STATE<br/>the reactivated verdict cannot be trusted as-is —<br/>it must re-pass the loop to re-stabilise"]
STQ -- "No" --> VER["Verify FELT closure with behaviour, not opinion<br/>task success observed, not self-reported<br/>no rage-taps or dead-clicks along the path<br/>support volume silent about this flow"]
VER --> PRV{"Can we prove customers finish<br/>AND feel finished?"}
end

subgraph CMX["CONSOLIDATED MEMORY — CLOSED is versioned, not eternal"]
CLZ["CLOSED vN<br/>bound to the exact screenshot set it was proven against<br/>prior versions kept as distinct traces"]
CLZ --> ZW["Zero orientation failures"]
ZW --> ZX["Zero unanswered actions"]
ZX --> ZY["Zero voice seams or hierarchy collisions"]
ZY --> ZZ["Customer leaves with outcome + confidence<br/>+ a reason to return"]
end

subgraph ICX["INTEROCEPTION — always-on background surveillance · Craig"]
ITO["Experience rules become RUNTIME monitors<br/>rage-tap and dead-click detection on the audited path<br/>funnel step drop-offs · error-message impressions ·<br/>support-ticket tags per flow<br/>A breach re-opens the audit"]
end

%% ══ EDGES ══
EX0 --> DRV
EX0 --> M1
EGATE -- "No — a state is missing" --> DRV
EGATE -- "Yes — driver ready" --> CGATE
MOUT --> CGATE
CGATE --> CATT & CVOX & CTST & CECH & CERR & CSTA & CTRU & CACC
CATT & CVOX & CTST & CECH & CERR & CSTA & CTRU & CACC --> SAL
GMT -- "an evidence error — re-shoot the missing state" --> DRV
REM --> FE
FE -- "No — errors remain" --> MODQ
MODQ -- "the expectation is wrong — revise the model" --> FXB
MODQ -- "the product is wrong — fix it" --> BG
BG --> FXA
FXA --> BLD
BLD --> RSH
RSH -- "fresh driver input — re-crawl from the TRUE first contact" --> BUS
FXB -- "revised predictions re-broadcast" --> MOUT
HID -- "Yes" --> SAL
HID -- "No" --> ADV
ADVQ -- "Yes" --> SAL
ADVQ -- "No" --> STQ
LAB -- "re-evidence" --> DRV
PRV -- "No" --> SAL
PRV -- "Yes" --> CLZ
ZZ -- "the rules arm as monitors" --> ITO
ITO -. "breach — the verdict reactivates" .-> LAB
CLZ -. "a touched screen ships a change" .-> STQ

%% ══ STYLES ══
style L0 fill:#eef4fb,stroke:#7d9cc0
style L1 fill:#f3eefb,stroke:#9c86c8
style L2 fill:#eefbf2,stroke:#7fbf95
style L3 fill:#fbf3ee,stroke:#c89b7d
style L4 fill:#fbeeee,stroke:#c87d7d
style L5 fill:#fbfaee,stroke:#b3a95f
style APX fill:#f4f4f4,stroke:#9a9a9a
style RCX fill:#eef7f7,stroke:#79a7a7
style CMX fill:#f2fbea,stroke:#8fae62
style ICX fill:#fdf0f6,stroke:#bd7da0