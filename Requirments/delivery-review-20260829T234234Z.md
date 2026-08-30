---
doc: delivery-review-brief
audience: [ai, human]
title: "Delivery review — Harry The Marketer"
exported_at: 2026-08-29T23:42:34.718Z
start: immediate
session_id: f4c2661c-3e95-4d52-9e98-d6d778ac9453
project: "Harry The Marketer"
intent_count: 8
gap_count: 12
resolved_gap_count: 0
undecided_gap_count: 12
assumed_gap_count: 0
status_tags: [OPEN, DONE, UNDECIDED, RESOLVED, ASSUMED]
---

# Delivery review — Harry The Marketer

> **For AI agents:** This brief is the source of truth for what was taken to delivery.
> Implement each intent's statement and **Accepted when** checks. Honour **Does not mean**.
> Treat `UNDECIDED` gaps as open questions — do not invent resolutions.
> Treat `RESOLVED` / `ASSUMED` gaps as decided constraints for this run.
> Start window: **immediate**. Prefer the work feed to claim build work after reading this brief.

> **For human review:** Skim the summary, then each intent. Undecided gaps need a decision before you treat the packet as fully settled.

## Summary

| Field | Value |
| --- | --- |
| Exported | 2026-08-29T23:42:34.718Z |
| Local time | 8/30/2026, 9:42:34 AM |
| Start | `immediate` |
| Session | `f4c2661c-3e95-4d52-9e98-d6d778ac9453` |
| Project | Harry The Marketer |
| Intents | 8 |
| Gaps | 12 (0 resolved; 12 undecided) |

### Undecided gaps (needs review)

- `UNDECIDED` · intent `r-0` · **Render validation criteria** (medium) — No criteria defined for verifying tab adjacency survives future refactors of ResponseStats or CampaignsTab layout changes, risking silent misplacement in production builds.
- `UNDECIDED` · intent `r-0` · **Permission-gated visibility** (medium) — Undefined whether follow-up tab respects the same role-based access that gates ResponseStats, allowing unauthorized users to see non-response cohorts.
- `UNDECIDED` · intent `r-1` · **Threshold change audit trail** (blocking) — No requirement to log who modified per-campaign thresholds or to surface those changes in campaign history, blocking compliance review of non-responder classification rules.
- `UNDECIDED` · intent `r-1` · **Invalid threshold escalation** (medium) — No path defined for rejecting or warning on thresholds below campaign send cadence or above legal contact window, risking mass mislabeling of responsive leads.
- `UNDECIDED` · intent `r-2` · **Active status race condition** (blocking) — Undefined behavior when a campaign flips inactive between the moment the graph query runs and the enrollment trigger fires, potentially enrolling leads from now-excluded campaigns.
- `UNDECIDED` · intent `r-2` · **Active definition source of truth** (medium) — No single owner specified for the 'active' flag used by the graph versus the flag used by enrollment, creating drift between displayed and actionable cohorts.
- `UNDECIDED` · intent `r-3` · **Pre-enrollment consent record** (blocking) — No obligation to check or store lead-level consent for follow-up sequences before the auto-enroll API call, exposing the product to regulatory and deliverability risk.
- `UNDECIDED` · intent `r-3` · **Enrollment failure handling** (blocking) — No timeout, retry, or partial-success model defined when the enrollment API returns errors for some leads in the cohort, leaving the graph state inconsistent with actual sequence membership.
- `UNDECIDED` · intent `r-3` · **Override authority before commit** (medium) — No review step or approver role required before the cohort selection commits enrollment, removing any human gate on bulk follow-up actions.
- `UNDECIDED` · intent `r-4` · **Cross-graph data drift detection** (medium) — No go-live validation that reply and follow-up graphs remain synchronized when the shared data source schema changes, allowing silent divergence in reported numbers.
- `UNDECIDED` · intent `r-4` · **Tab order under conditional rendering** (medium) — Undefined rule for whether the reply tab appears if the follow-up tab is hidden by feature flag, breaking the stated adjacency guarantee.
- `UNDECIDED` · intent `r-6` · **Row-level data source** (medium) — No draft yet owns the exact query or aggregation that produces one row per unique contact from the follow-up graph.

## Intents

### 1. Follow-up tab placement

- Intent id: `r-0`
- Status: `OPEN` (2 undecided gaps)
- Agent name: Coral Harrier
- Tags: CONSTRAINT · SPECIFICATION · medium blast · stated

#### Statement

The Follow-ups tab must render as a dedicated non-response graph (not reusing FollowUpComparison) immediately after the ResponseStats panel inside CampaignsTab.jsx and must remain visible for every campaign selection regardless of whether non-response data exists.

#### Accepted when

