Intents
12 intents · 22 resolved (14 assumed)
Export .md
Share page
12
Copper Otter
Extend existing campaigns
HARRY must extend the current campaign setup through the existing follow-on campaign/parent-child model only, preserving automatic routing into child campaigns, draft follow-ons requiring startup before receiving leads, and detaching without deleting, while adding new sequence logic without replacing existing campaign data or flows.

CONSTRAINT
WORLD ASSUMPTION
medium blast
stated
Accepted when
Existing campaign flows remain available and are extended rather than replaced.
New campaign-related behavior is implemented through the current parent-child follow-on model.
Automatic routing into child campaigns, draft follow-on startup gating, and detach-without-delete behavior remain unchanged.
No new campaign subsystem bypasses the existing campaign code paths or data model.
Does not mean
Do not rewrite campaigns from scratch.
Do not remove existing subsequence behavior.
Do not replace existing campaign data with a separate campaign system.
Undecided
◆
Child-campaign edit authority. It is undefined who can modify existing child campaigns versus only append extensions, and whether edits are blocked once a campaign is live. Without explicit override/review rules, teams can accidentally mutate production journeys or create parallel variants that diverge from the parent flow.
accept
park
spawn
on assumption
✕
Only the campaign owner or an explicitly authorized editor may modify a child campaign, and edits to a live child campaign require the same permissions as the parent campaign. Live child campaigns may be updated in place; they are not blocked from edits by default.

Assumes: I assumed Harry follows a role-based editor model for campaigns and that live campaign edits should remain possible under permission controls.

◆
Extension conflict resolution. The merge rules for overlapping steps, triggers, and scheduling between the current campaign and the extension are not specified. If two extensions touch the same node, the system needs deterministic precedence, timeout, and rollback behavior or launches will become non-reproducible.
accept
park
spawn
on assumption
✕
When an extension overlaps an existing step or trigger, the newest explicitly attached child campaign takes precedence for routing decisions within its own subtree, while the parent flow remains unchanged. If two overlapping extensions exist at the same depth, the system must reject the second overlap instead of guessing a merge.

Assumes: I assumed deterministic routing is preferable to merge-based conflict resolution because the codebase already models explicit parent-child follow-ons.

◇
Validation and rollback on go-live. There is no acceptance gate for verifying the extended flow before activation, nor a fallback if the extension breaks downstream sends or child-campaign inheritance. A bad extension could silently replace or strand existing sequences with no safe recovery path.
accept
park
spawn
grounded
✕
Before a follow-on campaign can start receiving leads, it must pass validation for required routing fields and trigger legality. If activation fails after validation, the campaign stays in draft and its previously active parent-child relationships remain intact.

◇
new-sequence-rule-surface. The intent now includes new sequence logic, but nothing yet owns which campaign surfaces can define or edit those rules. That needs a dedicated draft so the extension does not become implicit.
accept
park
spawn
grounded
✕
New sequence rules must be edited only on the campaign detail surfaces that already own follow-on campaign setup. Those rules are saved with the campaign record rather than in a separate sequence subsystem.

◆
child-authority-and-conflict-policy. Keeping the parent-child model means the system still needs an explicit rule for who can edit child campaigns and how conflicting triggers or transitions are resolved.
accept
park
spawn
on assumption
✕
Campaign child edit authority follows the same permission model as general campaign editing, and conflicting child triggers are resolved by rejection rather than silent overwrite.

Assumes: I assumed the product should use a single campaign permission model and that silent overwrites are unacceptable.

◇
migration-and-safety-checks. Preserving current campaign data while adding sequence logic implies validation and rollback expectations for any go-live path, which should be owned explicitly.
accept
park
spawn
grounded
✕
Any go-live path for extended campaigns must preserve existing campaign rows and child links, and must fail closed by leaving the campaign in its previous state if validation does not pass. No migration may convert existing campaign records into a new schema in place.

