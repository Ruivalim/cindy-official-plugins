// TouchGestureSource — real multi-touch (iOS WebView). Single-finger
// touch (drag, edge gestures) streams touch1-*; where the browser has
// Safari's native gesturestart/change/end, a second finger abandons the
// touch path entirely and lets SafariGestureEventSource own the pinch —
// see the note below. Browsers without those events (Chromium) stream the
// two real fingers as touch2-* from here instead.
//
// A two-finger gesture is never allowed to end up as a single-finger tap, and
// whatever has been pressed is released when the gesture ends, is cancelled
// or the source is detached. The second finger may land outside the bound
// element (a pinch that starts wider than the screen): its touchstart then
// goes to another element and never reaches this one, so the finger count is
// also read from the document (capture) and from every touchmove, whose
// `touches` lists every finger on the page.
(function (root) {
  'use strict';

  const MOVE_FLUSH_MS = 16; // ~60 fps coalescing window
  // A lone finger is held back this long before it is sent as touch1-down:
  // a second finger landing inside the window turns it into a two-finger
  // gesture and the held touch is dropped, never sent. Without the hold the
  // first finger of every pinch went out as a complete touch1-down/up (a tap
  // at its position) right before the touch2-down, which can fire whatever is
  // under that finger and, when the fingers start close together, sits just
  // before the pair like the first tap of a double-tap. A move, a lift or the
  // end of the window sends the held touch first, so drags and taps start
  // exactly when they did, and only a motionless press is delayed. 160 ms
  // because the phone preview delivers its second finger after the first
  // one's batch is acknowledged: a round trip through the computer measured
  // at 50-170 ms (100 ms let 5 of 8 pinch-outs through as taps).
  const SINGLE_HOLD_MS = 160;

  class TouchGestureSource extends root.Baguette._AttachableEventSource {
    /**
     * @param {Screen} screen
     * @param {object} [opts]
     * @param {PinchOverlay} [opts.overlay]
     * @param {() => string} [opts.getOrientation]
     * @param {(clientX:number, clientY:number) => object} [opts.mapClientPoint]
     * @param {() => boolean} [opts.hasSafariGestures]  true when the
     *   browser fires gesturestart/change/end (SafariGestureEventSource
     *   then owns two-finger pinch).
     */
    constructor(screen, { overlay, getOrientation, mapClientPoint, hasSafariGestures } = {}) {
      super(screen, { mapClientPoint });
      this.overlay = overlay || null;
      this.getOrientation = getOrientation || (() => 'portrait');
      this._hasSafariGestures = hasSafariGestures ||
          (() => typeof root.GestureEvent !== 'undefined' || 'ongesturestart' in root);
    }

    detach() {
      // A lone touch still held back is dropped, never sent after the detach;
      // one already pressed on the device is lifted.
      if (this._dropHeld) this._dropHeld();
      if (this._releaseAll) this._releaseAll();
      this._dropHeld = null;
      this._releaseAll = null;
      super.detach();
    }

    _bind() {
      const opts = { passive: false };
      let state = null;
      let lastMs = 0;
      let holdTimer = null;

      const clearHold = () => {
        if (holdTimer !== null) {
          root.clearTimeout(holdTimer);
          holdTimer = null;
        }
      };
      this._dropHeld = () => {
        clearHold();
        if (state && state.mode === 'pending') state = null;
      };
      // Every finger on the page (not only those on the bound element), from the
      // document's capture phase; null where there is no document to ask.
      let pageTouches = null;
      const clearOverlay = () => {
        if (this.overlay) this.overlay.clear();
      };
      // Lifts whatever this source has pressed on the device and forgets it.
      const releaseAll = () => {
        clearHold();
        const held = state;
        state = null;
        if (!held) return;
        if (held.mode === 'single') this.screen.touchUp([held.last]);
        else if (held.mode === 'edge-stream') this.screen.touchUp([held.last], { edge: held.edge });
        else if (held.mode === 'multi') this.screen.touchUp(held.last);
        clearOverlay();
      };
      this._releaseAll = releaseAll;
      // Sends a held lone touch (see SINGLE_HOLD_MS) and makes it a streaming one.
      const startHeld = () => {
        clearHold();
        if (!state || state.mode !== 'pending') return;
        // Two fingers are down on the page (the second outside the bound
        // element): this is a pinch, not a lone press.
        if (pageTouches && pageTouches.length >= 2 && !this._hasSafariGestures()) {
          beginPair(pageTouches);
          return;
        }
        const { point, edge } = state;
        if (edge) {
          state = { mode: 'edge-stream', edge, last: point };
          this.screen.touchDown([point], { edge });
        } else {
          state = { mode: 'single', last: point };
          this.screen.touchDown([point]);
        }
      };

      const relFingers = (touches) => {
        const r = this._el.getBoundingClientRect();
        const { width, height } = this.screen.size;
        return Array.from(touches).map((t) => ({
          // Chrome-pixel coords (visual rect → device-point scale)
          // so the wire envelope ships the same units as `tap`.
          x: ((t.clientX - r.left) / r.width) * width,
          y: ((t.clientY - r.top) / r.height) * height,
          // Pre-scaling raw pixels for the overlay HUD, which paints
          // host-local DOM dots in CSS pixels.
          vx: t.clientX - r.left, vy: t.clientY - r.top,
        }));
      };

      // iOS Safari fires BOTH `touchstart/move/end` AND `gesturestart/
      // change/end` for a 2-finger pinch. The legacy code only ever
      // attached MouseGestureSource (which listens to `gesture*`), so
      // pinch on iPhone was driven by Safari's `gesture*` stream
      // alone. If we ALSO emit `touch2-*` envelopes from this handler,
      // the simulator receives two interleaved touch2 streams and iOS
      // sees fingers teleporting between them → spinning.
      //
      // Resolution: when a second finger lands, abandon the touch
      // path entirely and let SafariGestureEventSource (gesturestart →
      // gesturechange → gestureend) own the pinch. Single-finger
      // touch (drag, edge gestures) stays here.
      // The first two real touch points as wire coordinates.
      const pairOf = (touches) => {
        const pts = [touches[0], touches[1]].map(
            (t) => this._screenPoint(t.clientX, t.clientY));
        return {
          inside: pts.every((p) => p.inside),
          fingers: pts.map((p) => ({ x: p.x, y: p.y })),
        };
      };

      // Chromium (no gesture* events): two real fingers are on the page, so
      // stream them as touch2-*. Whatever this source had pressed or held as a
      // lone finger is dropped or lifted first, so the pair never follows a tap.
      const beginPair = (touches) => {
        clearHold();  // a held lone touch was never sent: nothing to lift
        const all = relFingers(touches);
        if (state && (state.mode === 'single' || state.mode === 'edge-stream')) {
          if (state.mode === 'edge-stream') this.screen.touchUp([state.last], { edge: state.edge });
          else this.screen.touchUp([state.last]);
        }
        const pair = pairOf(touches);
        if (pair.inside) {
          this.screen.touchDown(pair.fingers);
          state = { mode: 'multi', last: pair.fingers };
          lastMs = 0;
        } else {
          state = { mode: 'multi-ignored' };
        }
        if (this.overlay) {
          this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
        }
      };
      // The pinch is over (a finger lifted, possibly one this element never
      // heard of): release both fingers and let the remaining one do nothing.
      const endPair = (remaining) => {
        if (!state || state.mode !== 'multi') return;
        this.screen.touchUp(state.last);
        clearOverlay();
        state = remaining > 0 ? { mode: 'multi-ended' } : null;
      };
      const noteFingers = (e) => { pageTouches = e.touches; };
      const pageTouchStart = (e) => {
        noteFingers(e);
        // A second finger that landed outside the bound element: its touchstart
        // never reaches the handler below.
        if (e.touches.length >= 2 && !this._hasSafariGestures() && state &&
            (state.mode === 'pending' || state.mode === 'single' || state.mode === 'edge-stream')) {
          beginPair(e.touches);
        }
      };
      const pageTouchEnd = (e) => {
        noteFingers(e);
        if (e.touches.length < 2) endPair(e.touches.length);
      };
      const doc = root.document;
      if (doc && doc.addEventListener) {
        this._on(doc, 'touchstart', pageTouchStart, { capture: true, passive: true });
        this._on(doc, 'touchmove', noteFingers, { capture: true, passive: true });
        this._on(doc, 'touchend', pageTouchEnd, { capture: true, passive: true });
        this._on(doc, 'touchcancel', pageTouchEnd, { capture: true, passive: true });
        // The page going away (tab hidden, closed, navigated) ends the gesture
        // for good: nothing would lift the fingers afterwards.
        this._on(doc, 'visibilitychange', () => {
          if (doc.visibilityState === 'hidden') releaseAll();
        });
      }
      if (root.addEventListener) this._on(root, 'pagehide', releaseAll);

      this._on(this._el, 'touchstart', (e) => {
        e.preventDefault();
        noteFingers(e);
        const all = relFingers(e.touches);
        if (all.length >= 2 && !this._hasSafariGestures()) {
          // No gesture* events in this browser (Chromium): nothing else
          // will drive the pinch, so stream the two real fingers. A third
          // finger joins a pinch already streaming and changes nothing.
          if (state && state.mode === 'multi') {
            if (this.overlay) {
              this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
            }
            return;
          }
          beginPair(e.touches);
          return;
        }
        if (all.length >= 2) {
          // If we'd already shipped a touch1-down, lift it cleanly
          // before bowing out — otherwise the simulator holds a
          // phantom touch1 while `gesturestart` opens its own pinch.
          clearHold();
          if (state && state.mode === 'single') {
            this.screen.touchUp([{ x: all[0].x, y: all[0].y }]);
          }
          state = { mode: 'multi-deferred' };  // gesture* will handle it
          // Paint the two real finger positions so the HUD lights up
          // the moment the second finger lands; touchmove keeps it
          // following (gesturechange's centroid-only positions are
          // too coarse to track each fingertip accurately).
          if (this.overlay) {
            this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
          }
          return;
        }
        if (all.length === 1) {
          // A new gesture starts: nothing of an earlier one may stay pressed
          // (its end never reached this element).
          if (state && (state.mode === 'single' || state.mode === 'edge-stream' || state.mode === 'multi')) {
            releaseAll();
          }
          // Edge-band detection — same shape as the mouse handler. In
          // 3D Interact mode a touch on the device bezel/body maps
          // outside the screen quad and starts nothing.
          const touch = e.touches[0];
          const point = this._screenPoint(touch.clientX, touch.clientY);
          if (point.inside) {
            // Tag the wire envelope with `edge:"bottom"` (or "top")
            // using the touch's REAL coords; no clamp. iOS treats the
            // flag as a swipe HINT — it commits to the home-indicator
            // recogniser when motion follows, otherwise the touch
            // lands as a normal tap at the real location and bottom-
            // band UI buttons still work.
            const startEdge = new root.Baguette._EdgeBands(0.85, 0.15)
                .classify(point, this.getOrientation());

            // Held, not sent yet (SINGLE_HOLD_MS): a second finger may follow.
            clearHold();
            state = { mode: 'pending', point, edge: startEdge || null };
            holdTimer = root.setTimeout(startHeld, SINGLE_HOLD_MS);
          }
        }
        lastMs = 0;
      }, opts);

      this._on(this._el, 'touchmove', (e) => {
        e.preventDefault();
        noteFingers(e);
        if (!state) return;
        const all = relFingers(e.touches);

        // Multi-deferred: wire envelopes come from SafariGestureEventSource
        // (Safari's gesture* uses scale/rotation around a fixed
        // centroid and can't tell us each finger's real position).
        // But the overlay HUD wants to track the REAL fingers — so
        // keep painting from e.touches without dispatching wire.
        if (state.mode === 'multi-deferred') {
          if (this.overlay && all.length >= 2) {
            this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
          }
          return;
        }

        if (state.mode === 'multi-ignored' || state.mode === 'multi-ended') return;

        // `touches` lists every finger on the page, so a second finger whose
        // touchstart went elsewhere shows up here. A lone finger held back is
        // part of a two-finger gesture after all: never send it as a tap.
        if (all.length >= 2 && state.mode !== 'multi') {
          if (!this._hasSafariGestures()) {
            beginPair(e.touches);
            return;
          }
          if (state.mode === 'pending') {
            clearHold();
            state = { mode: 'multi-deferred' };
            if (this.overlay) {
              this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
            }
            return;
          }
        }
        if (state.mode === 'pending') startHeld();

        if (state.mode === 'multi') {
          // One finger left without this element hearing of it: the pinch is over.
          if (all.length < 2) { endPair(all.length); return; }
          const pair = pairOf(e.touches);
          state.last = pair.fingers;  // freshest positions for the touch-up
          if (this.overlay) {
            this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
          }
          const t = performance.now();
          if (t - lastMs < MOVE_FLUSH_MS) return;
          lastMs = t;
          this.screen.touchMove(pair.fingers);
          return;
        }

        const now = performance.now();
        if (now - lastMs < MOVE_FLUSH_MS) return;
        lastMs = now;
        if (state.mode === 'edge-stream' && all.length === 1) {
          const at = this._screenPoint(e.touches[0].clientX, e.touches[0].clientY);
          state.last = at;
          this.screen.touchMove([at], { edge: state.edge });
        } else if (state.mode === 'single' && all.length === 1) {
          const at = this._screenPoint(e.touches[0].clientX, e.touches[0].clientY);
          state.last = at;
          this.screen.touchMove([at]);
        } else if (state.mode === 'single' && all.length >= 2) {
          // Late-arriving second finger after a streaming single
          // touch had already started: close it cleanly and hand
          // off to SafariGestureEventSource. Overlay starts tracking
          // both fingers in the next touchmove.
          this.screen.touchUp([{ x: all[0].x, y: all[0].y }]);
          state = { mode: 'multi-deferred' };
          if (this.overlay) {
            this.overlay.setFingers(all.slice(0, 2).map((f) => ({ x: f.vx, y: f.vy })));
          }
        }
      }, opts);

      const endTouch = (e) => {
        e.preventDefault();
        noteFingers(e);
        if (!state) return;
        if (state.mode === 'pending') {
          // A cancelled lone touch was never sent: nothing to cancel. A lift
          // is a tap: send the held touch, then lift it below.
          if (e.type === 'touchcancel') {
            clearHold();
            state = null;
            return;
          }
          // A finger is still down elsewhere on the page: this lift ends a
          // two-finger gesture that never started here, not a tap.
          if (e.touches.length >= 1) {
            clearHold();
            state = { mode: 'multi-ended' };
            return;
          }
          startHeld();
        }
        if (state.mode === 'multi' || state.mode === 'multi-ignored' || state.mode === 'multi-ended') {
          // Pinch ends when the first finger lifts (or on cancel); the
          // remaining finger must not start a stray single touch.
          if (e.type === 'touchend' && e.touches.length >= 2) return;
          if (state.mode === 'multi') {
            this.screen.touchUp(state.last);
            clearOverlay();
          }
          state = e.type === 'touchend' && e.touches.length > 0 ? { mode: 'multi-ended' } : null;
          return;
        }
        if (state.mode === 'multi-deferred') {
          // gesture*start/change/end owns this lifecycle; only the HUD is ours.
          clearOverlay();
          state = null;
          return;
        }
        const touch = e.changedTouches[0];
        const point = touch
          ? this._screenPoint(touch.clientX, touch.clientY)
          : { x: 0, y: 0 };
        if (state.mode === 'edge-stream') {
          this.screen.touchUp([point], { edge: state.edge });
        } else {
          this.screen.touchUp([point]);
        }
        state = null;
      };
      this._on(this._el, 'touchend', endTouch, opts);
      this._on(this._el, 'touchcancel', endTouch, opts);
    }
  }

  root.Baguette = root.Baguette || {};
  root.Baguette._TouchGestureSource = TouchGestureSource;
})(window);
