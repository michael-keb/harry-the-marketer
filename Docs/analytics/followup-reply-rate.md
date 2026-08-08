# Follow-up Reply Rate

| | |
|---|---|
| **Endpoint** | `GET https://server.smartlead.ai/api/v1/analytics/campaign/follow-up-reply-rate` |
| **Category** | analytics |
| **Source** | https://api.smartlead.ai/api-reference/analytics/followup-reply-rate |
| **Auth** | API key (query param `api_key`) |

Returns a single number: the reply rate earned by follow-up emails rather than by the first one.

## 1. Epic

**Workspace-wide outreach analytics**

The epic gives a Harry user one honest picture of outreach performance across every campaign, mailbox and lead in the workspace: what went out, what came back, which replies were worth having, and which mailboxes are carrying the load. It matters because Harry already reports beautifully on a single campaign, and the questions that decide where to spend next week — which campaign, which sending day, which mailbox, which follow-up step — can only be answered above the level of one campaign.

## 2. User story

**As a** marketer deciding how many follow-ups to write, **I want** the reply rate that follow-ups earn on their own, **so that** I can tell whether chasing is worth the goodwill it costs.

**Acceptance criteria**
- [ ] Given a valid `start_date` and `end_date`, when I request the rate, then `data.followup_reply_rate` returns a plain number such as `3.2`, understood as a percentage and never divided by 100 again.
- [ ] Given Harry's playbooks are diagrams rather than numbered steps, when the rate is computed, then a "follow-up" is defined as any `Send:` node reached along a `no reply Xd` edge, and that definition is stated in the UI.
- [ ] Given no follow-up was sent in the range, when the rate is requested, then the response is `null` or zero and the UI shows `—` with "no follow-ups sent in this range" rather than a misleading `0%`.
- [ ] Given `campaign_ids` is supplied, when the rate is requested, then it covers only those campaigns, so a single playbook can be judged on its own.
- [ ] Given the rate is shown next to the first-email reply rate, when both are displayed, then the comparison is explicit, because the number is meaningless alone.
- [ ] Given the API key is invalid, when the rate is requested, then a 401 `{"message": "Invalid API Key"}` is surfaced as one banner without blanking the surrounding panel.
- [ ] Given the rate is a single scalar, when the panel renders, then the underlying counts (follow-ups sent, replies to follow-ups) are shown alongside it so the number can be checked.

## 3. Test cases

| # | Scenario | Steps | Expected result |
|---|---|---|---|
| TC-1 | Happy path | Seed a campaign where 500 follow-ups earned 16 replies in January. Request that range | 200 with `followup_reply_rate: 3.2` |
| TC-2 | Missing/invalid API key | Repeat TC-1 with `api_key` omitted | 401 `{"message": "Invalid API Key"}`; the tile shows a reconnect message |
| TC-3 | Not found / wrong workspace | Pass `campaign_ids` from another workspace | 404 `{"error": "Resource not found"}`; no rate is returned |
| TC-4 | Validation failure | Omit `start_date` | 422 `{"error": "Invalid parameters provided"}` naming `start_date` |
| TC-5 | Rate limited | Call 30 times in a second | 429; back off once, keep the last known rate marked stale |
| TC-6 | Empty result set | Request a range where only first emails were sent | 200 with a null or zero rate; the tile shows `—` and "no follow-ups sent in this range" |
| TC-7 | Follow-up definition | Seed a playbook with a `Send:` node reached by `reply: question` and another reached by `no reply 3d` | Only the `no reply` one counts as a follow-up; the tooltip states the rule |
| TC-8 | Compared with first email | Seed a campaign whose first email replies at 9% and follow-ups at 3.2% | Both numbers appear side by side and the panel names which is which |
| TC-9 | Percentage handling | Inspect the raw value and the rendered tile | `3.2` renders as `3.2%`, never `320%` or `0.032%` |
| TC-10 | Single-campaign filter | Request with `campaign_ids` set to one campaign, then to all | The single-campaign figure differs and both are labelled with their scope |
| TC-11 | Multiple follow-ups per lead | Seed a lead who received three follow-ups and replied to the third | The reply is attributed once and the denominator counts all three sends; the method is stated |