Teal Pike
Separate contacts and leads
HARRY must keep contacts and leads as separate people lists, and when the same person appears in both lists it must remain as two separate list items rather than converting or merging them.

CONSTRAINT
REQUIREMENT
medium blast
stated
Accepted when
Contacts and leads are represented as distinct lists in the product.
If a person exists in both lists, the system keeps both records as separate list items.
Actions on one list do not implicitly create, merge, replace, or convert the other list item.
UI and API surfaces preserve separate list semantics.
Does not mean
Do not collapse contacts into leads.
Do not add an automatic synchronization rule that makes the lists identical.
Do not require a conversion workflow instead of separate entries.
Undecided
◆
Cross-list disposition linkage. It is not defined whether a single person can exist as both a contact and a lead with linked identity or whether they must remain entirely separate records. That matters for deduping, consent checks, and reporting; otherwise users may unknowingly operate on the wrong person record.
accept
park
spawn
grounded
✕
Contacts and leads may share identity fields such as name, email, and phone, but they remain separate records with separate list-specific fields and separate list membership. The same person can exist in both lists without automatic merging or conversion.

◇
Merge/convert escalation path. No process is defined for when a contact becomes a lead, or when a lead should be promoted back to contact, including who approves the change and how audit history is preserved. Without a controlled disposition change path, teams will create ad hoc duplicates or lose attribution.
accept
park
spawn
grounded
✕
Conversion between contacts and leads is deferred and not part of this intent; users keep separate records instead of using a promotion workflow. If a later product office wants conversion, it should define the approval and audit path separately.

◆
List-level consent and suppression rules. The product behavior for opt-outs, do-not-contact flags, and compliance suppression across the two lists is unspecified. If consent is tracked differently per list, messages can be sent to a record that appears eligible in one list but blocked in the other, creating legal and deliverability risk.
accept
park
spawn
on assumption
✕
Consent and suppression must be enforced at the record level for whichever list item is being messaged, and an opt-out on one list item must not automatically rewrite the other list item. Shared identity does not imply shared suppression state.

Assumes: I assumed list-specific compliance state is safer than global suppression when contacts and leads are intentionally separate.

◆
shared-vs-scoped-field-model. The updated rule now implies a data model boundary between shared identity fields and list-specific fields. No draft yet owns how that boundary is represented in storage or APIs.
accept
park
spawn
grounded
✕
Shared identity fields are limited to core person identifiers like name, email, and phone, while list-specific fields remain scoped to their own record type. APIs and storage must preserve that boundary so updates to scoped fields do not leak across lists.

Sable Falcon
Unified inbox channels
HARRY's Unified Inbox must include separate email, SMS, voice call, and campaign reply views, plus a combined all-channels view that merges those items.

CONSTRAINT
SPECIFICATION
high blast
stated
Accepted when
Unified Inbox exposes distinct views for email, SMS, voice calls, and campaign replies.
Unified Inbox also exposes one combined view that merges all supported channels.
Inbox items can be normalized enough to preserve cross-channel conversation context in the combined view.
Does not mean
Do not limit Unified Inbox to email only.
Do not make the combined view the only way to access inbox items.
Undecided
◆
Channel identity and threading rules. It is unclear how the inbox decides which items belong to the same conversation when the same person appears by email, phone number, and campaign reply. Without a canonical identity and threading rule, agents will see split threads or merged conversations for unrelated people.
accept
park
spawn
on assumption
✕
Unified Inbox items thread by a canonical person identity built from the available contact or lead record plus channel-specific identifiers such as email address or phone number. When a message cannot be matched confidently to one person, it must remain unthreaded rather than merged with another conversation.

Assumes: I assumed Harry should avoid unsafe conversation merges and keep uncertain items separate until identity is known.

