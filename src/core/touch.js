// On-screen controls for touch devices (phones / tablets), driven entirely by Pointer Events.
//
// How it talks to the rest of the game: it writes into the existing Input snapshot rather than being a parallel
// device. Look deltas land in `mouse.dx/dy` — the same field the map cursors read (src/ui/diorama.js, src/ui/hud.js)
// — so those two UIs work on a phone without knowing touch exists, and the camera reads the same field with its own
// gain (touch deltas are screen-bounded pixels; pointer-lock counts are unbounded). Buttons land in `input.touch.*`
// and are folded into the mouse fields by Input.pollTouch().
//
// Two rules this file exists to respect:
//   * ONE listener layer, with geometric hit-testing. Chrome applies implicit pointer capture to whatever element
//     received `pointerdown`, so listeners spread across buttons + canvas would retarget pointermove as soon as a
//     thumb slides off a button. One layer plus maths keeps every gesture correct and makes zones trivially
//     recomputable on resize. Deliberately no setPointerCapture: it does not stop browser gestures and it would
//     steal events from the menus.
//   * Every control stays clear of the screen edges. Android 10+ gesture navigation owns edge swipes, and it wins:
//     a control within ~32dp of an edge eats a `pointercancel` instead of a tap.
import { G } from './ctx.js';
import { TOUCH } from '../config.js';

// Left share of the screen that owns the movement stick. The rest is look / fire / buttons.
const MOVE_ZONE = 0.44;

// Button layout, anchored to the bottom-right corner (the right thumb's natural arc). x/y are distances from the
// right / bottom edge in units of the step `u`, r is the radius in the same units, so the whole cluster scales
// together. +x = left, +y = up. Tuned on device — these are the numbers to move.
const LAYOUT = [
  { name: 'fire', label: '', x: 1.50, y: 1.50, r: 1.50, cls: 'is-fire' },
  { name: 'jump', label: 'JUMP', x: 4.55, y: 1.20, r: 1.05 },
  { name: 'squid', label: 'SQUID', x: 4.55, y: 3.40, r: 1.05 },
  { name: 'sub', label: 'SUB', x: 1.50, y: 4.35, r: 1.05 },
  { name: 'special', label: 'SP', x: 4.20, y: 5.30, r: 1.05 },
];
// Top-right row: not thumb-arc controls, so they sit on their own line. `top: true` anchors them to the top edge.
const TOP_LAYOUT = [
  { name: 'map', label: 'MAP', x: 1.10, y: 1.10, r: 0.90, cls: 'is-small', top: true },
  { name: 'cheer', label: 'YEAH', x: 2.95, y: 1.10, r: 0.90, cls: 'is-small', top: true },
  { name: 'pause', label: 'II', x: 4.80, y: 1.10, r: 0.90, cls: 'is-small', top: true },
];

// Buttons whose press must also reach the game as a one-frame key edge (the controller reads those via wasPressed).
// Levels must NOT go through that path: a synthesized `KeyM` would open and close the map inside a single frame,
// because the controller reads the map as a HELD key.
const EDGE_CODES = { cheer: 'KeyC' };

// Controls that are NOT levels, so lifting the finger must not clear them: `map` is a latch (nobody has a thumb free
// to hold a map button while dragging) and `pause` is a one-shot action. Every other button is hold-to-use.
const NOT_LEVEL = new Set(['map', 'pause']);

// Is the PRIMARY pointer a finger? A touchscreen laptop reports maxTouchPoints > 0 but `pointer: fine`, and it wants
// the mouse path — only a device whose main input is a thumb gets on-screen controls.
export function isTouchDevice() {
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches && (navigator.maxTouchPoints || 0) > 0;
}

// settings.touchControls: 'on' | 'off' force it, 'auto' decides by device.
export function shouldUseTouch(settings) {
  const mode = settings?.touchControls ?? 'auto';
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return isTouchDevice();
}