## 4. Frontend user story

**As a** marketer, **I want** the follow-up reply rate shown in the Reports Learning section beside the first-email rate, **so that** I can decide whether to add a chase step or cut one.

**Scope**
- Reports page: the existing Learning section, which already attributes replies to the playbook step that earned them, gains a first-email versus follow-up comparison row with the counts behind each rate.
- The row links into the campaign editor at the specific `Send:` node reached by the `no reply` edge, so the advice is one click from the text that needs rewriting.
- Loading shows a skeleton row. Empty shows "No follow-ups sent between X and Y". Error keeps the rest of the Learning section rendered.
- Accessibility: the comparison is a definition list, not a chart, so it reads correctly aloud; both rates carry their denominators in text; the row wraps rather than scrolling on narrow screens.

**Definition of done**
- [ ] The tile shows the rate, the numerator and the denominator together.
- [ ] The definition of a follow-up is one sentence visible in the panel, not hidden in a tooltip.
- [ ] `—` is shown when no follow-ups were sent.
- [ ] Empty, loading and error states are covered by component tests.

## 5. Backend user story

**As a** Harry server, **I want** to classify each send as a first email or a follow-up from the playbook edge that triggered it, **so that** the rate matches how Harry's diagrams actually work.

**Scope**
- Add `GET /api/analytics/followup-reply-rate?from=&to=&timezone=&campaign_ids=` to `server/routes.js`, workspace-scoped, returning `{ rate, followups_sent, followup_replies }`.
- Data model: none if the triggering edge is already recorded with each message; otherwise persist the edge label on send in `messages`, which the Learning section can reuse.
- Treat a `Send:` node entered via a `no reply Xd` edge as a follow-up and a node entered from `Start` as a first email; nodes entered via a `reply:` edge are conversation replies and belong to neither.
- Validate the date pair, cap the window, and return `rate: null` when the denominator is zero. The existing API limiter applies with brief caching.
- Log a `telemetry` row per call; log an `events` row only if the classification finds sends it cannot categorise.

**Definition of done**
- [ ] The classifier is unit tested against the README's example playbook, including its `reply: question` branch.
- [ ] `rate` is null, never `NaN` or `0`, when nothing was sent.
- [ ] Uncategorised sends are counted and reported rather than silently dropped.
- [ ] Cross-workspace campaigns contribute nothing.

## 6. End-to-end test ticket

**Title:** E2E — follow-up versus first-email reply rate

**Preconditions:** A workspace with one campaign using the README's example playbook on a sandbox mailbox: 20 leads, all receiving the first email, 12 receiving the `no reply 3d` follow-up, 2 replies to the first email and 1 to the follow-up.

**Flow**
1. Sign in and open Reports.
2. Set the range to cover the run.
3. Read the Learning section's comparison row.
4. Click through to the follow-up node in the campaign editor.
5. Narrow the range to the day the first emails went out only.

**Assertions**
- [ ] The first-email rate reads 10% from 2 of 20 and the follow-up rate reads about 8.3% from 1 of 12.
- [ ] The reply that came via the `reply: question` edge is in neither rate.
- [ ] The click-through opens the editor focused on the follow-up `Send:` node.
- [ ] The narrowed range shows `—` for follow-ups with the "no follow-ups sent" message.

**Teardown:** Delete the seeded campaign, leads and messages.

## 7. Impact on UI

| Surface | Change | Bloat risk | Mitigation |
|---|---|---|---|
| Reports | The existing Learning section gains one comparison row | Low | One row of text with two rates and their counts, no chart |
| Campaign editor | Becomes the click-through target from that row | Low | Uses the node focus the editor already supports |
| Dashboard | None | Low | A single derived rate does not deserve a KPI tile |

**Verdict:** Fits an existing surface

Harry's Learning section already attributes every reply to the playbook step that earned it, which is a richer version of this number — this endpoint's contribution is the blunt headline comparison that makes the detail worth reading. It is one row in a section that exists, and it deliberately does not become a Dashboard tile.
