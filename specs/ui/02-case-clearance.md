# 02 · Case Clearance Spacing (edge wheels and touch safe areas)

Status: **spec, not built** · Applies to: every Aether surface (main portal, Mission Control, share sheet) ·
Roadmap: Phase 4, Step 4.2

Phone cases put a raised lip around the screen, and modern phones have rounded display corners. A control that
hugs an edge or corner, like the thumb wheel pivoting on the bottom-right corner (`public/js/spatial/thumb-wheel.js`,
`#thumb-wheel { right: 0; bottom: 0 }`), puts part of its hit area under the lip, where a thumb can't press it. Case
Clearance standardises one offset for every edge-anchored control.

## 1. Tokens

Add these to `:root` in both style systems (`src/index.js` and `src/mission-control-page.js`):

```css
--case-clear: 24px;      /* "1/4 inch": corners and edge wheels */
--case-clear-min: 20px;  /* straight edges, tight phone layouts */
```

**What "1/4 inch" means here:** CSS defines 1in as 96px, so 24px is a nominal quarter inch. On an iPhone, a CSS px
is about one point (roughly 160 per physical inch), so 24px is physically about 0.15in. The **px values are the
spec**. The inch figure is a name, not a physical measurement.

## 2. Rules

1. **Diagonal corner offset.** A control anchored to a corner moves inward by the same amount on both axes: a
   45° diagonal offset. On iPhone, `env(safe-area-inset-*)` already clears the home indicator, the notch and the
   Dynamic Island, so the offset is the larger of the two values per axis, not their sum:

   ```css
   right:  max(var(--case-clear), env(safe-area-inset-right, 0px));
   bottom: max(var(--case-clear), env(safe-area-inset-bottom, 0px));
   ```

   Both axes always use `--case-clear` (24px), never `--case-clear-min`, so the offset stays diagonal.

2. **Edge wheels.** Radial controls that pivot on a corner move their **pivot** diagonally inward by `--case-clear`
   on both axes, so the pivot sits 24px up and 24px in from the physical corner. The wheel only draws the quarter
   up and left of its pivot (angles π to 1.5π in `thumb-wheel.js`), so the whole wheel then clears the band,
   including the + Add hub, which sits on the pivot. The arc geometry and `MARK` angle don't change. Only the
   mount's `right`/`bottom` do, per rule 1.
   - The 24px band below and right of the wheel stays empty: no hit targets, no labels.
   - A drag that starts on the wheel and moves into the band keeps turning it. The band only refuses to *start*
     interactions.
3. **Straight-edge controls** (bottom bars, side tabs, the phone quick bar, FABs) keep their content at least
   `--case-clear-min` (20px) from the physical edge, plus the safe-area inset where that is larger. Backgrounds
   and hairlines may still run to the edge. Only interactive content must clear it.
4. **Edge-swipe zones.** iOS Safari uses a swipe from the left edge for Back. No horizontal-drag interaction
   (canvas pan, carousel swipe, board drag, cable drag) may *start* in the left 20px. A drag starting there falls
   through to the browser.
5. **Hit areas are kept.** Clearance moves controls. It never shrinks them. The 44×44pt minimum from DESIGN.md
   still holds.
6. **Desktop.** Values stay the same at pointer-fine widths. Floating corner controls (the desktop thumb wheel,
   canvas zoom) use the same diagonal 24px offset for visual consistency.

## 3. Surfaces this changes

| Element | Today | With Case Clearance |
| --- | --- | --- |
| `#thumb-wheel` (≤767px) | `right: 0; bottom: 0`, pivot on the corner | pivot offset 24px diagonally: `right/bottom: max(24px, safe-area)` |
| Mission Control phone rail (`.mc-rail` ≤600px) | `6px + safe-area` padding | `max(20px, safe-area)` horizontal content inset |
| Update bar (`update-check.js`) | `left/right 12px` | `20px` |
| Board-mode bar (`#board-modes`) | `bottom: max(12px, safe-area)` | `bottom: max(24px, safe-area)` |
| Workflow Canvas corner controls ([01](01-node-canvas.md)) | new | diagonal 24px |
| Live Browser "Take control" overlay ([05](05-live-browser.md)) | new | content at least 20px from edges |

## 4. Debug overlay

With Advanced Developer Mode ([07](07-connections-hub.md)) on, `?debug=clearance` shades the clearance bands in 10%
red, so layouts can be checked on a real phone in its case.

## 5. Tests

- A helper `clearanceOffset(edgeInset)` returns `max(24, inset)`.
- The thumb wheel mount sits at the diagonal offset and has no hit target inside the band.
- A turn that starts on the wheel and drags into the band keeps turning.
- Left-edge drag starts are not captured.
