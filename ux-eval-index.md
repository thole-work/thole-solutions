# UX Heuristic Evaluation — Thole POS (index.html)

**Date**: 2026-08-23 | **Method**: Static code audit (Nielsen 10 + WCAG module + data-viz recon)
**Scope**: index.html (~3055 lines), light + dark themes
**Limitation**: code-level audit, not user testing; chart rendering deferred to live check (Phase 5)

## Score Summary

| # | Heuristic | Verdict |
|---|-----------|---------|
| 1 | Visibility of system status | ✅ Pass — btn-busy states, 35 toast() calls, POS session card |
| 2 | Match with real world | ✅ Pass — restaurant terminology throughout |
| 3 | User control & freedom | ✅ Pass — cancel paths, ESC handling, focus restore |
| 4 | Consistency & standards | 🟡 Minor — icon set fixed; type scale still ad-hoc (12–15px mix) |
| 5 | Error prevention | ✅ Pass — danger confirmDialog, inline validation |
| 6 | Recognition over recall | ✅ Pass — persistent labeled nav, mobile More panel |
| 7 | Flexibility & efficiency | 🟡 Opportunity — no keyboard shortcuts for high-volume POS flows |
| 8 | Aesthetic & minimalist | ✅ Pass |
| 9 | Error recovery | ✅ Pass — inline setError() near fields, toast feedback |
| 10 | Help & documentation | 🔵 Gap — no onboarding/help (acceptable for staff tool, note for new hires) |

## Findings (prioritized)

### 🔴 F-1 — Zoom disabled (WCAG 1.4.4 fail) — Severity 3
`index.html:8` → `<meta name="viewport" content="... maximum-scale=1.0, user-scalable=no" />`
Low-vision users cannot pinch-zoom the entire app. One-line fix, zero risk.
**Fix**: `content="width=device-width, initial-scale=1.0"`

### 🟠 F-2 — `--ink-faint` fails AA contrast (WCAG 1.4.3) — Severity 2
Light theme `#8B8FA8` on white card = **3.19:1** (needs 4.5:1). Used for empty states,
12px form labels, meta text — exactly the small text most affected.
(Dark theme equivalent passes at 8.21:1 — only light theme broken.)
**Fix**: darken to ~`#676C87` (≈4.6:1) in `:root`; keep dark value as-is.

### 🟠 F-3 — Primary navigation invisible to keyboards/AT (WCAG 2.1.1, 4.1.2) — Severity 2
Sidebar nav items are `<div onclick>` — not focusable, no `role="button"`, no Enter/Space
handling. Keyboard-only or switch-device users cannot change tabs at all.
Only 8 aria-* / 1 role / 0 tabindex in entire file.
**Fix**: convert nav items to `<button>` (or add role+tabindex+keydown), same styling.

### 🟡 F-4 — No focus trap inside open modals/dialogs (WCAG 2.4.3) — Severity 2
Dialog system (lines 1120–1250) has ESC, Enter, initial focus, and focus restore —
but Tab cycles into background content behind the overlay.
**Fix**: keydown Tab handler cycling first↔last focusable while modal open.

### 🔵 F-5 — Ad-hoc typography/spacing values — Severity 1
Font sizes 11/12/13/14/15px and arbitrary paddings scattered; no scale. Not a
usability failure today, but every future component inherits the drift. → Phase 2.

### 🔵 F-6 — No keyboard accelerators for core POS loop — Severity 1
High-frequency flows (sale → pay → next) are mouse/touch-only. Fitts-friendly
shortcuts (e.g., F2 = new sale) would compound daily. → backlog.

## What Already Works (keep & replicate)

- Native `alert/prompt/confirm` count: **0** — full custom dialog system with danger variant
- Contrast elsewhere: ink 17.7:1, white-on-accent 12.7:1, dark theme all ≥8:1
- Loading feedback: busy-button locking + toasts everywhere
- Empty states written as next actions ("No tables yet — add your first one.")
- Focus restoration after modal close (index.html:1247)

## Action Order

| Priority | Finding | Effort |
|----------|---------|--------|
| P0 now | F-1 viewport, F-2 ink-faint token | ~15 min total |
| P1 next | F-3 keyboard nav, F-4 focus trap | half-day |
| P2 | F-5 tokens (Phase 2 of plan) | 1–2 days |
| P3 | F-6 shortcuts, F-7 charts (Phase 5) | scheduled |
