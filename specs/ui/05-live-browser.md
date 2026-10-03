# 05 · Embedded Live Browser Streaming (CDP / Playwright)

Status: **spec, not built** · Surfaces:
- the `browser` node inspector on the Workflow Canvas,
- the team focused view **Browser** sub-tab ([03](03-team-cards.md)),
- picture-in-picture over the canvas during a run.

Roadmap: Phase 4, Step 4.5

Agents that browse do it in a real Chromium on the engine, driven by Playwright. The portal shows that browser live,
so the user can watch, and in HITL mode take over.

## 1. Engine side (proposed)

- The engine launches Playwright Chromium in a **fresh, isolated context per session**:
  - no persistent profile and none of the user's own cookies,
  - downloads disabled,
  - viewport 1280×720.
- It opens a CDP session on the page (`context.newCDPSession(page)`) and starts a screencast:

  ```js
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    forward({ type: 'frame', data, metadata });        // base64 JPEG + page scale / scroll offsets
    cdp.send('Page.screencastFrameAck', { sessionId }); // ack after forwarding: CDP sends the next frame only then
  });
  ```

- It streams frames on **`ws /api/browser/:sessionId/stream`**, with the same bearer-subprotocol auth as
  `/api/voice/stream`.
- **Frame types:**

  | Frame | Payload |
  | --- | --- |
  | `frame` | JPEG data plus metadata |
  | `nav` | URL, title, `can_go_back` |
  | `status` | `live`, `loading`, `paused`, `ended` or `halted` |
  | `control` | who has control: `agent` or `user` |
  | `blocked` | `{ url, reason }` |

- **Backpressure:** when the socket's buffered amount passes 1MB, the engine drops frames, keeping only the newest,
  and acks CDP anyway, so the browser never stalls.
- **Domain allowlist:** each session has one, from the workflow's browser node. A navigation outside it is aborted
  (`page.route`) and reported as a `blocked` frame.
- **Breaker:** a trip stops the screencast and freezes the page. The stream sends `status: halted`.

## 2. The container (portal)

```
┌ 🔒 vendor-portal.example.com/quotes ─────────── ● Live · 14 fps ─┐
│                                                                  │
│                 <canvas>: the agent's browser                    │
│                                                                  │
├──────────────────────────────────────────────────────────────────┤
│ Atlas is filling the quote form (step 4/9)   [Take control] [■]  │
└──────────────────────────────────────────────────────────────────┘
```

- **Frame:**
  - 16:9, letterboxed in `--terminal` with no stretching.
  - The `--surface` card has a hairline and `--radius-l`, like the other Mission Control panels.
  - Desktop: fills the focused view's width. PiP mode is 320×180, draggable, and snaps to a corner with Case
    Clearance ([02](02-case-clearance.md)).
- **Drawing:** each frame is decoded with `createImageBitmap(blob)` and drawn to a `<canvas>`. Only the newest
  decoded frame is drawn, so a slow device skips frames instead of falling behind.
- **Header:**
  - a lock icon and the URL as **read-only** text (the user cannot type a URL),
  - a status pill (Live, Loading, Paused, Ended, Halted),
  - the measured fps,
  - a latency hint: "2.1s behind" when frame timestamps lag.
- **Footer:** the agent's current step in plain words, **Take control** (HITL only, see §3) and **Stop session**
  (■, with a confirm).
- **States:**

  | State | Shows |
  | --- | --- |
  | Connecting | Skeleton frame with "Starting browser…" |
  | Reconnecting | Last frame greyed with a spinner; exponential backoff, at most 5 tries |
  | Ended | Last frame greyed, with **Replay steps** listing the visited URLs |
  | Halted | Last frame with the pulsing red HALTED overlay used by the breaker (static under reduced motion) |
  | Blocked navigation | Inline orange row: "Blocked: example.org is not on this workflow's allowlist" |

## 3. Take control (HITL)

- The control is available only when the owning team is in **HITL** mode. Taking control pauses the agent at
  its next step boundary (`control: user`).
- While the user has control:
  - Pointer events on the canvas are mapped to page coordinates (`x / canvasWidth × 1280`, adjusted by the frame's
    `metadata.pageScaleFactor` and scroll offsets) and sent as `input` frames. The engine replays them with
    `Input.dispatchMouseEvent` and `Input.dispatchKeyEvent`.
  - Keyboard input is captured only while the canvas has focus, shown by a 1px `--accent` ring.
  - An orange banner says "You're in control. Atlas is paused", with a **Hand back** button.
- Handing back resumes the agent, and the agent is told what changed ("user navigated to /quotes/42 and typed in 2
  fields"). It is told *where* the user typed, never *what*.
- On phones, taps map to clicks and long-press maps to a right-click. Typing opens the system keyboard from a
  hidden input that forwards keys.

## 4. Privacy and safety

- Nothing is recorded by default. **Record session** is a per-run opt-in. When on, frames are kept as a 1fps JPEG
  sequence on the engine for 24 hours, and the run's card shows a REC badge.
- Password fields render as dots in screenshots anyway. Before a frame leaves the engine, it also blurs the
  bounding boxes of `input[type=password]` and of any `[autocomplete*=cc-]` field (card data), using
  `DOM.getBoxModel`.
- The browser runs on the engine with the engine's network, never the user's. The portal says so in the session
  header's info popover.
- Stop session closes the context and deletes the session's storage.

## 5. Tests

- Coordinate mapping at scale factors 1 and 2, and with scroll offsets.
- Newest-frame-only drawing under a burst of frames.
- Reconnect backoff.
- Take control is available only in HITL, and Hand back resumes the agent.
- Halted and blocked frames render the right overlays.
- Keyboard capture only while focused.
