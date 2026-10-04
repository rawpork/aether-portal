# Aether Design System (Figma Operations & Elarion Bridge Edition)

## 1. Reference Screenshots
- Visual layout targets are located in ./images/:
  - igma-reference_1.png: Top-level Mission Control overview & workforce cards
  - igma-reference_2.png: Focused agent card view
  - igma-reference_3.png: Task checklist sub-tab view
  - igma-reference_4.png: Terminal output sub-tab view

## 2. Color System & Materials
Mission Control follows the portal's single visual system (DESIGN.md, System 2: the teal accent hybrid) since
2026-10-04, so the 3D viewer, the 2D cards and Mission Control read as one app. The figma references above still set
the layout; their charcoal / violet colours are retired.
- **Left Sidebar Rail:** Navy (#0b1320, #060a11 in dark mode) with muted icons; the active item has a raised fill and a hairline. A ☰ menu tray folds it to icons on desktop (remembered per browser; medium screens start folded) and opens it as a drawer from the left on phones. The star logo is the way back to the portal; there is no separate Portal item.
- **Canvas & Surfaces:** Dark mode uses the portal tokens (#080c14 canvas, #0b1320 panels, 1px rgba(255,255,255,0.08) hairlines, #dffdf7 text). Light mode keeps light panels (#F4F5F7 canvas, white cards) with a deeper teal accent (#00796B) so text on white stays readable.
- **Accent:** teal (#00ffcc dark, #00796B light) only for selection, the primary action and focus; text on it uses --on-accent.
- **Corners & type:** 6px / 8px radiuses, system fonts (-apple-system, SF Pro, Segoe UI). Solid panels: no blur, no glow.
- **Accent Badges:**
  - Running / Active: Soft Green pill (#DCFCE7 text #15803D)
  - Needs Input / Alert: Soft Orange pill (#FFEDD5 text #C2410C)
  - Queued / Waiting: Light Gray pill (#F4F4F5 text #52525B)
  - Tripped / Off: Soft Red pill (#FEE2E2 text #991B1B)

## 3. Workforce Cards & Granular Breakers
- **Individual Agent Cards (e.g., Elarion, Quartz, Atlas):**
  - Card Header: Avatar letter badge, Agent Name, Sub-role, Status Pill, and Quick [Pause/Resume] button.
  - Card Body: Active objective text + Visual progress bar.
  - Card Footer: ETA, Task counts, and an **Individual Safety Breaker Toggle** switch for instant granular control on the card itself.

## 4. Focused Agent View & AEPS/Bridge Sub-Tabs
- Selected Agent detail panel featuring runtime counter, success rate, and active sub-tabs:
  - **Activity:** Real-time event log timeline.
  - **Tasks:** Checklist of active sub-tasks with individual task toggles.
  - **Output:** Clean embedded dark terminal block (gent.output).
  - **Skills Registry:** List of active proprietary SKILL.md playbooks linked from .aether/skills/AEPS/.
  - **Bridge / Webhook Config:** API bridge settings for Elarion CLI execution and state reads/writes.
