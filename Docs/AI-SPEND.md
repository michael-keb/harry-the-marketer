# AI spend cap — design note

Landing the PRODUCT.md #1 blocking item: a per-workspace monthly AI allowance so
the engine cannot research every lead without a budget.

## Rules

- Allowance is in **cents per calendar month (UTC)**, keyed by `users.plan_id`
  (and demoted to the trial ceiling when billing is not active).
- Costs (approx.): research 40¢, compose 3¢, classify 1¢, purpose 1¢, qualify 2¢.
- Allowances: trial $5, starter $15, growth $40, scale $100.
- Charge is atomic (`UPDATE … WHERE cents_used + cost <= allowance`) so two ticks
  cannot both slip under the ceiling.
- When exhausted: **research is skipped**, **compose falls back to the template
  path**, **classify uses the heuristic**. The product keeps sending; it stops
  paying the model.
- Meter surfaces on **Monitoring → AI agent**, not on every send.

## Files

- `server/ai-spend.js` — allowance, canAfford, chargeAi
- `server/ai.js` — charges before paid calls; respects AiBudgetError
- `server/engine.js` / `server/routes.js` — pass workspaceId into research/compose
- `tests/ai-spend.test.js`