- [ ] Tab renders immediately after ResponseStats in CampaignsTab.jsx
- [ ] Primary content is a dedicated non-response follow-up graph (new implementation, not extension of FollowUpComparison)
- [ ] Tab is always present and visible for active campaigns
- [ ] View is strictly read-only with no selectable cohorts or manual actions

#### Does not mean

- Any reuse or extension of FollowUpComparison
- Replacing or modifying the existing ResponseStats component
- Conditional visibility based on data presence

#### Gaps

##### `UNDECIDED` Render validation criteria (medium)

No criteria defined for verifying tab adjacency survives future refactors of ResponseStats or CampaignsTab layout changes, risking silent misplacement in production builds.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Permission-gated visibility (medium)

Undefined whether follow-up tab respects the same role-based access that gates ResponseStats, allowing unauthorized users to see non-response cohorts.

- Status: Undecided — do not invent a resolution.

---

### 2. Configurable response threshold

- Intent id: `r-1`
- Status: `OPEN` (2 undecided gaps)
- Agent name: Quartz Egret
- Tags: CONSTRAINT · REQUIREMENT · medium blast · stated

#### Statement

Users must be able to define per-campaign time thresholds that mark a lead as non-responsive and eligible for follow-up.

#### Accepted when

- [ ] UI allows defining per-campaign time threshold
- [ ] Threshold value is persisted and used only for future lead enrollments
- [ ] Threshold crossing appears only in reports/graphs and never auto-advances the playbook
- [ ] Any reply (regardless of classified intent) resets the non-response timer for that lead
- [ ] Threshold change does not retroactively affect already-enrolled leads

#### Does not mean

- Hard-coded thresholds or global-only settings
- Automatic playbook progression on threshold breach
- Retroactive application to existing enrollments

#### Gaps

##### `UNDECIDED` Threshold change audit trail (blocking)

No requirement to log who modified per-campaign thresholds or to surface those changes in campaign history, blocking compliance review of non-responder classification rules.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Invalid threshold escalation (medium)

No path defined for rejecting or warning on thresholds below campaign send cadence or above legal contact window, risking mass mislabeling of responsive leads.

- Status: Undecided — do not invent a resolution.

---

### 3. Active-campaign scope

- Intent id: `r-2`
- Status: `OPEN` (2 undecided gaps)
- Agent name: Slate Tern
- Tags: CONSTRAINT · SPECIFICATION · low blast · stated

#### Statement

The follow-up graph must aggregate and display non-response data exclusively from campaigns whose status is 'active' or 'running' in the campaigns table at the exact moment the report is generated.

#### Accepted when

- [ ] Graph data source filters to campaigns with status 'active' or 'running' at query time only
- [ ] Inactive, archived, paused or draft campaigns are excluded from counts and visuals
- [ ] When zero campaigns meet the active criterion the graph renders an empty state that states only active campaigns contribute

#### Does not mean

- Including data from campaigns that were active during the report range but inactive at query time
- Showing any non-active campaigns

#### Gaps

##### `UNDECIDED` Active status race condition (blocking)

Undefined behavior when a campaign flips inactive between the moment the graph query runs and the enrollment trigger fires, potentially enrolling leads from now-excluded campaigns.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Active definition source of truth (medium)

No single owner specified for the 'active' flag used by the graph versus the flag used by enrollment, creating drift between displayed and actionable cohorts.

- Status: Undecided — do not invent a resolution.

---

### 4. Auto-enroll trigger

- Intent id: `r-3`
- Status: `OPEN` (3 undecided gaps)
- Agent name: Coral Stoat
- Tags: CONSTRAINT · REQUIREMENT · high blast · stated

#### Statement

Selecting a non-responsive cohort in the campaign graph must automatically enroll those leads into the next step already defined in the campaign’s mermaid playbook graph, recording the enrollment with a distinct source label while preserving normal removal rights.

#### Accepted when

- [ ] Clicking a non-responsive cohort in the graph calls the enrollment API
- [ ] Enrolled leads appear in the target sequence with distinct source label visible in audit trail
- [ ] Leads can be manually removed from the sequence exactly as any other enrollment

#### Does not mean

- Selectable cohorts or manual follow-up action inside the Follow-ups tab itself
- Any change to how non-responsive cohorts are defined or rendered

#### Gaps

##### `UNDECIDED` Pre-enrollment consent record (blocking)

No obligation to check or store lead-level consent for follow-up sequences before the auto-enroll API call, exposing the product to regulatory and deliverability risk.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Enrollment failure handling (blocking)

No timeout, retry, or partial-success model defined when the enrollment API returns errors for some leads in the cohort, leaving the graph state inconsistent with actual sequence membership.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Override authority before commit (medium)

No review step or approver role required before the cohort selection commits enrollment, removing any human gate on bulk follow-up actions.