export class TouchControls {
  constructor(input) {
    this.input = input;
    this.roles = new Map();        // pointerId -> 'move' | 'look' | 'fire' | 'btn:<name>'
    this.look = { id: null, x: 0, y: 0 };
    this.move = { id: null, ox: 0, oy: 0 };
    this.buttons = [];             // { name, el, ux, uy, ur, top, cx, cy, r }
    this.u = TOUCH.minStep;
    this.stickR = 1;
    this.enabled = false;          // the game layer is live (in a match, no menu open)
  }

  // ---- lifecycle -------------------------------------------------------------------------------------------------
  mount(parent) {
    const el = (this.el = document.createElement('div'));
    el.className = 'iw-touch';
    for (const b of [...LAYOUT, ...TOP_LAYOUT]) {
      const d = document.createElement('div');
      d.className = 'iw-touch__btn' + (b.cls ? ' ' + b.cls : '');
      if (b.label) d.textContent = b.label;
      el.appendChild(d);
      this.buttons.push({ name: b.name, el: d, ux: b.x, uy: b.y, ur: b.r, top: !!b.top, cx: 0, cy: 0, r: 0 });
    }
    const stick = (this.stick = document.createElement('div'));
    stick.className = 'iw-touch__stick';
    stick.innerHTML = '<i></i>';
    el.appendChild(stick);
    this.knob = stick.firstChild;
    parent.appendChild(el);
    // Portrait gate: CSS shows this only when the viewport is taller than it is wide (styles/touch.css). It is not a
    // suggestion — a portrait 4v4 shooter has no horizontal field of view and nowhere to put two thumbs. Mounted as a
    // SIBLING of the control layer, not a child of it: the layer sits at z-index 15 and the menu layer at 20, so a
    // child can never paint over the menus — and the portrait menu is exactly what the gate exists to replace.
    const rotate = document.createElement('div');
    rotate.className = 'iw-touch-rotate';
    rotate.innerHTML = '<div><i>▭</i><b>Turn your device</b><span>INKWAVE is played in landscape.</span></div>';
    parent.appendChild(rotate);
    this.rotateEl = rotate;

    this._bind();
    this._layout();
    return el;
  }