◇
Per-channel read, reply, and ownership semantics. The required behavior for marking items read, replying, assigning ownership, and closing a conversation across email, SMS, voice, and campaign replies is undefined. If these states do not map cleanly across channels, users can lose SLA tracking or double-handle the same customer interaction.
accept
park
spawn
on assumption
✕
Read state, ownership, and reply behavior are tracked per inbox item, but a reply from any channel should close or update the shared conversation state for that thread. Channel-specific artifacts such as an SMS reply or email reply still retain their original channel metadata.

Assumes: I assumed users want a single conversation state with per-item channel metadata rather than separate state machines per channel.

◆
Fallback when a channel is unavailable. No failure mode is described for malformed voice events, provider outages, or unsupported campaign reply payloads entering the unified inbox. The system needs a clear quarantine, retry, or dead-letter path or bad events will poison the inbox stream.
accept
park
spawn
on assumption
✕
Malformed or unsupported inbox events must be quarantined from the main Unified Inbox view and logged for retry or inspection. Provider outages must not block processing of valid events from other channels.

Assumes: I assumed event quarantine is the lowest-blast default for malformed or unsupported inbound data.

Cedar Wren
Inbound call routing
Inbound voice calls must be routed through Harry Call Router to the existing Squad Institute call route only, replacing the current inbound voice routing path.

CONSTRAINT
SPECIFICATION
high blast
stated
Accepted when
Inbound voice calls are forwarded through Harry Call Router.
The destination is the existing Squad Institute call route only.
No additional Harry-side voice handling is required for this routing path.
Does not mean
Do not route inbound calls to any other destination.
Do not add inbox, lead, campaign, or audit side effects as part of this routing intent.
Do not keep the old inbound voice path as a fallback or parallel route.
Undecided
◆
Routing timeout and retry behavior. The handoff behavior is undefined if Harry Call Router cannot resolve the Squad Institute route immediately or the destination is offline. Without a timeout, retry, and fallback destination, inbound calls may drop silently or loop indefinitely.
accept
park
spawn
on assumption
✕
If Harry Call Router cannot resolve or reach the Squad Institute call route promptly, the call should fail fast to the configured destination path rather than loop. The routing decision must be retried once before surfacing an operational failure.

Assumes: I assumed a single retry and fail-fast behavior is safer than indefinite waiting for inbound calls.

◇
Manual override and exception handling. There is no rule for who can override the route during outages, after-hours, or misconfiguration, and whether that override is logged. Missing override authority creates an operational dead-end when the configured route fails in production.
accept
park
spawn
on assumption
✕
Operational staff may override the inbound voice route during outages or misconfiguration, and all overrides must be logged with the original and replacement destination. Overrides are an operations concern, not a routing-policy concern.

Assumes: I assumed inbound call routing needs an operational fallback owned outside the core routing rule.

◇
Routing validation and audit trail. The intent does not specify how routing success is validated in production, or what evidence must be retained for compliance and troubleshooting. Without logs showing source number, decision path, and destination, failed call handling will be impossible to prove or diagnose.
accept
park
spawn
grounded
✕
Each routed inbound call must record the source number, the routing decision, and the final destination route. The system should expose enough audit data to prove that the call was sent to Squad Institute's call route.

Marble Lynx
Automatic next-best-action
When HARRY selects a next-best action in the AI lead agent flow, low-risk actions must execute automatically without human approval, while actions that change lead, campaign, mailbox, or message state must still go through approval.

CONSTRAINT
SPECIFICATION
high blast
stated
Accepted when
Low-risk next-best actions in the AI lead agent flow execute without a human approval step.
Actions that change lead, campaign, mailbox, or message state still require approval before execution.
Successful execution both records the chosen action and performs its downstream side effect.
Does not mean
Do not apply automatic execution to non-agent surfaces such as campaign replies, inbox work items, or workflow-engine decisions.
Do not remove approval for state-changing actions.
Do not limit the action set to fewer than the supported next-best-action routing options.
Undecided
◆
Auto-execution safety gates. The system does not state whether any next-best actions require preconditions such as consent, quiet hours, account status, or spending limits before execution. If the AI can fire actions immediately, a bad selection can send unauthorized communications or trigger costly calls at the wrong time.
accept
park
spawn
on assumption
✕
Low-risk next-best actions may auto-execute only when the lead is eligible for contact and the action does not violate existing account rules such as opt-out state. If a precondition is not met, the action must not run automatically.

