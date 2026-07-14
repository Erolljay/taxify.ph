# ECC Playbook — Txform.ph SaaS

Companion to `docs/PLAN-1-SAAS-PH.md`. That plan says **what** to build over
six phases; this maps **which ECC skills, agents, and slash commands** to reach
for at each step, and how to use them on *this* codebase.

Nothing here changes the plan — it's the tooling layer beneath it.

- **Skill** = `skill-name` (invoke via the Skill tool / `/skill-name`)
- **Agent** = **agent-name** (auto-invoked or via the Agent tool)
- **Command** = `/command`

Scope note: the current repo is a static, vanilla-JS Manager.io extension
(no build, no framework, no tests). Phase 1 introduces the first real backend
(entitlement API + SQLite) and browser automation — that's the point where the
"skip TDD / skip backend tooling" posture from the initial repo survey flips.

---

## Cross-cutting (every phase)

| Need | Use | How on this project |
|------|-----|---------------------|
| Review before each PR | `/code-review`, **typescript-reviewer** (JS), **php-reviewer** (server) | Run on the working diff before opening the PR — fits the existing PR→merge→deploy flow. |
| Keep tracking docs current | `/update-docs`, **doc-updater** | Sync `instruction.md / progress.md / to-do.md` from source changes instead of hand-editing. |
| Security as a gate, not an afterthought | `/security-review`, **security-reviewer** | **Gate Phases 1 and 3**, not just Phase 0 — the attack surface ~5×'s (tenancy, magic-link auth, webhooks, restricted-user sync). |
| Context-switch across clients/phases | `/save-session` | Save state when jumping between Txform work and client books. |
| Design before building anything irreversible | `/plan`, `/plan-prd`, **architect** / **code-architect** | Use before tenancy (Phase 1) and payments (Phase 3). |
| Redesign a tax type's filing workflow | **Filing-workflow UX conventions** (below) + `/plan` for the step list, mockup for sign-off, `/code-review` before the PR | Copy the VAT pattern to every tax type so they stay consistent. |

---

## Filing-workflow UX conventions (apply to every tax type)