- Status: Undecided — do not invent a resolution.

---

### 5. Reply graph parity

- Intent id: `r-4`
- Status: `OPEN` (2 undecided gaps)
- Agent name: Copper Marten
- Tags: HYPOTHESIS · SPECIFICATION · medium blast · inferred

#### Statement

A reply graph using the identical three-column card layout, styling, and endpoint (or drop-in replacement with the same payload shape) as FollowUpComparison must appear in the tab immediately adjacent to the follow-up graph tab.

#### Accepted when

- [ ] Reply graph re-uses the exact three-column rate-card layout and styling of FollowUpComparison
- [ ] Reply graph consumes the identical /api/analytics/followup-reply-rate endpoint or a structurally identical replacement
- [ ] Reply graph tab is rendered immediately left or right of the follow-up graph tab
- [ ] All numeric fields and range metadata match between the two graphs

#### Does not mean

- Any reply reporting surface that does not share the three-column card layout or the follow-up endpoint shape
- Placing the reply graph anywhere except the immediate neighbor tab

#### Gaps

##### `UNDECIDED` Cross-graph data drift detection (medium)

No go-live validation that reply and follow-up graphs remain synchronized when the shared data source schema changes, allowing silent divergence in reported numbers.

- Status: Undecided — do not invent a resolution.

##### `UNDECIDED` Tab order under conditional rendering (medium)

Undefined rule for whether the reply tab appears if the follow-up tab is hidden by feature flag, breaking the stated adjacency guarantee.

- Status: Undecided — do not invent a resolution.

---

### 6. Follow-up list scheduling

- Intent id: `r-5`
- Status: `READY`
- Agent name: Indigo Falcon
- Tags: CONSTRAINT · SPECIFICATION · medium blast · stated
- Builds on: Follow-up tab placement (`r-0`)

#### Statement

The primary list in the Follow-ups tab must display, for each non-responsive lead from active campaigns, the exact follow-up time or window computed from the configured response threshold and the follow-up graph data.

#### Accepted when

- [ ] List renders one row per eligible lead
- [ ] Each row shows lead identifier and computed follow-up time/window
- [ ] Times are derived from active-campaign thresholds and graph data
- [ ] List updates when thresholds change

#### Does not mean

- CSV export as primary mechanism
- Static or non-time-based list

#### Gaps

_No gaps recorded for this intent._

---

### 7. Read-only contact timeline

- Intent id: `r-6`
- Status: `OPEN` (1 undecided gap)
- Agent name: Slate Egret
- Tags: CONSTRAINT · SPECIFICATION · medium blast · stated
- Builds on: Follow-up tab placement (`r-0`)

#### Statement

The Follow-ups tab must present exactly one timeline entry per unique contact across active campaigns, with each contact occupying its own dedicated row rendered as a non-linear grid that displays that contact's lifecycle state, stage progression, message counts per step, reply counts, and next scheduled follow-up window with no interactive elements.

#### Accepted when

- [ ] One row/entry per unique contact from active campaigns with each contact in its own dedicated row
- [ ] Each entry renders as a grid with progression cells showing message/reply counts per stage
- [ ] Grid supports non-linear movement (contacts advance or regress by stage)
- [ ] Timeline is sorted and read-only with zero action controls
- [ ] Data recomputes when thresholds change

#### Does not mean

- Cohort selection, buttons, or any enrollment surface inside the tab
- Multi-contact bulk actions

#### Gaps

##### `UNDECIDED` Row-level data source (medium)

No draft yet owns the exact query or aggregation that produces one row per unique contact from the follow-up graph.

- Status: Undecided — do not invent a resolution.

---

### 8. Grid timeline progression

- Intent id: `r-7`
- Status: `READY`
- Agent name: Indigo Pike
- Tags: CONSTRAINT · SPECIFICATION · medium blast · stated
- Builds on: Read-only contact timeline (`r-6`)

#### Statement

The Follow-ups tab grid must render non-linear stage progression cells for each contact, displaying per-stage message counts and reply counts derived from the follow-up graph and active-campaign thresholds.

#### Accepted when

- [ ] Grid cells display exact message count and reply count per stage
- [ ] Progression is non-linear and reflects current contact position
- [ ] Counts update when graph data or thresholds change
- [ ] View remains strictly read-only

#### Does not mean

- Linear timeline rendering
- Actionable controls inside grid cells
- Cohort selection or enrollment from the grid

#### Gaps

_No gaps recorded for this intent._

---

## AI build checklist

1. Read Summary + any `UNDECIDED` gaps first.
2. For each intent id above, implement the Statement.
3. Verify every **Accepted when** checkbox before marking work done.
4. Do not implement items under **Does not mean**.
5. Ping `/brief/ping` only for orientation; claim build work on the work feed.
