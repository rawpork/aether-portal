# Aether Design System (Figma Operations & Elarion Bridge Edition)

## 1. Reference Screenshots
- Visual layout targets are located in ./images/:
  - igma-reference_1.png: Top-level Mission Control overview & workforce cards
  - igma-reference_2.png: Focused agent card view
  - igma-reference_3.png: Task checklist sub-tab view
  - igma-reference_4.png: Terminal output sub-tab view

## 2. Color System & Materials
- **Left Sidebar Rail:** Dark Charcoal (#18181B) with light gray icons and active highlight background.
- **Canvas Background:** Very light cool gray (#F4F5F7 / #F8FAFC).
- **Surface Cards:** Pure White (#FFFFFF) with soft neutral borders (#E4E4E7) and subtle rounded corners (ounded-2xl / 16px).
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
