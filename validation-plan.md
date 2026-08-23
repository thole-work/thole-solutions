# Phase 7 — Validation Mini-Sprint Plan
**Product**: Thole POS · **Format**: 5 working days, ~30 min/session · **Participants**: 3–5 restaurant staff/owners

> Why 3–5 users: Nielsen's research — 5 participants surface ~85% of usability problems.
> A full GV sprint needs a team; you need signal, not ceremony.

---

## What we're validating (ranked)

| # | Question | Feature area | Risk if wrong |
|---|----------|--------------|---------------|
| V1 | Can staff process a sale without help? | Sales flow | Revenue-blocking |
| V2 | Does the Daily Brief answer "how are we doing?" in <5 seconds? | Dashboard hook loop | Phase 6 wasted |
| V3 | Can an owner act on low-stock info (find → decide → reorder path)? | Products + PO | Stockouts |
| V4 | Is anything unusable by keyboard-only or low-vision users? | Phases 3–4 | Excludes users |
| V5 | Do charts communicate trend vs yesterday? | Reports | Misread data |

## Day-by-day

**Mon — Prep (2h)**
- Recruit 3–5 participants: 1 owner, 1 manager, 1–2 cashiers. Offer a coffee voucher, not equity 😄
- Stage demo data: ≥2 weeks of orders (varied totals), 3 products below threshold, 1 supplier with items
- Print the task sheet below; prepare laptop **and** a phone (mobile nav was built for touch)

**Tue–Wed — Sessions (30 min each)**
Moderated, think-aloud. One person runs the session, one takes notes (severity 0–4 per observation).
Do NOT explain features before tasks — watch them find things.

| Task | Measures | Success |
|------|----------|---------|
| "Sell 2 burgers and a soda to a walk-in, cash." | V1 | Completed ≤90s, no dead ends |
| "You just opened for the day. How's business so far?" | V2 | Mentions today's number unprompted within 10s |
| "You're worried you'll run out of something this week. Deal with it." | V3 | Reaches low-stock info; articulates next action |
| "Do your usual morning check — but unplug the mouse." | V4 | Completes any 2 tasks keyboard-only |
| "Was last week better than the week before?" | V5 | Uses chart correctly; reads direction right |

Follow-up questions (same for everyone):
1. What was the most confusing moment? (probe silence >4s)
2. If this were on your home screen, would you open it daily? Why?
3. Anything you'd never touch?

**Thu — Synthesize (1h)**
- Tally observations into the severity scale from `ux-eval-index.md` (0=cosmetic…4=blocker)
- Rule: a finding counts if **2+ participants** hit it (1-off = note, not fix)
- Compute: task success rate, top-3 severities, V2 5-second verdict count

**Fri — Decision gate**
- **Ship** if: V1 ≥ 80% success AND no severity-3+ finding in sales flow
- **Fix-first** list = all severity ≥2 findings with 2+ hits, ordered by (severity × task frequency)
- Anything touching the sale flow jumps the queue — revenue path outranks polish

## Metrics snapshot (fill after Thu)

```
V1 sale success:      __/5   avg time: ____s
V2 brief in <5s:      __/5
V3 stock action:      __/5
V4 keyboard tasks:    __/5 partial OK
V5 chart read:        __/5 correct
Severity 3+:          __ findings
SUS-lite (1-5 each): hard/easy ___ · confusing/clear ___ · skip/would-use ___
```

## After the sprint
- Log fixes as commits referencing `V#` (e.g., `fix(sales): reduce step count, found via V1`)
- Re-test only the failed tasks with 2 fresh users — not the same ones (they've learned the UI)
- Backlog candidate if validated: one-tap reorder from low-stock strip (Phase 6 backlog)
