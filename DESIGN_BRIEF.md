# DESIGN_BRIEF: Aether Portal / Mission Control (v2)

Authors: Prism (Elena Rostova, UI/UX audit) and Pixel (Julian Croft, motion).
Date: 2026-10-07. Status: pre-handoff. Supersedes v1 of the same day.

## 0. What changed from v1, and why

v1 leaned on `scroll-craft` alone. Reading the app-side skills and the project's own design docs changed the brief in these ways:

| Change | Cause |
|---|---|
| **The project's own `DESIGN.md` and `DESIGN_SYSTEM.md` now govern.** v1 ignored them. | They already set corners, tap targets, easing, press scale, reduced motion, glow rules and the teal accent rules. Several v1 fixes contradicted them. |
| **64px rail: "Still needed" became "Done in code, not visible in the screenshots."** | `DESIGN_SYSTEM.md` and `src/mission-control-page.js:1150` fold the sidebar to icons through the menu button. The screenshots only show the expanded 248px default. |
| **"Stop all agents": "Still needed" became "Partly done."** | The `TRIP BREAKER` chip is the master circuit breaker (`src/mission-control-page.js:1272`, `public/js/engine/breaker-bar.js`). It halts agents and has a reset. The control exists. Its label, grouping and confirmation are the gaps. |
| **M1 changed: do not simply add Space to the sidebar.** | `DESIGN_SYSTEM.md` states the star logo is the way back to the portal and there is deliberately no Portal item. The real problem is that the way back is undiscoverable. Section 5 flags this as an owner decision. |
| **The "44px" claim is now sourced correctly.** | 44x44pt is the project's rule (`DESIGN.md`). WCAG 2.2 AA only requires 24x24 CSS px (SC 2.5.8). Both are cited. |
| **The signature move is rebuilt for this stack and these motion rules.** | The portal is vanilla JS on a Cloudflare Worker, not React. The `motion/react` skills cannot be used as code. Their rules are used as rules. |
| **New: dashboard operator-questions audit, 10-dimension scorecard, WCAG 2.2 findings with criterion numbers, machine-decidable acceptance.** | From `dashboard-builder`, `design-system`, `accessibility` / `frontend-a11y`, `loop-design-check`. |

## 1. Basis, precedence and limits

**Reviewed:** 20 screenshots from `screenshots-designer-export.zip` (10 desktop 1440x900, 10 mobile 375x812). Pages: portal-home (Space), mission-control, create, elarion, operator, projects, roadmap, run-history, settings, studio.