Assumes: I assumed contact eligibility and opt-out status are the minimum safety gates needed for automatic execution.

◆
Conflicting action disposition. It is undefined what happens when multiple candidate actions are selected, or when an action is already in progress and a new next-best action is emitted. The platform needs single-vs-multiple disposition rules, deduping, and cancellation behavior or it will double-send or oscillate between actions.
accept
park
spawn
on assumption
✕
The AI lead agent may have only one active next-best action per lead at a time. If a new action is emitted before the prior one completes, the newer one replaces the pending one only if the earlier action has not already been executed.

Assumes: I assumed single-active-action behavior is the simplest way to avoid double-sends and oscillation.

◇
Execution failure and retry policy. No behavior is defined for action delivery failures, partial completion, or provider rejects after the AI has already chosen the action. Without explicit retry, abandonment, and compensation rules, the persisted decision will not match what actually happened in the channel.
accept
park
spawn
on assumption
✕
If auto-execution fails after the AI chooses an action, the system must record the failure and leave the action incomplete. A single retry is allowed for transient delivery errors; persistent failures must stop the automation and surface an error state.

Assumes: I assumed one retry is enough to cover transient provider issues without masking real failures.

◆
low-risk classifier. The draft now depends on a concrete rule for deciding which next-best actions are low-risk versus state-changing. That classification is still unspecified and needs its own intent or reference.
accept
park
spawn
on assumption
✕
The low-risk set includes actions that do not change lead, campaign, mailbox, or message state, such as waiting or stopping a sequence when those are implemented as non-state-changing control actions. Everything else stays approval-bound.

Assumes: I assumed the safest classifier is to treat only non-mutating control actions as low risk unless a later office defines more.

◆
approval-state transition. The intent requires state-changing actions to stay in approval, but it does not yet say what state or event represents the approval gate or how an approved action resumes execution.
accept
park
spawn
on assumption
✕
State-changing next-best actions enter an explicit pending-approval state and only resume execution after an approval event marks them approved. Once approved, the original action continues from that pending record instead of being recreated.

Assumes: I assumed a pending-approval state is needed so the AI can resume the same action after approval.

◇
execution failure handling. Auto-execution now promises both completion recording and side effects, but there is still no owned rule for retries, partial failure, or what happens if the side effect fails after the action is recorded.
accept
park
spawn
grounded
✕
If the downstream side effect fails after the action is recorded, the system must mark the action as failed or partially completed rather than successful. The persisted decision and the real-world result must never disagree silently.

Onyx Lynx
Follow-on sequence logic extension
HARRY must add new sequence logic by extending existing follow-on campaign behavior, so new routing or progression rules operate within parent-child campaigns rather than introducing a separate campaign mechanism.

CONSTRAINT
REQUIREMENT
high blast
stated
↳ builds on Extend existing campaigns
Accepted when
New logic uses existing parent-child campaign relationships.
Existing campaign setup remains intact and readable through the current campaign paths.
New sequence behavior does not require replacing stored campaign records.
Campaign detail UI continues to expose child campaigns as follow-ons.
Does not mean
Do not create a separate campaign engine.
Do not alter non-campaign workspace models.
Do not change existing child-campaign detachment semantics.
Cobalt Badger
Shared identity fields only
HARRY must share only identity fields such as name, email, and phone across contacts and leads, while keeping all list-specific fields separate between the two lists.

