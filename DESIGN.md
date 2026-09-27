# UI/UX ARCHITECTURE & DESIGN DIRECTIVES

## Persona & Standard
Act as a Principal UI/UX Designer at Apple. Every component, interface layout, and interaction must adhere strictly to Apple Human Interface Guidelines (HIG). Eliminate "AI aesthetic slop": no rounded floating container-in-container layouts, no decorative glows (the 3D graph's meaning-carrying hub and Outcome glows are the one exception, see "Glow exception"), no backdrop blur, and no fluff text.

Aether has two visual systems that share one structure:

| Surface | System | Feel |
| --- | --- | --- |
| Share sheet (`src/share-page.js`) | Minimal greyscale | Quiet, fast, content only |
| Main portal (`src/index.js`) | Teal accent hybrid | Navy and teal, alive but precise |

New screens use the main portal system unless they are a quick-capture flow like the share sheet.

## Core Design Principles
1. DEFERENCE: The UI recedes into the background so the user's content and data take full focus. Chrome and controls must feel weightless.
2. CLARITY: High legibility, crisp typography scale, strict semantic hierarchy, and purposeful white space.
3. DEPTH: Show hierarchy with surface colour and hairline borders, not blur or glow. A layer sits above another only when it is functionally on top (a menu over an input, a card being dragged).

## Shared Structure (both systems)
- Typography: System fonts (-apple-system, BlinkMacSystemFont, SF Pro Display, SF Pro Text). Text inputs use at least 16px (17px preferred) so iOS does not zoom on focus.
- Spacing: Strict 8pt grid with 4pt subdivisions. Compact padding, never chunky.
- Corners: Never above 8px. `6px` for controls, chips and inner surfaces; `8px` for panels, sheets and primary buttons; `4px` for small tags, badges and segments inside a segmented control. Only data markers stay round: category dots, timeline dots and drag handles.
- Borders: 1px hairlines, `rgba(255, 255, 255, 0.08)`.
- No `backdrop-filter` blur anywhere. Floating panels are solid.
- No glows (coloured `box-shadow` halos) and no large decorative drop shadows. A small shadow is allowed only for real stacking: a card being dragged, or cards stacked in the carousel. **One exception:** the main portal's 3D graph glows its hub cards and AI Outcome Nodes (see System 2, "Glow exception").
- Interactive Targets: Minimum 44x44pt hit area for every clickable or touchable element. When the visible control should be smaller (a 32px chip), keep the 44pt element and draw the visible shape with a `::before` inset, instead of shrinking the hit area.
- Horizontal rows (chip ribbons, segmented bars): scroll sideways, hide the scrollbar (`scrollbar-width: none` plus `::-webkit-scrollbar { display: none }`), and use `scroll-behavior: smooth`.

## System 1: Share Sheet (minimal greyscale)
No accent colour. The primary action is the one white element; everything else is grey surface with white-opacity text.

| Token | Value | Use |
| --- | --- | --- |
| `--bg-page` | `#08090A` | Page behind the sheet |
| `--bg-base` | `#0E0F11` | Base sheet |
| `--bg-surface` | `#1A1C1E` | Chips, link card, menus |
| `--hairline` | `1px solid rgba(255, 255, 255, 0.08)` | Every border |
| `--hairline-strong` | `rgba(255, 255, 255, 0.24)` | Border of a selected chip |
| `--text-primary` | `rgba(255, 255, 255, 0.9)` | Primary text |
| `--text-secondary` | `rgba(255, 255, 255, 0.5)` | URLs, chips, captions |
| `--text-tertiary` | `rgba(255, 255, 255, 0.3)` | Placeholders only |
| `--danger` | `#E5484D` | Error messages only |
| `--radius-s` / `--radius-m` | `6px` / `8px` | See Corners |

- Primary action: background `#FFFFFF`, text `#000000`, 8px radius, 44px tall.
- Selected chip: `--text-primary` text and a `--hairline-strong` border. Muted chip text turns white while pressed.
- Text areas sit directly on the sheet: no border, no background, no padding box. The caret is white.
- Focus rings: `1px solid rgba(255, 255, 255, 0.5)`.

## System 2: Main Portal (teal accent hybrid)
The portal keeps its navy surfaces and teal accent so it feels alive, with the shared structure above.

| Token | Value | Use |
| --- | --- | --- |
| `--bg-page` | `#080c14` | Page and 3D graph background |
| `--bg-panel` | `#0b1320` | Top bar, cards, node card, drawers, menus, modals |
| `--bg-raised` | `rgba(255,255,255,0.04)` | Buttons, inputs and rows on a panel |
| `--hairline` | `1px solid rgba(255,255,255,0.08)` | Default border |
| `--text` | `#dffdf7` | Body text on navy |
| `--text-muted` | `#8a93a6` | Dates, counts, captions, placeholders |
| `--accent` | `#00ffcc` | The teal accent |
| `--accent-line` | `rgba(0,255,204,0.55)` | Border of a selected control, focused input |
| `--accent-soft` | `rgba(0,255,204,0.14)` | Fill of a selected card or row |
| `--on-accent` | `#041016` | Text on a solid teal button |
| `--active-fill` | `linear-gradient(135deg, rgba(0,255,204,0.3), rgba(79,132,255,0.3))` | Fill of a selected chip or segment |
| `--radius-s` / `--radius-m` | `6px` / `8px` | See Corners |

Where the teal goes, and nowhere else:
- Brand: the "Aether Portal" title and the sign-in logo.
- Selected states: the active origin, view, time filter and toggle chips use `--active-fill` with an `--accent-line` border and white text. Selected cards, cluster cards and legend rows get a 1px `--accent` border (plus `--accent-soft` fill where the card has no other colour).
- Primary buttons: one solid `--accent` button with `--on-accent` text per panel ("+" add node, "Create Node", "Open Original Source").
- Secondary actions on a card (Ask, Spawn, Reader, web fetch): teal outline buttons with a light teal fill.
- Headings of panels and drawers, "Open" links, and focused inputs (`--accent-line` border).

Ordinary buttons, inputs and chips are navy `--bg-raised` with a hairline, not teal outlines. The `--active-fill` gradient is a flat tinted fill: never animate it, never add a glow to it, and never use it on large areas.

### Glow exception (main portal 3D graph only, approved 2026-09-27)

Glow is allowed in exactly two places, both in the 3D graph and both carrying meaning:

- **Hub glow:** cards whose connection weight passes the hub threshold radiate a soft halo in their **category colour**. It is subtle: a radial falloff behind the card, at most 45% opacity, growing with weight. It works alongside hero scaling (up to 1.35×), never replacing it.
- **Outcome glow:** AI-generated Outcome Nodes glow **Outcome Gold `#ffb627`**, stronger than any hub (up to 70% opacity), with a slow 4-second breathing pulse. The pulse is static under reduced motion. Gold alone cannot be unique next to the dev_task yellow in the category palette, so outcomes are also marked by an OUTCOME badge and a gold card border.

Still banned everywhere else: glows on DOM elements (buttons, panels, chips, focus rings), teal glows (teal remains the flat selection accent), glow on dimmed cards (it fades with them), and bloom or post-processing passes. The halo is a single additive sprite per card, not a screen effect.

Data colours stay as they are and are not accents: category colours on graph nodes, category tags, legend dots and board column tops; the yellow Note and red Transcript sections on the node card; the Google sign-in button stays white in Google's own style.

## Interaction & Micro-Interactions
- Motion: Use critically damped easing with no overshoot, `cubic-bezier(0.25, 1, 0.5, 1)` over 300ms.
- State: Interactive elements must respond instantly on pointer-down/touch-start, not pointer-up/release. Actions that could fire during a swipe (chips in a scrolling row) run on click, but their pressed state still shows on touch-down.
- Feedback: Micro-interactions must feel mechanical and precise: `scale(0.98)` on press, settling back with the easing above.
- Reduced motion: Under `prefers-reduced-motion: reduce`, drop transitions, the press scale and smooth scrolling.

## Output Code Constraints
- Write plain, token-driven CSS: define the system's tokens on `:root` and style components through them, not hard-coded colours.
- Do NOT generate decorative card containers around basic lists or simple forms, and never nest surfaces inside surfaces.
- Keep DOM trees shallow and performant.