**Sources, in order of precedence when they disagree:**
1. `Aether_Portal/DESIGN.md` and `DESIGN_SYSTEM.md` (the project's own rules).
2. ECC skills: `design-system`, `frontend-design-direction`, `dashboard-builder`, `accessibility` (WCAG 2.2 AA), `frontend-a11y`.
3. ECC skills: `motion-foundations`, `motion-patterns`, `motion-advanced`, used as rules only.
4. `scroll-craft` (grammar logic, type and spacing floor, motion floor). Its cinematic devices are not used.
5. `loop-design-check`, applied to how this brief gets verified (section 7), not to the UI.

**Stack finding.** `package.json` has no React, Next or Vue. The UI is vanilla JS and CSS served by a Worker (`src/mission-control-page.js`, `public/js/engine/*`). So `frontend-patterns`, `frontend-a11y` code samples, `motion-*` code samples and `ui-to-vue` are not applicable as code. Their rules carry over.

**Limits you should know about:**
- Static screenshots of one idle state. Hover, focus, the folded rail, the breaker popover and all motion were not seen. Nothing here claims they work.
- The earlier review document is not in the repo. The status matrix is built from the handoff recap plus the screenshots plus the code facts above.
- I did not read `specs/ui/*.md` (the roadmap links them, a glob found none). Check them before changing the Workflow Canvas, team cards or budget inspector.
- Scores and contrast values are estimates from images, not measurements. Section 7 turns them into machine checks.

**Conflicts between the skills, and the call made:**

| Topic | Skills disagree | Decision |
|---|---|---|
| Accent colour | scroll-craft: one accent. frontend-design-direction: avoid a one-hue UI. | Keep the project rule: teal only for selection, primary action and focus. Status and data colours are separate and allowed. |
| Easing | scroll-craft `(0.23,1,0.32,1)`. motion-foundations `smooth (0.22,1,0.36,1)`. Project `(0.25,1,0.5,1)`. | Project: `cubic-bezier(0.25, 1, 0.5, 1)`, no overshoot. This also bans the `bouncy` spring and `pop` scale 1.04. |
| Press scale | scroll-craft 0.97. motion-foundations 0.95. Project 0.98. | Project: `scale(0.98)`. |
| UI duration | scroll-craft: under 300ms. Project: 300ms. motion tokens: fast 180, normal 350. | Use tiers instant 80 / fast 180 / normal 300 ms. Nothing in the app is slower than normal except the one-off dock. |
| Stagger | scroll-craft 30 to 80ms. motion-patterns 50 to 100ms. | 50 to 80ms. |
| Reduced motion | scroll-craft: fewer and gentler. motion-foundations: opacity fade at most 200ms. Project: drop transitions, press scale and smooth scroll. | Project wins, the strictest: state changes happen instantly, no transitions. |
| Counters | motion-advanced animates 0 to N. scroll-craft: real numbers only. | Live telemetry is never animated from 0 on load. A value that changes may tween over `fast`. |
| Custom cursor | motion-advanced ships a cursor follower. scroll-craft and project bans. | Banned. |

## 2. Design direction and page grammar

### 2.1 Direction (frontend-design-direction)

| Question | Answer |
|---|---|
| Purpose | Supervise a small fleet of AI agents and stop it safely. |
| Audience | One owner-operator who checks several times a day. First scan: is anything running, does anything need me, is it safe. |
| Tone | Utilitarian, dense, quiet, scannable. Not editorial, not cinematic. |
| Memorable detail | The status stays with you: the KPI dock (section 3). |
| Constraints | Vanilla JS, `DESIGN.md` tokens, 8pt grid, corners at most 8px, 44pt targets, no blur, no glow outside the three approved exceptions. |

The skill's rule applies directly: do not force a landing-page composition onto a tool. The first screen must be the working surface. Do not describe features inside the UI when the controls can speak for themselves. That is the case for trimming the "Do this next" banner and the helper paragraphs under each form.

### 2.2 Page grammar: Live surface (scroll-craft uniqueness.md 2.3)

Unchanged from v1, and now backed by `frontend-design-direction`.

**Why it wins.** The product is the demo. The grammar's fit is "watch what it does".

**Why the other seven lose.**

| Grammar | Why not |
|---|---|
| Filmic one-shot | Needs a marketing bar, scrub hero and magnetic CTA. Wrong for a tool. |
| Chaptered editorial | Printed-page pacing. An operator checks state in seconds. |
| Continuous world | Worldflight only. Space is a world but it is one page, not the shell. |
| Typographic poster | Type as imagery. This is data. |
| Gallery / catalog | Fits Create (templates) only. |
| Split stage | No two-sided argument. |
| Rhythmic cutlist | Energy brand. This is a trust surface. |

**What it requires here:** app chrome is the nav; the hero is the surface already in a state; copy lives in labels and empty states; the close is a real input (the composer). Banned devices: `scrub`, `kinetic`, `spotlight`, `magnet`, full-bleed media.

**Honesty rule.** Panels compute from real or clearly labelled sample data. Space shows "marketing sample 3: a readable card title / Local test card 3". Label it "Demo data" or do not ship it.

**Space is a sub-surface of the same grammar**, rendered inside the shell, not a second app.

## 3. Signature scroll move: the KPI dock (rebuilt)

**Sentence for someone who has seen other dashboards:** "Scroll, and the project's headline numbers fly up and land in the status pill, so you never lose the fleet's state."

**Why it earns its place** (dashboard-builder lens): it answers "is it healthy" at all scroll positions and frees the fold for the agents. It also folds the scattered header chips into one place.

**Behaviour (Mission Control only):**
1. At scroll 0 the Project Overview strip is full size.
2. Over 0 to 160px of scroll the strip scales from 1.0 to about 0.62 and translates up while its values crossfade into a one-line summary: `100% done · 0 of 2 working · 1 of 1 tasks`.
3. The summary docks in the header status pill and stays there.
4. Pill click opens the popover (breaker, per-agent state, last-sync age).
5. Scrolling up reverses it exactly, same data, no second source of truth.

**Build spec (vanilla, not React):**
- Primary: CSS scroll-driven animation, `animation-timeline: scroll(root block)` with `animation-range: 0 160px`.
- Fallback: one `IntersectionObserver` sentinel writing `--dock` (0 to 1) on the strip, with styles reading `calc()` from it.
- Animate `transform` and `opacity` only. Never width, height, top, left, margin, padding. (Project, scroll-craft and motion-foundations rule 4 all agree.)
- Easing `cubic-bezier(0.25, 1, 0.5, 1)`. No overshoot. Value stagger 50 to 80ms, within the 4 values.
- **Reduced motion: no animation.** Below the 160px threshold the strip shows, above it the pill summary shows, swapped instantly. This follows the project rule, not the softer skill rule.
- Mobile: the same, with the dock target in the 56px top bar (see M7). Touch targets stay at or above 44pt throughout.
- Pause rule from motion-advanced: any looping animation (the HALTED pulse, a live dot) pauses on `document.visibilityState === "hidden"`.
- The summary must be announced: the pill is `role="status"`, `aria-live="polite"` for normal changes and `assertive` only for Halted.

**Verify at** scroll 0, 80, 160 and 400px on desktop, 375px mobile and reduced-motion, then on a real phone.

**Do not add:** scroll hijacking, parallax, scroll-reveal on app pages, counters that animate from 0, or motion on pages other than Mission Control. If a reveal is wanted elsewhere, `whileInView`-style, play once only.

## 4. Status matrix: previous handoff recommendations

| # | Recommendation | Status | Evidence | What remains |
|---|---|---|---|---|
| 1 | Merge the "2-app feel" into one shell | **Partly done** | Eight Mission Control pages share one shell. `DESIGN_SYSTEM.md` says Mission Control adopted the portal system on 2026-10-04. Space still opens as a different-looking app: dark canvas, own top bar, own hamburger, search and wordmark, and the header differs from Mission Control (WCAG 3.2.3 Consistent Navigation). Mission Control defaults to light, Space to dark. | Shared header and composer for Space. Decide the theme default. Make the return path discoverable (M1). |
| 2 | 64px icon rail | **Done in code, not visible in screenshots** | The menu button folds the rail to icons, remembered per browser, medium screens start folded (`DESIGN_SYSTEM.md`, `mission-control-page.js:1150`). All 10 desktop shots show the expanded 248px rail. | Verify the folded width is 64px, that tooltips and `aria-expanded` exist, and capture a folded screenshot for the next export. |
| 3 | Status pill popover with "Stop all agents" | **Partly done** | The master circuit breaker exists (`TRIP BREAKER`, role group, HALTED state, reset). It is labelled in jargon, red at rest, scattered among 4 chips, and mobile shows it as `TRIP` next to unlabeled dots. No popover. A label of "Stop all agents" is absent. | Group status into one pill with a popover that holds the breaker, plain label, confirm step. See M3. |
| 4 | Human-readable names over SCREAMING_SNAKE_CASE | **Partly done** | Nav, agent names, tabs are readable. Still raw: `APPROVED_FOR_EXECUTION`, `bp_ce68fdcc_1791183633914`, `dev_task sample 4`, `ATLAS` and `MASTER-BRAIN` role echoes, `TRIP BREAKER`, `site-launch`, `miserly_free_sandbox`. | See M4. |
| 5 | Preflight checklist | **Partly done** | Settings has a 3-step checklist (Engine reachable, Mission Control authorized, Miserly key verified), all empty circles. It is absent from the landing screen and contradicts the shell: Settings says "The engine has no key yet" while the header says Elarion Ready. | See M2. |
| 6 | Space graph LOD and cards | **Partly done** | LOD collapses distant nodes to labelled clusters and the category panel lists real cards. At 1440 the canvas is nearly empty with a cluster under the top bar. The view ring is clipped. Node labels are grey on near-black. The mobile panel collides with the arrows and ring. | See S3 and S4. |
| 7 | (inferred) Space's own top bar and hamburger | **Superseded** | Replaced by recommendation 1 once Space is inside the shell. This is my inference from the recap, not a quoted finding. | Remove after M1. |

**Good developer decisions to keep:**
- Grouped sidebar with active state, and the fold-to-icons tray.
- A single "do this next" concept (placement is the problem, not the idea).
- Per-agent breaker toggle on each card, plus the master breaker in the header, matching `DESIGN_SYSTEM.md` section 3.
- Readable agent names and the "Waiting for you" empty state ("Nothing is waiting for you. When an agent asks you to choose, the options show here as numbered buttons"). It is the best copy in the product.
- Honest empty states in Studio, Operator and Elarion.
- KPI tiles with a value plus a unit line.
- Run history stat tiles with real zero counts.
- Free Sandbox Mode note in Settings.
- Mono type only for data and code.
- 2x2 KPI grid on mobile.
- Solid panels, no blur or glow, matching the spec.

## 5. Design-system audit (design-system skill, mode 2 and 3)

Scores are estimates from screenshots only (0 to 10). Run the skill for real against the running portal (`/design-system audit --url ... --pages ...`) to replace them.

| # | Dimension | Est. | Main evidence |
|---|---|---|---|
| 1 | Color consistency | 7 | Teal, neutrals, status colours used consistently in Mission Control. Space uses a different theme. |
| 2 | Typography hierarchy | 4 | Same greeting is the H1 on every page. Real page name is an 11px eyebrow. No clear h2 level. |
| 3 | Spacing rhythm | 5 | Even 16 to 24px gaps and identical card chrome everywhere. No tight versus loose contrast. |
| 4 | Component consistency | 6 | Cards identical; pills mix fully rounded and rectangular; Space components differ from the shell. |
| 5 | Responsive behavior | 5 | Mobile header takes about 240px of 812px; composer placeholder truncates; Space panel collides with controls. |
| 6 | Dark mode | 5 | Space dark, Mission Control light. Parity of the toggle not seen. |
| 7 | Animation | not scored | No motion in static captures. The ticking `LIVE` clock is motion with no information. |
| 8 | Accessibility | 4 | 11px labels, unlabeled status dots on mobile, colour-only chips, no visible focus evidence, a fixed composer that can cover focus. |
| 9 | Information density | 5 | Repeated banner on all 8 pages, four overview tiles for one project, large empty areas on Operator, Studio and Elarion. |
| 10 | Polish | 6 | Empty states are well written. Test fixtures, raw ids and raw markdown links are visible. |

**AI-slop check:** no purple gradients, glass, blobs or stock hero. Clean on the main slop list. Two to watch: the teal-to-blue `--active-fill` gradient (flat tinted fill, approved in the spec, keep it flat) and identical-card grids on Create.

**Spec drift against `DESIGN.md`:**
- Corners at most 8px, with only data markers round. Status pills and tag chips ("Idle", "API keys", "Pro Engine") look fully round.
- No nested surfaces. The agent card sits inside the workforce panel inside the page.
- 44pt hit area on every control. Desktop buttons ("Pause", "Refresh", "Show") measure about 30px tall.
- Inputs at least 16px. The desktop composer text looks smaller. Check on iOS.

## 6. Merged and prioritized fixes

Tags show the source: **[P]** project spec, **[DB]** dashboard-builder, **[A]** WCAG 2.2 or a11y skills, **[DS]** design-system, **[M]** motion rules, **[SC]** scroll-craft.

### MUST-FIX (trust, safety, comprehension)

**M1. One shell, and a discoverable way between Space and Mission Control. [P][A 3.2.3]**
Render Space inside the shared header. Keep the project's decision that the star logo returns to the portal, but make it discoverable: tooltip and `aria-label` on the logo, a visible "Space" link in the "Do this next" copy ("Open a card in Space" currently has no link), and a "Mission Control" link inside Space. Owner decision needed: add an explicit Space item to the sidebar, or keep the logo-only rule.

**M2. Preflight drives "Do this next". [DB][P]**
Order: engine reachable, authorized, key verified or "Use Free Sandbox", then "Start a project". Show inline on first run, hide when all pass. Show only on Mission Control. Today it repeats on 8 of 8 pages and says "Start your first project" while Settings says the engine has no key.

**M3. One status pill with a popover that holds the master breaker. [DB][A][P]**
- Pill text: `All idle`, `2 working`, `Needs you`, `Halted`. Colour plus text. Matches the spec's badge colours (running green, needs input orange, queued grey, tripped red).
- Popover: Elarion state, engine sync age ("synced 4s ago", replacing the ticking `LIVE 12:12:34` clock), per-agent state, the safety cutoff explained in words, and the breaker control labelled **Stop all agents**.
- Confirm step with a count ("Stop 2 agents?"), a distinct danger style, and no placement next to `New agent`. Reset is a visible, labelled state after a halt.
- Accessibility: `aria-expanded` and `aria-controls` on the pill, `Escape` closes, focus returns to the pill, status changes in a `role="status"` region (`aria-live="assertive"` for Halted only), colour never the only signal (1.4.1).
- Mobile: replace the unlabeled dots and truncated `TRIP` with the single pill.

**M4. Human names everywhere. [P][DS]**
- `APPROVED_FOR_EXECUTION` becomes "Approved". Ids behind a "Copy id" control. Role echoes (`ATLAS`, `MASTER-BRAIN`) become "Sub-agent" and "Master brain". `dev_task sample 4` fixtures become "Demo data" or are hidden. Jargon tags ("Cloudflare D1", "Miserly Client Key") keep a one-line plain help on hover and focus.

**M5. Page titles and heading order. [A][DS]**
Make the page name the H1. Keep "Good afternoon, Kenneth" on Mission Control only and smaller (it is not the page title). Sequential headings, no skipped levels (frontend-a11y).

**M6. One composer, correctly labelled, never covering focus. [A 2.4.11][A labels][P]**
- Hide the global composer on pages that own an input (Elarion, Studio, Projects).
- The composer input needs a real `<label>` (can be visually hidden). Placeholder-only labelling is an anti-pattern in `frontend-a11y`.
- Focus Not Obscured (WCAG 2.2 SC 2.4.11): **checked in code during M6 and not a defect.** The command bar is a flex row below `.mc-main`, which scrolls inside its own box, so it never overlays content or focused controls. The screenshots made it look cut off only because the page scrolls above the bar. No padding change was needed. (Note: the `accessibility` skill labels 2.4.11 "Focus Appearance". In the standard that name belongs to 2.4.13, AAA. 2.4.11 is Focus Not Obscured, AA.)
- Fix the mobile placeholder truncation ("Ask Elarion, or a").

**M7. Mobile chrome budget. [P][DS]**
Header is about 240 of 812px and the composer another 100px, so working area is under 450px. Collapse to a 56px header: menu button, page title, status pill. Move `New agent` to a sheet or the composer. Two unlabeled nav buttons (menu and back arrow) sit side by side: label them or remove the back arrow where there is no history.

**M8. Answer the operator's four questions on the first screen. [DB]**
The dashboard-builder questions are: is it healthy, where is the bottleneck, what changed, what action should someone take. Current mapping:

| Question | Today | Fix |
|---|---|---|
| Is it healthy? | Four separate chips, a clock | The single pill (M3) |
| Where is the bottleneck? | Not shown. Agents are below the fold. | Put the agent workforce directly under the status area |
| What changed? | Nothing. No last-event line. | One line: "Atlas finished site-launch, 14ms, 2d ago", from the event log that already exists |
| What action? | "Start your first project" static banner | Contextual next action from preflight state, or "Needs you: N" with the choice buttons |

Order: status, agents, overview, then history. The four overview tiles (progress, workers, tasks, ETA) mostly restate each other for a single project. Keep the three that answer a question, drop or merge the rest (dashboard-builder: cut vanity panels). Every panel needs a title, a unit and a meaningful threshold, and the board needs a sensible default refresh with a visible "updated" time.

**M9. Wrong actions and ambiguous completion. [DB][loop-design-check]**
- `Pause` shows on Idle and Waiting agents. Show the action that matches the state (Run, Resume, or none).
- "100%" beside "Idle" reads the same as a healthy running job. Add a distinct completed state.
- The Compute widget shows `0` over a full teal bar with "tokens · 1 / 1 runs done". The number and the bar disagree, so pick one meaning and label the unit.
- Agent-reported success is not verified success. From `loop-design-check`: the loop is the worker, not the acceptance officer. Where a run reports "All 3 steps done", show it as "Completed" and give the owner a Review or Accept action for anything with real-world effect (deploys, spend). Do not mark it verified by itself.

### SHOULD-FIX

**S1. Rail verification and active state. [P][A]** Confirm the folded rail is 64px, has tooltips on hover and focus, `aria-expanded`, and a persisted state. The active item (dark chip on dark rail) must reach 3:1 against the rail (1.4.11).

**S2. Typography floor. [DS][SC]** Labels at 11 to 12px (eyebrows, "ETA / Tasks / API breaker", helper text, tag chips) go to a 12px floor, with 14px body and sentence case instead of wide-tracked caps at 11px. Keep two families. Inputs at least 16px (the project's iOS-zoom rule).

**S3. Space camera and cards. [DB]** Fit to content on load, sort the card list (it reads 3,4,5,6,1,2), make the category panel dismissible with `Escape`, and stop it overlapping controls on mobile.

**S4. Space contrast, ring and drag alternatives. [A]** Node labels grey on near-black, measure and raise to 4.5:1. Replace the clipped, rotated mode ring ("LIST / 3D SPACE / Horizon") with a labelled segmented control. Space says "Left-click: rotate, wheel: zoom, right-click: pan". Dragging needs a single-pointer alternative (WCAG 2.2 SC 2.5.7): the arrow buttons are a start, add keyboard pan and zoom. Back link to Mission Control (M1).

**S5. Spacing rhythm and nesting. [P][DS]** More space above a heading than below it. Group by proximity before adding borders. Remove nested surfaces (agent card inside a panel inside the page), which also breaks the project's "never nest surfaces" rule.

**S6. Create, Projects, Run history, Roadmap. [DS]**
- Create: asymmetric first row (one featured, two supporting). Group the tag chips into one plain line.
- Projects: lead with the project list. Collapse "Blueprint ingestion" (a 270px raw JSON field) under a Pro section.
- Run history: four identical project names that differ only by id. Add time, status and a distinguishing field.
- Roadmap: renders `([spec 01](specs/...))` as literal text. Render links or strip them. It is a developer document in an end-user product, so put it behind a dev flag.

**S7. Targets and spec drift. [P][A 2.5.8]** Desktop controls at 44pt hit area (draw a smaller visible shape with `::before`). Fully round pills to the 4px tag radius. WCAG minimum for reference is 24x24 CSS px.

**S8. Reflow, labels and non-text. [A]**
- 400% zoom: the fixed 248px rail and the wide header must reflow (1.4.10).
- Icon-only buttons need an `aria-label` (menu, back, refresh, mic, close, the Space ring). Decorative icons get `aria-hidden`.
- Form labels tied with `for` and `id`, errors linked with `aria-describedby`. The Settings red message needs a text suggestion, which it has.
- No `div` buttons. Check Space ring and Studio legend items.
- Modals and drawers: focus moves in, is contained, `Escape` closes, focus returns.
- Status legend colours (Studio: Start, MCP Read, A2A, Action) already pair with line style in the spec. Confirm the UI does.

**S9. Em dashes in visible copy. [SC]** "Est. completion: —" becomes "Not running". Check Roadmap separators.

**S10. States and motion discipline. [P][M]** Every control gets hover, `:focus-visible` (accent ring with offset), `active` (`scale(0.98)`), disabled. `transform` and `opacity` only, never `transition: all`. Hover effects gated to `(hover: hover) and (pointer: fine)`. Infinite animations pause when the tab is hidden. Reduced motion drops transitions entirely.

### NICE-TO-HAVE

- **N1. Theme parity.** Honour the OS setting and make the sidebar "Dark mode" switch both Mission Control and Space.
- **N2. Depth.** Three elevation steps at most, offset-and-blur shadows only for real stacking (per `DESIGN.md`).
- **N3. Studio empty canvas.** A ghost example workflow so the empty state teaches. Keep the legend text-labelled.
- **N4. Unread badge** on Mission Control ("2") has no meaning. Label or remove.
- **N5. Browser surfaces.** Selection and caret colour, scrollbar, `font-variant-numeric: tabular-nums` on every counting number so tiles do not jitter.
- **N6. Skeletons.** If any panel loads asynchronously, use a skeleton that stops when the tab is hidden, not a spinner.

## 7. Acceptance, written so a machine can judge it (loop-design-check)

The v1 checklist said things like "squint test" and "reads well". `loop-design-check` is clear that "looks right" cannot be a judge. A fix is done when these checks pass, run by something other than the author of the fix.

**Roles.** Plan (this brief) sets the checks. Build implements and **may not edit the checks to make them pass**. Judge runs them independently: the `design-audit` skill (Playwright capture) plus an axe-core run. The owner flips the final "done". Three failed attempts on one item escalate to the owner.

**Done criteria (each decidable with one command):**

| ID | Check | Pass when |
|---|---|---|
| A1 | No raw machine names | No visible text node matches `^[A-Z][A-Z0-9_]{5,}$` or `^bp_[a-z0-9_]+$` on the 10 captured pages |
| A2 | Page title | Each page has one `<h1>` whose text equals the page name, headings do not skip levels |
| A3 | Banner scope | "Do this next" renders only on Mission Control, and only when preflight is incomplete or a next action exists |
| A4 | Single composer | At most one text input labelled for Elarion per page |
| A5 | Labels | Zero axe violations for `label`, `button-name`, `aria-*`, `heading-order`, `color-contrast` |
| A6 | Contrast | Body text 4.5:1, large text and control boundaries 3:1, measured on the render including Space labels and the active nav item |
| A7 | Target size | Every interactive element has a hit area of at least 44x44 CSS px in the shell (project rule), never below 24x24 |
| A8 | Focus not obscured | Tabbing through each page never leaves the focused element fully under the command bar or sticky header (true by layout today; keep it true) |
| A9 | Status pill | The pill has text (not only colour), `role="status"`, popover opens on click and `Enter`, closes on `Escape`, focus returns, the master breaker is inside it with a confirm step |
| A10 | Reduced motion | With `prefers-reduced-motion: reduce`, computed `transition-duration` and `animation-duration` on app chrome are `0s` and the dock swaps instantly |
| A11 | Motion properties | Animated properties in the dock and chrome are only `transform` and `opacity`, no `transition: all` |
| A12 | Dock states | Screenshots at scroll 0, 80, 160 and 400px exist for desktop, 375px and reduced motion and match the described end states |
| A13 | Mobile budget | At 375x812 the header plus composer take no more than 160px, and `New agent` is reachable |
| A14 | Fixtures | No node or card title contains "sample" or "readable card title" in any non-demo view |

**Boundary (what must not happen to get a green run):**
- No test or check deleted, loosened or skipped.
- No hiding of elements to dodge contrast or label checks.
- The master breaker is not removed, hidden or made slower to reach.
- No drop in the existing test suite (`npm test`).

**Two human gates stay human:**
1. Reviewing the folded rail, the breaker confirm flow and the dock on a **real phone** (headless Chrome cannot reproduce touch scrolling or the phone's decoder behaviour).
2. Final acceptance. The loop (or builder) is the worker, not the acceptance officer. Also because stopping every agent is the one control whose failure you cannot afford.

## 8. Skills used and not used

**Used:** `design-system` (audit dimensions, slop check, spec drift), `frontend-design-direction`, `dashboard-builder`, `accessibility` and `frontend-a11y` (WCAG 2.2 criteria, label, focus, ARIA, reduced motion), `motion-foundations`, `motion-patterns`, `motion-advanced` (rules), `loop-design-check` (acceptance), `scroll-craft` (grammar and floors only).

**Not applicable:** `frontend-patterns` (React/Next), `ui-to-vue`, `nuxt4-patterns`, `swiftui-patterns`, `liquid-glass-design` (glass is banned here), `frontend-slides`, `ui-demo`, `remotion-video-creation`, `tasteforge-video`. `taste`, `taste-application`, `taste-distillation`, `brand-discovery` and `brand-voice` were not read in this pass. They are the next candidates for the naming and voice problems in M4.

## 9. Order of work

1. M3, M4, M5, M6, M9: small, high trust payoff, mostly copy and state.
2. M2, M8 and M1 (after the owner decision on the sidebar): preflight, first-screen answers, shell.
3. M7 with the KPI dock (layout and the single signature motion together).
4. Should-fix S1 to S10.
5. Nice-to-have.
6. Run the section 7 checks, then the real-phone review, then owner acceptance.