CONSTRAINT
REQUIREMENT
medium blast
stated
↳ builds on Separate contacts and leads
Accepted when
A person's identity fields can be reused across both lists.
List-specific fields are not automatically copied between contacts and leads.
Editing a list-specific field in one list does not change the other list item.
Does not mean
Do not unify all person data into one shared record.
Do not mirror list-specific fields across lists automatically.
Indigo Otter
Voice call inbox records
Voice calls in HARRY's Unified Inbox must appear as call records that include notes and transcript content rather than only as routed activity items.

CONSTRAINT
REQUIREMENT
high blast
stated
↳ builds on Unified inbox channels
Accepted when
A voice call item renders as a call record with call-specific details.
The record includes notes and transcript content when present.
The voice call item is visible in the unified inbox and in the voice-call-specific view.
Does not mean
Do not model voice calls only as generic activity events.
Do not require callers to be shown as plain message threads.
Undecided
◆
Voice-call data shape. The thread fixes the display form, but it still needs the canonical fields and threading identity for a call record so the inbox can correlate the record with the right contact, lead, and conversation.
Coral Lynx
Campaign reply classification linkage
Campaign replies in HARRY's Unified Inbox must be classified and linked back to the originating campaign and lead so downstream routing can use the reply intent.

CONSTRAINT
REQUIREMENT
high blast
stated
↳ builds on Unified inbox channels
Accepted when
A campaign reply item carries a reply intent classification.
The same item is linked to its originating campaign and lead.
Routing can consume that classification instead of treating the reply as an ordinary untyped inbox message.
Does not mean
Do not keep campaign replies as inbox-only messages without routing metadata.
Do not infer campaign linkage from unrelated channel activity.
Undecided
◇
Reply-intent taxonomy. The routing requirement depends on the concrete reply-intent values and where they are produced, which are not yet specified here.
Cedar Heron
Low-risk next-best-action autopilot
In the AI lead agent flow, HARRY must execute low-risk next-best actions automatically and must still require approval for any next-best action that changes lead, campaign, mailbox, or message state.

CONSTRAINT
SPECIFICATION
high blast
stated
↳ builds on Automatic next-best-action
Accepted when
A low-risk next-best action can complete without human approval.
A state-changing next-best action cannot execute until approval is granted.
The flow distinguishes low-risk from state-changing actions.
Does not mean
Do not extend this behavior to inbox, campaign, or workflow surfaces.
Do not auto-approve state-changing actions.
Do not define the full risk taxonomy beyond low-risk versus state-changing for this intent.
Amber Osprey
Auto-execute side effects
When an eligible next-best action auto-executes in the AI lead agent flow, HARRY must both persist the chosen action as completed and perform the downstream side effect implied by that action.

CONSTRAINT
SPECIFICATION
high blast
stated
↳ builds on Automatic next-best-action
Accepted when
The system records the selected next-best action as completed.
The system performs the action's downstream side effect when execution is allowed.
Completion without side effect is not treated as success.
Does not mean
Do not require human approval for eligible low-risk actions.
Do not add this requirement to non-agent suggestion surfaces.
Do not define new side effects beyond those already implied by the routed action.
Indigo Wren
Agent-only scope
Automatic next-best-action execution must apply only inside the existing AI lead agent flow and must not extend to campaign replies, inbox work items, or workflow-engine decisions.

CONSTRAINT
SPECIFICATION
medium blast
stated
↳ builds on Automatic next-best-action
Accepted when
The automatic-execution rule is available in the AI lead agent flow.
Campaign replies do not gain this automatic-execution behavior from this intent.
Inbox work items and workflow-engine decisions do not gain this automatic-execution behavior from this intent.
Does not mean
Do not implement the behavior in inbox, campaign, or workflow modules.
Do not create new approval bypasses in other product surfaces.
Do not widen the scope beyond the current AI lead agent flow.

