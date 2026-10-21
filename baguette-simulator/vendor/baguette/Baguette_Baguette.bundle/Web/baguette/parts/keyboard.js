// Keyboard — software keyboard input for devices that accept text.
// Forwards `keydown` events on the screen element to the server via
// the Transport. Focus-gated: only fires while the screen is the
// active element, so host browser shortcuts (Cmd+R / Cmd+T / …)
// keep working when the user is in the sidebar.
//
// The wire dialect carries `code` (W3C KeyboardEvent.code, e.g.
// `"KeyA"` / `"Digit1"` / `"Enter"`) and the four modifier flags;
// the backend (`KeyboardKey.from(wireCode:)`) resolves the HID
// usage. Frontend stays a dumb sender — no HID page/usage table.
//
// Whitelist below mirrors what `KeyboardKey.from(wireCode:)` accepts
// in `Sources/Baguette/Domain/Input/Keyboard.swift`; keep the two
// in sync. Anything outside the set falls through to the host
// browser (so Cmd+R / DevTools shortcuts still work).
//
// Paste is the one carve-out: Cmd+V / Ctrl+V is NOT forwarded as a
// raw chord — the sim's pasteboard wouldn't hold the host's text, so
// the keystroke alone pastes nothing. Instead the chord is left to
// the browser so its native `paste` event fires; the document-level
// listener below reads the clipboard text off the event and sends a
// `{type:"paste"}` envelope (server: pbcopy, then Cmd+V sim-side).
//
// Committed text (Chromium only — Safari has no text sink so its focus
// behaviour is unchanged): a focused <div> is not an editable target, so a
// host-side `insertText` / IME commit goes nowhere. A hidden single-line
// <textarea> inside the screen element takes focus instead; its
// `beforeinput` (insertText) and `compositionend` commits are sent through
// the same `paste` channel, then the sink is emptied. Keys the table below
// forwards are preventDefault-ed on keydown, so they never produce text
// here and are not sent twice.
//
// Copy is the mirror carve-out: Cmd+C / Ctrl+C is NOT forwarded as a
// raw chord either — instead it sends a `{type:"copy"}` envelope. The
// server presses Cmd+C sim-side (so the focused field copies its
// selection), then ferries the sim's pasteboard onto the host Mac's
// clipboard (pbsync <udid> host, images included). Perfect when the
// browser shares the Mac that runs baguette; for a remote browser it
// lands on the server's Mac.
(function (root) {
  'use strict';

  const FORWARDED = new Set([
    // Letters
    'KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ',
    'KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT',
    'KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ',
    // Digits
    'Digit0','Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9',
    // Numpad (physical numeric keypad — distinct HID keypad usages;
    // NumLock is omitted, iOS has no num-lock concept)
    'Numpad0','Numpad1','Numpad2','Numpad3','Numpad4','Numpad5','Numpad6','Numpad7','Numpad8','Numpad9',
    'NumpadDecimal','NumpadDivide','NumpadMultiply','NumpadSubtract','NumpadAdd','NumpadEnter','NumpadEqual',
    // Named specials
    'Enter','Escape','Backspace','Tab','Space',
    'ArrowUp','ArrowDown','ArrowLeft','ArrowRight',
    // Punctuation (US layout)
    'Minus','Equal','BracketLeft','BracketRight','Backslash',
    'Semicolon','Quote','Backquote','Comma','Period','Slash',
  ]);

  // One coalesced commit stays well below the bridge's 8000-character cap.
  const COMMIT_MAX = 2000;

  // A word character other than ideographs/kana/hangul, which carry no
  // inter-word spacing.
  const WORD = /[\p{L}\p{N}]/u;
  const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  // Printable US-keyboard ASCII and newline: typed as key chords by the bridge.
  const TYPEABLE = /^[\x20-\x7e\n]$/;
  // One typed request stays within the bridge's 256-character limit.
  const TYPE_MAX = 256;
  const isWord = (c) => c !== null && WORD.test(c) && !UNSPACED.test(c);
  const firstChar = (t) => String.fromCodePoint(t.codePointAt(0));
  const lastChar = (t) => { const a = Array.from(t); return a[a.length - 1] || null; };

  class Keyboard {
    /**
     * @param {object} _def      SimulatorDefinition.keyboard (reserved)
     * @param {Transport} transport
     */
    constructor(_def, transport) {
      this.transport = transport;
      this._el = null;
      this._inputQueue = [];
      // Focus moving between the screen element and its text sink is not a
      // blur from the simulator's point of view.
      this._onBlur = (ev) => {
        const to = ev && ev.relatedTarget;
        if (to && (to === this._sink || to === this._el)) return;
        this._inputQueue.length = 0;
      };
      this._onVisibility = () => { if (document.hidden) this._onBlur(); };
      this._onRelease = ev => { if (ev.origin === location.origin && ev.data?.type === 'cindy-release-input') this._onBlur(); };
      this._onKeyDown = (ev) => this._handle(ev);
      this._onPaste = (ev) => this._handlePaste(ev);
      this._sink = null;
      this._composing = false;
      // Last character this viewer delivered, or null when unknown (fresh
      // field, after a tap, after a non-text key).
      this._tail = null;
      this._onElFocus = () => this._focusSink();
      // Touch input (e.g. CDP / mobile) never produces the mousedown that
      // focuses the screen, because the touch source cancels touchstart.
      // pointerdown/touchstart are not cancelled by that, so use them.
      this._onPointerFocus = () => { this._tail = null; if (this._sink && document.activeElement !== this._sink) this._focusSink(); };
      this._onBeforeInput = (ev) => this._handleBeforeInput(ev);
      this._onInput = () => { if (!this._composing && this._sink) this._sink.value = ''; };
      this._onCompositionStart = () => { this._composing = true; };
      this._onCompositionEnd = (ev) => this._handleCompositionEnd(ev);
    }

    /** Bind keydown to the screen element. Focus-gated. */
    attach(el) {
      if (!el) return;
      this._el = el;
      // Make the screen focusable + focus on click so keystrokes
      // routed through this element work without an explicit Tab.
      if (el.tabIndex < 0) el.tabIndex = 0;
      el.addEventListener('mousedown', () => el.focus());
      // Safari already reports gesture* events and keeps its original
      // focus behaviour; everywhere else the text sink receives commits.
      if (typeof root.GestureEvent === 'undefined') this._attachSink(el);
      el.addEventListener('keydown', this._onKeyDown);
      el.addEventListener('blur', this._onBlur);
      // Document-level: Chrome/Firefox target the focused element,
      // Safari may target <body> when focus is a non-editable div —
      // document catches both. The focus gate in the handler keeps
      // sidebar pastes with the browser.
      document.addEventListener('paste', this._onPaste);
      document.addEventListener('visibilitychange', this._onVisibility);
      window.addEventListener('message', this._onRelease);
    }

    detach() {
      if (!this._el) return;
      this._detachSink();
      this._el.removeEventListener('keydown', this._onKeyDown);
      this._el.removeEventListener('blur', this._onBlur);
      this._inputQueue.length = 0;
      document.removeEventListener('paste', this._onPaste);
      document.removeEventListener('visibilitychange', this._onVisibility);
      window.removeEventListener('message', this._onRelease);
      this._el = null;
    }

    _attachSink(el) {
      const sink = document.createElement('textarea');
      sink.setAttribute('aria-hidden', 'true');
      // Focusable and able to receive committed text, but no on-screen
      // keyboard on touch Chromium when the screen is tapped.
      sink.setAttribute('inputmode', 'none');
      sink.setAttribute('autocomplete', 'off');
      sink.setAttribute('autocapitalize', 'off');
      sink.setAttribute('autocorrect', 'off');
      sink.spellcheck = false;
      sink.tabIndex = -1;
      sink.style.cssText =
        'position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;' +
        'margin:0;opacity:0;resize:none;overflow:hidden;pointer-events:none;' +
        'caret-color:transparent;font-size:16px;';
      el.appendChild(sink);
      this._sink = sink;
      el.addEventListener('focus', this._onElFocus);
      el.addEventListener('pointerdown', this._onPointerFocus, { capture: true, passive: true });
      el.addEventListener('touchstart', this._onPointerFocus, { capture: true, passive: true });
      // keydown bubbles from the sink to the screen element's listener.
      sink.addEventListener('blur', this._onBlur);
      sink.addEventListener('beforeinput', this._onBeforeInput);
      sink.addEventListener('input', this._onInput);
      sink.addEventListener('compositionstart', this._onCompositionStart);
      sink.addEventListener('compositionend', this._onCompositionEnd);
    }

    _detachSink() {
      const sink = this._sink;
      if (!sink) return;
      this._el.removeEventListener('focus', this._onElFocus);
      this._el.removeEventListener('pointerdown', this._onPointerFocus, { capture: true });
      this._el.removeEventListener('touchstart', this._onPointerFocus, { capture: true });
      sink.remove();
      this._sink = null;
      this._composing = false;
    }

    /** Hand keyboard focus to the sink; the screen element itself stays
     *  the logical owner (see `_hasFocus`). */
    _focusSink() {
      if (!this._sink) return;
      // Inside an embedded viewer the frame itself must own focus before
      // a host-side insertText can reach the sink.
      if (typeof root.focus === 'function') root.focus();
      this._sink.focus({ preventScroll: true });
    }

    _hasFocus() {
      const active = document.activeElement;
      return active === this._el || (this._sink !== null && active === this._sink);
    }

    _handleBeforeInput(ev) {
      // Composition text is sent once, at compositionend; paste has its
      // own document-level listener.
      if (this._composing || ev.isComposing) return;
      if (ev.inputType !== 'insertText' || typeof ev.data !== 'string' || !ev.data) return;
      if (!this._hasFocus()) return;
      ev.preventDefault();
      this.commitText(ev.data);
    }

    _handleCompositionEnd(ev) {
      this._composing = false;
      if (this._sink) this._sink.value = '';
      if (!this._hasFocus()) return;
      if (typeof ev.data === 'string' && ev.data) this.commitText(ev.data);
    }

    // --- domain verbs ---

    /** Send a single key press. modifiers: array of
     *  `"shift" | "control" | "option" | "command"`. */
    key(code, modifiers) {
      this._clipboard('key', undefined, code, modifiers);
    }

    /** Send a string as a sequence of HID keystrokes (server-side). */
    type(text) {
      this.paste(text);
    }

    /** Paste text via the sim's pasteboard (server: pbcopy + Cmd+V).
     *  Any unicode — the path around `type`'s US-ASCII limit. */
    paste(text) {
      this._clipboard('paste', text);
    }

    /** Committed text typed on a soft keyboard / IME — every character is
     *  meaningful, so unlike `paste` (whose adjacent-duplicate suppression
     *  guards a held Cmd+V) nothing is dropped here. While a request is in
     *  flight, text coalesces into the last queued commit; `_planCommit`
     *  decides how the coalesced text is delivered. */
    commitText(text) {
      if (this._inputPending && this._mergeCommit(text)) return;
      this._clipboard('paste', text, undefined, undefined, 'commit');
    }

    /** Split a commit into deliveries that keep the result identical to
     *  the typed text:
     *   - printable US-keyboard ASCII is typed as HID key chords (`type`:
     *     fast, no pasteboard, so no device-side smart-paste spacing);
     *   - everything else (CJK, emoji, accents, …) is pasted;
     *   - a multi-character paste that starts with a word character right
     *     after a word character we delivered is sent one character at a
     *     time, because the device inserted a separating space in front of
     *     such a paste ("h" + "ello world" became "h ello world").
     *  `#cindyTextInput=paste` in the viewer URL restores paste-only text. */
    _planCommit(text) {
      const plan = [];
      let tail = this._tail;
      const pasteOnly = new URLSearchParams(location.hash.slice(1)).get('cindyTextInput') === 'paste';
      let run = '', typed = null;
      const flush = () => {
        if (!run) return;
        if (typed) {
          for (let i = 0; i < run.length; i += TYPE_MAX) plan.push(['type', run.slice(i, i + TYPE_MAX), undefined, undefined, undefined]);
          tail = run[run.length - 1];
        } else {
          tail = this._planPaste(plan, run, tail);
        }
        run = '';
      };
      for (const c of text) {
        const isTyped = !pasteOnly && TYPEABLE.test(c);
        if (typed !== isTyped) flush();
        typed = isTyped;
        run += c;
      }
      flush();
      return plan;
    }

    /** Paste deliveries for one non-typeable run (or all text when typing
     *  is disabled); returns the tail character after them. */
    _planPaste(plan, text, tail) {
      let rest = text;
      while (rest) {
        const c = firstChar(rest);
        if (c === ' ') {
          plan.push(['key', undefined, 'Space', [], undefined]);
          tail = ' ';
          rest = rest.slice(1);
        } else if (rest.length > c.length && isWord(c) && isWord(tail)) {
          plan.push(['paste', c, undefined, undefined, 'commit']);
          tail = c;
          rest = rest.slice(c.length);
        } else {
          plan.push(['paste', rest, undefined, undefined, 'commit']);
          return lastChar(rest);
        }
      }
      return tail;
    }

    _noteSent(action, text, code) {
      if (action === 'paste' || action === 'type') this._tail = lastChar(text);
      else if (action === 'key') this._tail = code === 'Space' ? ' ' : code === 'Enter' ? '\n' : null;
    }

    _mergeCommit(text) {
      const tail = this._inputQueue[this._inputQueue.length - 1];
      if (!tail || tail[0] !== 'paste' || tail[4] !== 'commit' || tail[1].length + text.length > COMMIT_MAX) return false;
      tail[1] += text;
      return true;
    }

    /** Copy the focused field's selection out of the sim onto the
     *  host Mac's clipboard (server: Cmd+C sim-side, then pbsync
     *  <udid> host — images included). Mirror of `paste`; the server
     *  replies with a `copy_result` frame. */
    copy() {
      this._clipboard('copy');
    }

    async _clipboard(action, text, code, modifiers, commit) {
      if (this._inputPending) {
        const request = [action,text,code,modifiers,commit];
        const last = this._inputQueue.length ? this._inputQueue[this._inputQueue.length-1] : this._activeInput;
        if (action === 'paste' && !commit && last?.[0] === 'paste' && last[1] === text) return;
        if (this._inputQueue.length < 32) this._inputQueue.push(request);
        else window.alert('Input queue is full. Wait for pending input to finish, then retry.');
        return;
      }
      if (commit === 'commit' && action === 'paste') {
        const plan = this._planCommit(text);
        [action, text, code, modifiers, commit] = plan[0];
        this._inputQueue.unshift(...plan.slice(1));
      }
      this._noteSent(action, text, code);
      this._inputPending = true;
      this._activeInput = [action,text,code,modifiers,commit];
      const capability = new URLSearchParams(location.hash.slice(1)).get('cindyClipboard');
      const match = /^(\d{1,5})\.([a-f0-9]{64})$/.exec(capability || '');
      const udid = /^\/simulators\/([a-f0-9-]{36})\/?$/i.exec(location.pathname)?.[1];
      const startedAt = Date.now();
      try {
        if (!match || !udid) throw Error('Reopen the simulator with open_viewer.');
        const response = await fetch('/clipboard', {
          method: 'POST', headers: {'Content-Type':'application/json','X-Cindy-Clipboard':match[2]},
          body: JSON.stringify({action, text, code, modifiers, udid}), signal: AbortSignal.timeout(65000)
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw Error(result.error || 'Clipboard failed');
        // Last 50 round trips (durations only, never contents) for latency diagnosis.
        const log = root.__baguetteInputTimings || (root.__baguetteInputTimings = []);
        log.push({ action, chars: action === 'paste' || action === 'type' ? Array.from(text).length : undefined, roundTripMs: Date.now() - startedAt, server: result.timing });
        if (log.length > 50) log.shift();
      } catch (error) {
        // Visible feedback; never print potentially sensitive clipboard contents.
        this._inputQueue.length = 0;
        this._tail = null;
        window.alert('Input failed: ' + error.message);
      } finally { this._inputPending = false; this._activeInput = null; const next = this._inputQueue.shift(); if (next) this._clipboard(...next); }
    }

    // --- internals ---

    _handle(ev) {
      // Focus gate — only forward when the screen owns focus.
      if (!this._hasFocus()) return;
      // Keys that drive an active IME composition belong to the IME; its
      // committed text arrives via compositionend.
      if (ev.isComposing || ev.keyCode === 229) return;
      if (!FORWARDED.has(ev.code)) return;
      if (ev.repeat) { ev.preventDefault(); return; }
      // Paste carve-out: don't preventDefault the paste chord, or
      // the browser never fires the `paste` event _handlePaste needs.
      if ((ev.metaKey || ev.ctrlKey) && ev.code === 'KeyV') return;
      // Copy carve-out: Cmd+C / Ctrl+C copies the sim's selection
      // and ferries it to the host (server: Cmd+C + pbsync) rather
      // than forwarding as a raw chord.
      if ((ev.metaKey || ev.ctrlKey) && ev.code === 'KeyC') {
        ev.preventDefault();
        this.copy();
        return;
      }
      ev.preventDefault();
      const modifiers = [];
      if (ev.shiftKey)   modifiers.push('shift');
      if (ev.ctrlKey)    modifiers.push('control');
      if (ev.altKey)     modifiers.push('option');
      if (ev.metaKey)    modifiers.push('command');
      this.key(ev.code, modifiers);
    }

    _handlePaste(ev) {
      // Same focus gate as keydown — a paste while the sidebar owns
      // focus belongs to the browser, not the sim.
      if (!this._hasFocus()) return;
      const text = ev.clipboardData && ev.clipboardData.getData('text/plain');
      if (!text) return;
      ev.preventDefault();
      this.paste(text);
    }
  }

  root.Baguette = root.Baguette || {};
  root.Baguette._Keyboard = Keyboard;
})(window);