House style for the filing workflows (step engine: [`app/workflows.js`](../app/workflows.js) +
[`app/step-engine.js`](../app/step-engine.js)). Established with **VAT** (PR #32); replicate for
EWT, compensation, and income tax. Full spec — including the engine guardrails — lives in
[`instruction.md`](instruction.md#filing-workflow-ux-conventions-apply-to-every-tax-type); the
short version:

- **Top arrow-flow stepper** (not a left rail); each step gets a `short:` chip label.
- **Merge** passive review + download of one report into a single **`document` step** (with an
  inline **blocking** party-TIN banner + a fix link into the report's own tab). **Separate** any
  tab that *changes the numbers* into its own step, placed first (distinct `iframeId`s — the
  engine keeps an iframe in its creating step; a shared id blanks the second).
- **First step** = `info: true` instruction (Tax Audit reminder), no gate. **Optional** attachments
  (e.g. SAWT) → `optional: true` + `skippable`. **Terminal** step = `file` (freeze), with the
  working-paper download folded in via `bundle:`.
- **Payment** step = compound journal-entry voucher (header band + DR/CR ledger + balanced badge)
  with an **editable Description** (default `"<TAX> - <period>"`) feeding the payment description /
  journal narration. Presentation only — don't touch the recalc/post logic.
- **DAT downloads:** SLSP-family listings (SLS/SLP/SAWT/QAP) file **per month**, so a quarter
  downloads **one DAT per month (3 files)**.
- **Process:** approve the redesign via a **mockup first** (the user is non-technical — show, don't
  describe), then implement; `npm test` + `node --check`, then eyeball in live Manager (no local dev
  server). Run `/code-review` on the diff before the PR.

**Per-tax-type caveat:** VAT is quarterly-only (2550M retired 2023), so its period is fixed. **EWT
keeps both monthly (0619-E) and quarterly (1601-EQ)** — don't strip the monthly option there.

---

## Phase 0 · Foundation hardening (Weeks 1–4)

**Goal:** auto-deploy, backups, license clarity, e2e-verified install.

| Task | ECC |
|------|-----|
| Fix GitHub 403 → push-to-deploy Action (kill SSH `git pull`) | `github-ops`, `deployment-patterns` |
| Server hardening (UFW, fail2ban, UptimeRobot, EBS/S3 backups) | `terminal-ops`, `deployment-patterns` |
| Verify every report end-to-end on a real business | **e2e-runner**, `e2e-testing` |
| Audit the server surface before hardening | `/security-review`, **security-reviewer** |
| Sequence the phase | `/plan` |

**Carry-over from the repo survey:** `save-tax-rates.php` trusts anything that
reaches it and relies entirely on the nginx basic-auth block being present in
prod. Fold that into the Phase-0 security pass — it's the existing highest-risk
line and it doesn't go away when you add tenancy.

**Exit:** one merged change auto-deploys; a month of firm books processed clean.

---

## Phase 1 · Productize — tenancy + entitlement + provisioning (Weeks 3–10)

> **Deep dive** — this is where the project stops being a static extension and
> becomes a backend system, and where a wrong call is expensive to undo.

### 1a. Design the tenancy/entitlement model first

Before writing code, run `/plan-prd` then `/plan` (or the **code-architect**
agent) against the plan's account model:

```
ACCOUNT (firm, pays once)
  └─ USERS (owner | staff)
       └─ user_business   ← source of truth for access
            └─ BUSINESSES (Manager business GUIDs)
```

Decisions to lock in the plan, not in code review:
- **What runs the entitlement service?** You already ship PHP (`save-tax-rates.php`)
  and nginx. Reusing PHP = no new runtime; Node/Python = better testing/async
  story for webhooks + the provisioner queue. Pick once — this is the fork that
  everything else inherits. *(Recommend deciding via `/plan`, not by drift.)*
- **Isolation guarantee** between tenants (the "one business per client, one
  restricted user" boundary) — this is the security invariant of the whole SaaS.

ECC: `backend-patterns`, `api-design`, **architect** / **code-architect**.

### 1b. Entitlement API + subscriber SQLite

| Task | ECC |
|------|-----|
| Schema for `account / users / user_business / businesses` | `database-migrations`; **database-reviewer** on the schema (it's Postgres-flavored but schema-design review transfers to SQLite) |
| `/api/entitlement?business=…` endpoint + 24h cache / 72h fail-open | `api-design`, `backend-patterns`, `error-handling` |
| **Tests first** for the entitlement logic | `tdd-workflow` + the language's `*-testing` skill (`php-testing` / `python-testing` / `nodejs`) |

> This is the reversal of the initial survey's "skip TDD." The entitlement
> logic is exactly the code where a bug either lets a non-payer in or locks a
> paying firm out *during a BIR deadline*. It earns tests before implementation.

### 1c. Playwright provisioner — the fragile heart

Headless Chromium logging into `books.txform.ph` to create/revoke Manager
restricted users. It's UI automation against software you don't control — a
Manager UI update can break provisioning **silently**.

| Concern | ECC |
|---------|-----|
| Build + harden the automation | **e2e-runner**, `e2e-testing` |
| Make failure loud, not silent | `verification-loop`, screenshot-diff every run |
| Queue/retry semantics (systemd timer) | `backend-patterns`, `error-handling` |

Treat this as a tested, monitored component — not a script. It's the plan's
single biggest operational risk.

**Exit:** a signup can be provisioned and locked out without a human touching
Manager — and that path is covered by tests + screenshots.

---

## Phase 2 · Website rebuild & SEO (Weeks 5–12)

**Replace the 563 KB self-unpacking JS bundle** (a crawler sees only "requires
JavaScript") with static multi-page HTML.

| Task | ECC |
|------|-----|
| SEO architecture: sitemap, robots, JSON-LD, canonicals, Search Console | `seo` skill, **seo-specialist** agent |
| Static page rebuild (home/features/pricing/for-accountants/guides/legal) | `frontend-patterns`, `frontend-design-direction` |
| CWV "green by construction" | Web `performance.md` checklist, **performance-optimizer** |
| Accessibility on the new pages | **a11y-architect** |
| Weekly BIR guide engine ("file 2551Q in 2026", deadlines calendar) | `content-engine`, `brand-voice`, `seo` |

**Exit:** all pages indexed; first organic impressions in Search Console.

---

## Phase 3 · Payments — PayMongo subscriptions (Weeks 8–14)

| Task | ECC |
|------|-----|
| PayMongo integration (checkout, Subscriptions API, GCash payment-link fallback) | `api-connector-builder`, `backend-patterns` |
| Webhook → entitlement DB → provisioner → welcome email | `api-design`, `error-handling` |
| **Security gate** | `/security-review`, **security-reviewer** |

Security-reviewer focus for this phase — the money-meets-access seam:
- Webhook **signature verification** + replay protection
- The entitlement-**write** path (a forged/replayed webhook must not grant access)
- Re-examine the *"fails open 72h"* cache: deliberate availability-over-enforcement
  tradeoff — confirm it's not an abuse vector (cancel + keep using for 3 days).

**Exit:** a stranger pays ₱699 and is using the product 10 minutes later.

---

## Phase 4 · ToS + Data Privacy, RA 10173 (Weeks 8–14, parallel)

**ECC has no Philippine-DPA skill.** Closest structural analogues:
`hipaa-compliance` / `healthcare-phi-compliance` — transferable for the *shape*
of a compliance program (DPO, processor/controller split, breach runbook), **not
jurisdiction-correct**. Do not treat them as legal authority.

| Task | ECC |
|------|-----|
| Draft ToS / Privacy documents | `anthropic-skills:docx`, `hipaa-compliance` (structure only) |
| Research NPC registration / DPO obligations | `deep-research`, `research-ops` |
| **Build a reusable PH-DPA skill** | `/skill-create` — you'll reuse "PH data-privacy compliance" across every client, not just Txform |

Lawyer pass (~₱15–30k) still required before first paid signup — tooling drafts,
it doesn't sign off.

**Exit:** `/terms` and `/privacy` live, checkbox-accepted, NPC filing in.

---

## Phase 5 · Beta → launch → growth (Weeks 14–24)

| Task | ECC |
|------|-----|
| Launch campaign (FB groups, PICPA, shorts) | `marketing-campaign` skill, **marketing-agent** |
| Compounding content / guides | `content-engine`, `seo`, `brand-voice` |
| Testimonials, growth loops | **marketing-agent** |

**Exit:** first 10 paying tenants; SEO guides compounding.

---

## Three flags the plan under-weights (tooling would catch)

1. **No named test strategy for the entitlement service or provisioner** — the
   two components where a bug means a non-payer gets in or a paying firm gets
   locked out at a deadline. Highest-value place to *add* TDD (`tdd-workflow`).
2. **The Playwright provisioner is a silent single point of failure** — UI
   automation against third-party software. Needs monitoring + screenshot-diff
   as first-class, not a footnote (**e2e-runner**, `verification-loop`).
3. **Security appears only as a Phase-0 bullet** while the surface ~5×'s across
   Phases 1–3. Make `/security-review` a **gate on Phases 1 and 3**.