we are bulding this flowchart TD USER["Harry User / Business"] USER --> HARRY["HARRY\nAI Lead Management Platform"] %% CORE PRODUCT HARRY --> CONTACTS["Contacts + Leads"] HARRY --> CAMPAIGNS["Campaigns / Sequences"] HARRY --> INBOX["Unified Inbox"] HARRY --> AI["AI Lead Agent"] HARRY --> ANALYTICS["Analytics + Deliverability"] HARRY --> WORKFLOW["Workflow Engine"] %% EMAIL CONNECTIONS HARRY --> EMAIL["Email Adapter"] EMAIL --> GMAIL["Gmail API\nOAuth"] EMAIL --> OUTLOOK["Microsoft Graph\nOAuth"] GMAIL --> CUSTOMER["Lead / Customer"] OUTLOOK --> CUSTOMER CUSTOMER -->|"Email replies"| GMAIL CUSTOMER -->|"Email replies"| OUTLOOK GMAIL --> EMAIL OUTLOOK --> EMAIL %% SMS / VOICE HARRY --> COMMS["SMS + Voice Adapter"] COMMS --> PROVIDER["Telnyx / Plivo\nor another CPaaS"] PROVIDER --> DID["Dedicated Phone Number\nSMS + Voice capable"] DID -->|"Outbound SMS"| CUSTOMER CUSTOMER -->|"SMS Reply"| DID DID -->|"Inbound SMS webhook"| COMMS %% PHONE CALLBACK CUSTOMER -->|"Calls SMS number"| DID DID -->|"Inbound Voice"| ROUTER["Harry Call Router"] ROUTER -->|"Forward / SIP"| SQUAD["Squad Institute\nCall Route"] %% EVENT NORMALISATION EMAIL --> EVENTS["Harry Event Bus"] COMMS --> EVENTS EVENTS --> INBOX EVENTS --> CONTACTS EVENTS --> AI %% AI DECISIONING AI --> DECISION{"Next Best Action"} DECISION -->|"Email"| EMAIL DECISION -->|"SMS"| COMMS DECISION -->|"Call task"| ROUTER DECISION -->|"Wait"| WORKFLOW DECISION -->|"Stop sequence"| CAMPAIGNS ==== Look in the code and only reocmemend quesitns that hav enot been built yet [codebase indexed — Harry The Marketer: 265 files, 1,794 symbols (javascript)]
I’ll treat that architecture as the target shape, and constrain discovery toward the unbuilt/missing parts rather than rehashing what’s already there. I’ll pull the first question set now — pick what fits below, or just type your answers.I’ll treat that architecture as the target shape, and constrain discovery toward the unbuilt or missing parts rather than rehashing what’s already there. Pick what fits below, or just type your answers.

My answers to the clarifying questions: Extend campaigns or replace them? — extend current setup Should contacts and leads stay separate? — separate people lists Which messages belong in Unified Inbox? — email only; SMS only; voice calls; campaign replies; all three channels Where should inbound calls land? — Squad Institute route When AI suggests next action, who decides? — AI acts automatically Please compile.
Yep — compiling those into draft rulings now, with the “don’t ask for already-built stuff” constraint carried through. This may take a minute.Compiled. Here’s the first pass — mostly constraints, because your answers were architectural direction more than feature detail. - r-0 — Extend existing campaigns: HARRY must extend the current campaign setup rather than replace it. - r-1 — Separate contacts and leads: HARRY must keep contacts and leads as separate people lists. - r-2 — Unified inbox channels: Unified Inbox must include email, SMS, voice calls, campaign replies, and all three channels together. - r-3 — Inbound call routing: Inbound voice calls must route to the Squad Institute call route through Harry Call Router. - r-4 — Automatic next-best-action: When HARRY selects a next-best action, the AI must act automatically without human approval. A couple of sharp edges popped out: - r-2 has a wording conflict: “email only; SMS only; voice calls; campaign replies; all three channels” reads like multiple accepted inbox scopes. The ruling resolved it as all three channels, but we should tighten that. - r-4 is high-blast. “AI acts automatically” needs safety gates unless you really mean it can email/SMS/call-stop sequences without approval in every case. - r-1 needs consent/suppression rules across separate lists, otherwise you’ll get duplicate outreach or compliance weirdness. Tiny footgun, large crater. Open gaps are mainly around threading, failure handling, routing retries, consent rules, and auto-action safety. Want me to propose resolutions for those gaps, or do you want to refine one ruling first?

