// Keyboard + mouse (pointer lock) + standard gamepad + on-screen touch controls (src/core/touch.js).
// Produces a unified per-frame snapshot. The touch layer writes into `mouse.*` rather than being a parallel device:
// the map UIs (src/ui/diorama.js, src/ui/hud.js) steer their cursors off `mouse.dx/dy` + `locked`, and routing touch
// through the same fields keeps those paths working on a phone untouched.
// Gamepad: radial dead zone + response curve sticks (padStick) and subtle dual-rumble (rumble), scaled by
// settings.rumble (0..1, default 1) and only while the pad is the active device.
import { G } from './ctx.js';

// keys whose browser default (focus moves, page scroll) must never fire while the game has the mouse
const GAME_KEYS = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'Quote']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressed = new Set();       // keys pressed this frame
    this.mouse = { dx: 0, dy: 0, left: false, right: false, leftPressed: false, rightPressed: false };
    // Real pointer-lock state. Read `locked` (the getter) to ask "does the game own the cursor?"; read `_plock` to ask
    // "is the browser delivering pointer-lock deltas?". The two are the same thing on desktop and MUST differ on a
    // phone: Android Chrome synthesizes compatibility mouse events (mousemove/mousedown) after every tap, so a handler
    // that guards on the virtual `locked` would turn each tap into a phantom shot and a jolt of bogus camera motion.
    this._plock = false;
    this.enabled = true;
    this.pad = null;
    this.padPrev = [];
    this.padPressed = new Set();
    this.lastDevice = 'kbm';
    // Touch device state, owned by src/core/touch.js. `active` is DEVICE-level (the touch layer is in charge) and stays
    // put for the session; `fingers` counts live contacts, so the map cursor does not blink off between taps.
    // Levels live here; sub-frame taps are preserved by `_latched` (see touchDown).
    this.touch = { active: false, fingers: 0, mx: 0, mz: 0, fire: false, sub: false, squid: false, jump: false, special: false, cheer: false, map: false };
    this._latched = Object.create(null);   // buttons asserted at any point since the last endFrame()
    this._touchPrev = { left: false, right: false };
    this.onKey = null;              // (e) => bool consumed  (menus)
    this.onPause = null;            // () => void, the touch pause button (never synthesizes Escape: see touch.js)
    window.addEventListener('keydown', (e) => {
      // ⌘-combos (⌘Q quit, ⌘H hide, ⌘M minimise, ⌘W close …) belong to macOS: never read them as game / menu keys
      // (the menus mapped ⌘Q to "previous tab" and swallowed it). macOS also sends no keyup for a key released while
      // ⌘ is held, so tracking them would leave the key stuck down.
      if (e.metaKey) return;
      // the menus call preventDefault themselves when needed (text fields must still receive keystrokes)
      // auto-repeat must be swallowed too: holding TAB for the map used to let the repeats move browser focus off the
      // canvas → pointer lock dropped → the round paused ("opening the map opens the menu")
      if (e.repeat) {
        if (e.code === 'Tab' || (this._plock && GAME_KEYS.has(e.code))) e.preventDefault();
        if (this.onKey) this.onKey(e, true);
        return;
      }
      this.lastDevice = 'kbm';
      if (this.onKey && this.onKey(e, false)) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
      if (GAME_KEYS.has(e.code) && this._plock) e.preventDefault();
      if (e.code === 'Tab') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    // A backgrounded tab must not come back with a button still held down (the release event went to the OS, not us).
    window.addEventListener('blur', () => { this.keys.clear(); this.releaseAll(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    window.addEventListener('mousemove', (e) => {
      if (!this._plock) return;
      this.mouse.dx += e.movementX; this.mouse.dy += e.movementY;
      this.lastDevice = 'kbm';
    });
    window.addEventListener('mousedown', (e) => {
      if (!this._plock) return;
      if (e.button === 0) { this.mouse.left = true; this.mouse.leftPressed = true; }
      if (e.button === 2) { this.mouse.right = true; this.mouse.rightPressed = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this._plock = document.pointerLockElement === this.canvas;
      if (!this._plock) { this.mouse.left = this.mouse.right = false; this.onUnlock?.(); }
    });
  }

  // Does the game own the cursor? True under real pointer lock, and true for the whole session on a touch device —
  // that is what lets the map cursors in diorama.js / hud.js run on a phone without knowing about touch.
  get locked() { return this._plock || this.touch.active; }

  // Drop every held level. Wired to blur / visibilitychange, and called whenever the touch layer's own gesture state
  // is invalidated (orientation change, a menu opening) — a latched fire button on a screen you cannot see is exactly
  // the bug that fires a shot the moment you come back.
  releaseAll() {
    this.keys.clear();
    this.mouse.left = this.mouse.right = false;
    this.mouse.leftPressed = this.mouse.rightPressed = false;
    const t = this.touch;
    t.fire = t.sub = t.squid = t.jump = t.special = t.cheer = false;
    t.mx = t.mz = 0;
    for (const k in this._latched) delete this._latched[k];
  }

  // ---- touch device API (called by src/core/touch.js) ------------------------------------------------------------
  // Levels are set/cleared here so `_latched` can preserve a tap shorter than one frame. Without the latch a quick
  // tap whose down and up both land between two frames reads as `false` by the time the game looks: the map tap would
  // work (it uses the edge) while the gameplay action silently did nothing.
  setTouchMode(on) {
    if (this.touch.active === on) return;
    this.touch.active = on;
    if (!on) this.releaseAll();
  }
  touchDown(name) { this.touch[name] = true; this._latched[name] = true; }
  touchUp(name) { this.touch[name] = false; }
  touchHeld(name) { return !!(this.touch[name] || this._latched[name]); }
  touchMapToggle() { this.touch.map = !this.touch.map; }
  // Synthesized one-frame codes for the actions the controller reads as key edges (cheer, map jump targets). Levels
  // must never go through here — a synthesized `KeyM` would open and close the map inside a single frame, because
  // player.js reads the map as a HELD key.
  pressCode(code) { this.keys.add(code); this.pressed.add(code); }
  releaseCode(code) { this.keys.delete(code); }

  requestLock() {
    if (this.touch.active || this._plock) return;   // touch has no pointer to lock
    try {
      const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
      // some platforms reject unadjustedMovement: fall back to a plain request
      if (p && p.catch) p.catch(() => { try { const q = this.canvas.requestPointerLock(); if (q && q.catch) q.catch(() => {}); } catch { /* ignore */ } });
    } catch { /* not allowed without a gesture */ }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }

  down(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }

  pollPad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') { pad = p; break; }
    if (!pad) for (const p of pads) if (p && p.connected) { pad = p; break; }
    this.pad = pad;
    this.padPressed.clear();
    if (!pad) return;
    pad.buttons.forEach((b, i) => {
      const was = this.padPrev[i] || false;
      if (b.pressed && !was) { this.padPressed.add(i); this.lastDevice = 'pad'; }
      this.padPrev[i] = b.pressed;
    });
    const ax = pad.axes;
    if (Math.abs(ax[0]) > 0.3 || Math.abs(ax[1]) > 0.3 || Math.abs(ax[2]) > 0.3 || Math.abs(ax[3]) > 0.3) this.lastDevice = 'pad';
  }

  // Apply the touch layer's buttons to the mouse fields the rest of the game already reads, once per frame alongside
  // pollPad(). The edges are derived here (level now vs level last frame) rather than taken from the raw pointer
  // events, so a tap that both starts and ends between two frames still produces exactly one `leftPressed`.
  pollTouch() {
    const t = this.touch;
    if (!t.active) return;
    const left = this.touchHeld('fire'), right = this.touchHeld('sub');
    this.mouse.leftPressed = this.mouse.leftPressed || (left && !this._touchPrev.left);
    this.mouse.rightPressed = this.mouse.rightPressed || (right && !this._touchPrev.right);
    this._touchPrev.left = left; this._touchPrev.right = right;
    this.mouse.left = left; this.mouse.right = right;
  }

  padButton(i) { return !!(this.pad && this.pad.buttons[i] && this.pad.buttons[i].pressed); }
  padValue(i) { return this.pad && this.pad.buttons[i] ? this.pad.buttons[i].value : 0; }
  padAxis(i) {
    if (!this.pad) return 0;
    const v = this.pad.axes[i] || 0;
    const dz = 0.14;
    return Math.abs(v) < dz ? 0 : Math.sign(v) * (Math.abs(v) - dz) / (1 - dz);
  }

  // Stick with a RADIAL dead zone (no axis snapping on diagonals), an outer dead zone (full deflection is reachable
  // on worn sticks) and an optional response exponent applied to the magnitude only (direction is preserved).
  padStick(ix, iy, out, dz = 0.12, outer = 0.96, expo = 1) {
    out.x = 0; out.y = 0; out.mag = 0;
    if (!this.pad) return out;
    const x = this.pad.axes[ix] || 0, y = this.pad.axes[iy] || 0;
    const m = Math.hypot(x, y);
    if (m <= dz) return out;
    const k = Math.min(1, (m - dz) / (outer - dz));
    const c = expo === 1 ? k : Math.pow(k, expo);
    out.x = (x / m) * c; out.y = (y / m) * c; out.mag = c;
    return out;
  }

  // Dual-rumble pulse. strong = low-frequency motor, weak = high-frequency motor (0..1), ms = duration.
  // A pulse only pre-empts a running one if it is at least as strong, so rapid fire never becomes a constant buzz.
  rumble(strong, weak, ms = 60) {
    const pad = this.pad;
    if (!pad || this.lastDevice !== 'pad') return;
    const k = G.settings?.rumble ?? 1;
    if (!(k > 0)) return;
    const act = pad.vibrationActuator;
    if (!act || !act.playEffect) return;
    const now = performance.now();
    const mag = Math.max(strong, weak) * k;
    if (now < (this._rumbleUntil || 0) && mag < (this._rumbleMag || 0) * 0.95) return;
    this._rumbleUntil = now + ms; this._rumbleMag = mag;
    try {
      const p = act.playEffect('dual-rumble', { startDelay: 0, duration: Math.round(ms), strongMagnitude: Math.min(1, strong * k), weakMagnitude: Math.min(1, weak * k) });
      if (p && p.catch) p.catch(() => {});
    } catch { /* unsupported */ }
  }

  // Call once at the very end of each frame.
  endFrame() {
    this.pressed.clear();
    this.mouse.dx = 0; this.mouse.dy = 0;
    this.mouse.leftPressed = false; this.mouse.rightPressed = false;
    for (const k in this._latched) delete this._latched[k];   // a tap lives exactly one frame, never two
  }
}