  dispose() {
    this.releaseAll();
    this.el?.remove();
    this.rotateEl?.remove();
    window.removeEventListener('pointerdown', this._onDown, true);
    window.removeEventListener('pointermove', this._onMove, true);
    window.removeEventListener('pointerup', this._onUp, true);
    window.removeEventListener('pointercancel', this._onUp, true);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onOrient);
    visualViewport?.removeEventListener?.('resize', this._onResize);
  }

  _bind() {
    this._onDown = (e) => this._down(e);
    this._onMove = (e) => this._move(e);
    this._onUp = (e) => this._up(e);
    this._onResize = () => this._layout();
    this._onOrient = () => { this.releaseAll(); this._layout(); };   // otherwise the zones move under the thumb
    // Listeners live on window but every handler bails on `pointerType !== 'touch'`, so a Bluetooth mouse on a tablet
    // stays on the normal pointer-lock path and menu taps (pointerType touch, no button hit, layer not live) pass
    // straight through — nothing here calls preventDefault outside a live match.
    window.addEventListener('pointerdown', this._onDown, true);
    window.addEventListener('pointermove', this._onMove, true);
    window.addEventListener('pointerup', this._onUp, true);
    window.addEventListener('pointercancel', this._onUp, true);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onOrient);
    visualViewport?.addEventListener?.('resize', this._onResize);
  }

  // ---- geometry --------------------------------------------------------------------------------------------------
  _layout() {
    const w = innerWidth, h = innerHeight;
    // Portrait is gated (styles/touch.css draws a "turn your device" card over everything). The card is DOM, but input
    // here is geometric hit-testing on window, which no DOM element can block — so refuse it explicitly.
    this.portrait = h > w;
    // Step unit: driven by the short edge so the cluster keeps its proportions in landscape. Floored at
    // TOUCH.minStep so targets stay thumb-sized rather than being scaled by the UI's --u, which collapses to under
    // half its design size on a phone.
    const u = (this.u = Math.max(TOUCH.minStep, Math.min(TOUCH.maxStep, Math.min(w, h) * TOUCH.stepFrac)));
    this.stickR = u * TOUCH.stickR;
    const m = Math.max(u * TOUCH.edgeSteps, TOUCH.edgeMin);   // absolute floor: the gesture-nav strip is fixed in dp, not in steps
    for (const b of this.buttons) {
      b.cx = w - m - b.ux * u;
      b.cy = b.top ? m + b.uy * u : h - m - b.uy * u;
      b.r = b.ur * u;
      b.el.style.width = b.el.style.height = `${(b.r * 2).toFixed(1)}px`;
      b.el.style.transform = `translate3d(${(b.cx - b.r).toFixed(1)}px,${(b.cy - b.r).toFixed(1)}px,0)`;
    }
    if (this.move.id === null) this._hideStick();
  }

  _btnAt(x, y) {
    for (const b of this.buttons) if (Math.hypot(x - b.cx, y - b.cy) <= b.r) return b;
    return null;
  }

  _taken(role) {
    for (const r of this.roles.values()) if (r === role) return true;
    return false;
  }

  // ---- pointer handling ------------------------------------------------------------------------------------------
  _down(e) {
    if (e.pointerType !== 'touch' || !this.input.touch.active || this.portrait) return;
    // The controls are invisible unless the layer is live, so they must be untouchable too — a hidden control that
    // still fires is how a tap lands on a button nobody can see (and, for the map latch, one that then gets wiped).
    if (!this.enabled) return;
    const b = this._btnAt(e.clientX, e.clientY);
    if (b) {
      // The fire button is also a look origin: touch it and drag, and you fire while aiming with the same thumb.
      const role = b.name === 'fire' ? 'fire' : 'btn:' + b.name;
      if (this._taken(role)) { e.preventDefault(); return; }   // a second finger on a live control is inert
      this.roles.set(e.pointerId, role);
      b.el.classList.add('is-down');
      if (b.name === 'fire') { this.look.id = e.pointerId; this.look.x = e.clientX; this.look.y = e.clientY; }
      this._press(b.name);
      e.preventDefault();                                        // also suppresses the synthesized mouse events
      return;
    }
    const inLeft = e.clientX < innerWidth * MOVE_ZONE && e.clientY > innerHeight * TOUCH.topGuard;
    if (inLeft && this.move.id === null) {
      this.roles.set(e.pointerId, 'move');
      this.move.id = e.pointerId;
      this.move.ox = e.clientX; this.move.oy = e.clientY;
      this._showStick(e.clientX, e.clientY, e.clientX, e.clientY);
    } else if (!inLeft && this.look.id === null) {
      this.roles.set(e.pointerId, 'look');
      this.look.id = e.pointerId;
      this.look.x = e.clientX; this.look.y = e.clientY;
    } else { e.preventDefault(); return; }                       // an axis is already owned: this finger is inert
    e.preventDefault();
  }

  _move(e) {
    const role = this.roles.get(e.pointerId);
    if (role === undefined) return;
    if (role === 'look' || role === 'fire') {
      // Raw pixels into the field the camera and both map cursors read. The camera applies the touch gain itself
      // (see player.js), which keeps the map cursors' existing screen-normalized feel intact.
      this.input.mouse.dx += e.clientX - this.look.x;
      this.input.mouse.dy += e.clientY - this.look.y;
      this.look.x = e.clientX; this.look.y = e.clientY;
      return;
    }
    if (role === 'move') {
      const dx = e.clientX - this.move.ox, dy = e.clientY - this.move.oy;
      const m = Math.hypot(dx, dy), r = this.stickR;
      const k = m > r ? r / m : 1;                               // clamp to the rim; no runaway past the edge
      this.move.x = (dx / r) * k; this.move.y = (dy / r) * k;
      this.input.touch.mx = this.move.x;
      this.input.touch.mz = -this.move.y;                        // screen-up is forward
      this._showStick(this.move.ox, this.move.oy, this.move.ox + dx * k, this.move.oy + dy * k);
    }
  }

  _up(e) {
    const role = this.roles.get(e.pointerId);
    if (role === undefined) return;
    this.roles.delete(e.pointerId);
    if (role === 'move') {
      this.move.id = null;
      this.input.touch.mx = 0; this.input.touch.mz = 0;
      this._hideStick();
    } else if (role === 'look' || role === 'fire') {
      if (this.look.id === e.pointerId) this.look.id = null;
      if (role === 'fire') this.input.touchUp('fire');           // pointercancel lands here too, and is a release
      for (const b of this.buttons) if (b.name === 'fire') b.el.classList.remove('is-down');
    } else if (role.startsWith('btn:')) {
      const name = role.slice(4);
      if (!NOT_LEVEL.has(name)) this.input.touchUp(name);   // a latch/one-shot is set on press and only press changes it
      for (const b of this.buttons) if (b.name === name) b.el.classList.remove('is-down');
    }
    this.input.touch.fingers = this.roles.size;
  }

  // Press side effects. `fire` is the only level that must survive past the event (it is polled per frame);
  // the movement values are written in _move. Everything else is a toggle or a one-shot.
  _press(name) {
    this.input.touch.fingers = this.roles.size;
    switch (name) {
      case 'fire': this.input.touchDown('fire'); break;
      case 'map': this.input.touchMapToggle(); this._syncMap(); break;
      case 'pause': this.input.onPause?.(); break;
      default:
        this.input.touchDown(name);
        if (EDGE_CODES[name]) this.input.pressCode(EDGE_CODES[name]);
        break;
    }
  }

  _syncMap() {
    for (const b of this.buttons) if (b.name === 'map') b.el.classList.toggle('is-on', !!this.input.touch.map);
  }

  // Drop every gesture and every held control. Called whenever the layer is invalidated: menu opened, orientation
  // changed, match ended, app backgrounded.
  releaseAll() {
    for (const b of this.buttons) b.el.classList.remove('is-down');
    this.roles.clear();
    this.move.id = null; this.look.id = null;
    this.input.touch.mx = 0; this.input.touch.mz = 0;
    this.input.touch.fingers = 0;
    this.input.touch.fire = false;
    this._hideStick();
  }

  // Force the map latch off — a menu opening must not leave it latched, or it springs back open when the menu closes.
  clearMap() { this.input.touch.map = false; this._syncMap(); }

  _showStick(ox, oy, kx, ky) {
    const st = this.stick, r = this.stickR;
    st.classList.add('is-on');
    st.style.width = st.style.height = `${(r * 2).toFixed(1)}px`;
    st.style.transform = `translate3d(${(ox - r).toFixed(1)}px,${(oy - r).toFixed(1)}px,0)`;
    this.knob.style.transform = `translate3d(${(kx - ox).toFixed(1)}px,${(ky - oy).toFixed(1)}px,0)`;
  }
  _hideStick() { this.stick?.classList.remove('is-on'); }

  // ---- per-frame -------------------------------------------------------------------------------------------------
  // Gate: a live match with no menu open. Deliberately NOT match.controller.enabled — that clears when the local
  // player is splatted, which is exactly when the map (and super-jump planning) must still work.
  update() {
    const live = G.mode === 'match' && !!G.match && !G.menus?.current && !this.portrait;
    // Arm the portrait gate only when there is something unusable underneath it — a real menu screen or a match.
    // NOT the loading screen: that is where a player looks to see whether the game is coming up at all, and covering
    // it turns "still loading" into "broken" (which is exactly what an earlier version of this gate did). The title
    // screen is left alone too — it advances on a tap anywhere, which portrait does fine.
    const cur = G.menus?.current;
    const armed = (G.mode === 'match' && !!G.match) || (!!cur && cur !== 'loading' && cur !== 'title');
    this.rotateEl?.classList.toggle('is-armed', armed);
    if (live === this.enabled) return;
    this.enabled = live;
    this.el.classList.toggle('is-live', live);
    this.releaseAll();
    if (!live) this.clearMap();     // otherwise the map latch survives and springs open on the next match
  }
}