Going deeper
14 questions across 5 intents — answer what you can (each block sharpens that intent only), or take them to the gate as they stand.

Extend existing campaigns
When HARRY extends the current campaign setup, should new campaign capabilities be added as follow-on behavior inside the existing campaign model, or only as separate campaigns that connect to the current ones without changing them?
↳ sourced from codebase Harry The Marketer

Add behavior through the existing follow-on campaign/parent-child model only
Extend existing campaigns in place as well as through follow-on campaigns
Both: keep the current model and add a new extension mechanism alongside it
or write your own…
Which existing campaign behaviors must remain unchanged while extending the setup: automatic routing into child campaigns, draft follow-ons needing to be started before receiving leads, detaching without deleting, or all of these? choose any
↳ sourced from codebase Harry The Marketer

Automatic routing into child campaigns only
Draft follow-ons must still require start before receiving leads only
Detaching must still unlink without deleting only
All of these
or add your own…
What outcome should count as a successful campaign extension in this repo: preserving current campaign setup while adding new sequence logic, adding new routing triggers for existing campaigns, or enabling both without changing existing campaign data? choose any
↳ sourced from codebase Harry The Marketer

Preserve current campaign setup and add new sequence logic
Add new routing triggers to existing campaigns
Enable both while leaving existing campaign data unchanged
or add your own…
Separate contacts and leads
When a person moves between contacts and leads, what should happen to the original entry: keep both entries, convert the existing entry, or create a linked duplicate?
↳ sourced from codebase Harry The Marketer

Keep both entries as separate list items
Convert the existing entry from one list to the other
Create a linked duplicate in the other list and keep the original
or write your own…
Beyond keeping the lists separate, which person data should be shared across contacts and leads, if any? choose any
↳ sourced from codebase Harry The Marketer

No shared editable data; contacts and leads each own their own fields and history
Share identity fields only, such as name/email/phone, but keep list-specific fields separate
Share activity/history only, but keep editable profile fields separate
or add your own…
Unified inbox channels
Should Unified Inbox surface each channel as its own inbox view, plus a combined view that merges email, SMS, voice calls, and campaign replies, or only the combined all-channels view?
Separate per-channel views and a combined all-channels view
Only the combined all-channels view
Only per-channel views, no combined view
or write your own…
In Unified Inbox, how should a voice call appear: as a full message thread, as a call record with notes/transcript, or only as a routed activity item?
↳ sourced from codebase Harry The Marketer

Full message thread
Call record with notes/transcript
Routed activity item only
or write your own…
For campaign replies in Unified Inbox, should Harry treat them as ordinary inbox messages only, or should they also be classified and linked back to the campaign/lead so downstream routing can use the reply intent?
↳ sourced from codebase Harry The Marketer

Treat them as ordinary inbox messages only
Also classify and link them back to campaign/lead routing
or write your own…
Inbound call routing
For inbound voice calls, what is the exact destination behavior: should Harry Call Router forward the call into the existing Squad Institute call route only, or should it also trigger any additional voice handling inside Harry (for example logging, inbox activity, or campaign/lead updates)?
↳ sourced from codebase Harry The Marketer

Forward to the Squad Institute call route only
Forward to the Squad Institute call route and also create internal Harry activity/records
Forward to the Squad Institute call route and also update lead/campaign state
or write your own…
Compared with the current inbound voice path, should this change replace the existing routing behavior entirely, or should Harry Call Router sit in front of the current route as a fallback/adapter so the existing flow still works when the new route is unavailable?
↳ sourced from codebase Harry The Marketer

Replace the current inbound voice routing with Harry Call Router
Keep the current route as a fallback/adapter behind Harry Call Router
or write your own…
What should count as success for this inbound voice routing intent: a call reaches Squad Institute through Harry Call Router, a call is routed and observable somewhere in Harry, or a call is routed plus linked to a lead/campaign for later automation?
↳ sourced from codebase Harry The Marketer

A call reaches Squad Institute through Harry Call Router
A call is routed and visible in Harry as an activity or log
A call is routed and linked to a lead/campaign for downstream automation
or write your own…
Automatic next-best-action
When HARRY selects a next-best action, should the system execute it immediately, or should it still create an approval step for any action that changes a lead, campaign, mailbox, or message state?
↳ sourced from codebase Harry The Marketer

Execute immediately for all next-best actions
Execute immediately only for low-risk actions; keep approval for state-changing actions
or write your own…
What should count as the successful effect of an auto-executed next-best action in Harry: only recording the chosen action as completed, or also performing the downstream side effect the action implies, such as sending an email/SMS, creating a call task, waiting, or stopping a sequence?
↳ sourced from codebase Harry The Marketer

Record the choice only
Perform the full downstream side effect
Both record the choice and perform the side effect
or write your own…
Should this automatic execution apply only to next-best actions selected inside the existing AI lead agent flow, or also to any other places Harry can suggest or queue actions, such as campaign replies, inbox work items, or workflow-engine decisions?
↳ sourced from codebase Harry The Marketer

Only the AI lead agent next-best-action flow
Also other action-suggestion surfaces in Harry
Only the AI lead agent flow for now, with no other surfaces
or write your own…
Continue →
Resumed
5 intents in this thread. Continue below, or take them to the gate.

Add behavior through the existing follow-on campaign/parent-child model only · All of these · Preserve current campaign setup and add new sequence logic · Keep both entries as separate list items · Share identity fields only, such as name/email/phone, but keep list-specific fields separate · Separate per-channel views and a combined all-channels view · Call record with notes/transcript · Also classify and link them back to campaign/lead routing · Forward to the Squad Institute call route only · Replace the current inbound voice routing with Harry Call Router · A call reaches Squad Institute through Harry Call Router · Execute immediately only for low-risk actions; keep approval for state-changing actions · Both record the choice and perform the side effect · Only the AI lead agent flow for now, with no other surfaces
Continuing
I read your answer as confirming the existing parent-child follow-on model stays in place, with all current campaign behaviors preserved while adding new sequence logic on top.

Thread continued — 1 new intent drafted, 1 refined in place, 3 new gaps surfaced. Nothing is real until you sign it.

Continuing
You are narrowing the separation rule so I am refining r-1 to require duplicate list entries plus shared identity fields only, while keeping list-specific data isolated.

Thread continued — 1 new intent drafted, 1 refined in place, 1 new gap surfaced. Nothing is real until you sign it.

Continuing
I read your answers as narrowing the unified inbox into separate per-channel views plus a combined all-channels view, with voice calls shown as call records that include notes/transcript and campaign replies classified and linked back into campaign/lead routing.

Thread continued — 2 new intents drafted, 1 refined in place, 2 new gaps surfaced. Nothing is real until you sign it.

Continuing
I read this as tightening the existing inbound call routing intent to a single replacement path: calls should go only through Harry Call Router to the Squad Institute call route, with success defined as reaching that destination.

Thread continued — 1 refined in place. Nothing is real until you sign it.

Continuing
You want r-4 narrowed so automatic execution applies only to low-risk next-best actions in the AI lead agent flow, while state-changing actions still require approval and successful auto-actions both record the choice and perform the side effect.

Thread continued — 3 new intents drafted, 1 refined in place, 3 new gaps surfaced. Nothing is real until you sign it.

22 gaps resolved — 8 grounded in your words, 14 on explicit assumptions. Edit or reject any of them on the right; at the gate you adopt them as your own. Nothing is real until you sign it.