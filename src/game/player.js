// Local player controller: input → actor intent + camera yaw/pitch + aim point (stream 4).
//
// Look: mouse is raw 1:1 (pointer lock, unadjusted movement — no smoothing, no acceleration). Gamepad uses a radial
// dead zone, a two-stage response curve (fine control near centre, fast at the edge) and a short edge boost for quick
// turn-arounds. Aim assist (gamepad by default; settings.aimAssistMouse opts mouse in, gentler): friction slows the
// look near an enemy under the crosshair, tracking assist carries a fraction of the target's angular motion while
// you are actively aiming or moving — never an auto-snap. Bullet magnetism pulls shots onto the body line of an enemy
// the crosshair is actually touching (at the height you aimed), so hits register exactly as they look.
import * as THREE from 'three';
import { G, clamp, lerp, angleDiff } from '../core/ctx.js';
import { PLAYER, TOUCH, weaponRange } from '../config.js';
import { Physics, Hit } from './physics.js';

const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _fwd = new THREE.Vector3(), _c = new THREE.Vector3();
const _hit = new Hit();
const _res = { t: 0, dist: 0 };
const _stick = { x: 0, y: 0, mag: 0 };
const DEG = Math.PI / 180;

// fine near the centre, fast at the edge (continuous, slope-matched at the knee)
function lookCurve(m) { return m < 0.75 ? 0.62 * Math.pow(m / 0.75, 1.6) : 0.62 + ((m - 0.75) / 0.25) * 0.38; }

export class PlayerController {
  constructor(actor, rig, input) {
    this.a = actor; this.rig = rig; this.input = input;
    this.mapHeld = false;
    this.onTarget = null;
    this.inRange = false;
    this.padLook = { x: 0, y: 0 };
    this.enabled = true;
    this.edgeT = 0;
    this.assist = { target: null, yaw: 0, pitch: 0, has: false, strength: 0 };
    // Super Jump planned on the TAB map while splatted: { kind: 'ally' | 'beacon', target, name }. Picking only queues it;
    // it launches (the normal charge + flight) the moment you respawn — see launchQueuedJump(), called on 'respawn'
    this.jumpQueue = null;
  }

  update(dt) {
    const a = this.a, rig = this.rig, inp = this.input, s = G.settings;
    const it = a.intent;
    if (!this.enabled) {
      it.move.set(0, 0, 0); it.fire = it.jump = it.squid = it.sub = it.special = false;
      this.assist.has = false;
      // splatted in a live round: the TAB map still opens, to plan the Super Jump you'll take on respawn
      const m = G.match;
      const planning = !!(m && !a.alive && m.state === 'playing' && !m.paused);
      this.mapHeld = planning && (inp.down('Tab') || inp.down('KeyM') || inp.padButton(8) || inp.touch.map);
      if (planning) { this._checkQueue(); if (this.mapHeld) this._mapKeys(true); }
      else if (!m || m.state !== 'playing') this.jumpQueue = null;
      return;
    }
    const usingPad = !!inp.pad && inp.lastDevice === 'pad';
    const touch = inp.touch;
    // Touch takes the full-strength assist (the pad's tier), not the mouse's gentler opt-in: a thumb on glass is far
    // less precise than a mouse. Note `lastDevice` is deliberately NOT consulted for this — adding a third device name
    // to it would make a phone with a paired controller lose aim assist entirely the moment the screen is touched.
    const assisted = usingPad || touch.active;
    // ---- aim assist target (computed from last frame's camera; cheap)
    const as = this._assistTarget(assisted ? (s.aimAssist ?? 1) : (s.aimAssistMouse ? 0.5 : 0));
    // ---- look
    const inv = s.invertY ? -1 : 1;
    const tInv = s.touchInvertY ? -1 : 1;   // separate setting: the natural touch mapping is usually the mouse's opposite
    const friction = as ? lerp(1, 0.58, as.closeness * as.strength) : 1;
    let lookActive = false;
    const mdx = inp.mouse.dx, mdy = inp.mouse.dy;
    // Vortex Strike targeting: the mouse / right stick drives a cursor over the (opened) stage map, fire launches
    const spx = a.specialActive;
    if (spx && spx.id === 'strike' && spx.aiming) {
      const mm = G.game?.minimap;
      let cx = mdx * 0.45 * (s.sensitivity ?? 1), cy = mdy * 0.45 * (s.sensitivity ?? 1);
      if (inp.pad) { inp.padStick(2, 3, _stick, 0.12, 0.96); cx += _stick.x * 320 * dt; cy += _stick.y * 320 * dt; inp.padStick(0, 1, _stick, 0.14, 0.95); cx += _stick.x * 320 * dt; cy += _stick.y * 320 * dt; }
      if (inp.down('KeyW')) cy -= 260 * dt; if (inp.down('KeyS')) cy += 260 * dt; if (inp.down('KeyA')) cx -= 260 * dt; if (inp.down('KeyD')) cx += 260 * dt;
      G.specials.aimMove(a, cx, cy, mm);
      // launch on a fresh press (a trigger still held from shooting when the special started doesn't count)
      const pull = inp.mouse.left || inp.padValue(7) > 0.3;
      if (spx.t < 0.05) this._strikePull = pull;
      if (pull && !this._strikePull) G.specials.aimConfirm(a);
      this._strikePull = pull;
      it.move.set(0, 0, 0); it.fire = it.jump = it.squid = it.sub = it.special = false;
      this.mapHeld = false;
      return;
    }
    // while the map diorama is up the mouse / right stick steer the map cursor, not your camera
    const mapUp = (G.rig?.mapK ?? 0) > 0.05 || inp.down('Tab') || inp.down('KeyM') || inp.padButton(8) || touch.map;
    const ldx = mapUp ? 0 : mdx, ldy = mapUp ? 0 : mdy;
    if (ldx || ldy) {
      // A touch drag is bounded by the screen, so it carries its own gain (a full-width swipe has to be able to turn
      // you around) and always gets the aim-assist friction. Pointer-lock counts are unbounded and keep the 1:1 feel,
      // with friction only if aimAssistMouse opts in.
      const sens = touch.active
        ? TOUCH.lookSens * (s.touchSensitivity ?? 1) * friction
        : 0.0021 * (s.sensitivity ?? 1) * (s.aimAssistMouse ? friction : 1);
      rig.yaw -= ldx * sens;
      rig.pitch -= ldy * sens * (touch.active ? tInv : inv);
      lookActive = true;
    }
    if (inp.pad && !mapUp) {
      inp.padStick(2, 3, _stick, 0.11, 0.96);
      const ps = s.padSensitivity ?? 1;
      // edge boost: holding the stick at the rim speeds yaw up (quick 180s) after a short delay
      if (_stick.mag > 0.93) this.edgeT = Math.min(0.5, this.edgeT + dt); else this.edgeT = Math.max(0, this.edgeT - dt * 3);
      const boost = 1 + 0.55 * clamp((this.edgeT - 0.16) / 0.3, 0, 1);
      const c = _stick.mag > 0 ? lookCurve(_stick.mag) / _stick.mag : 0;
      // tiny low-pass on the stick removes sensor noise without adding felt latency (~16 ms)
      const k = 1 - Math.exp(-60 * dt);
      this.padLook.x += (_stick.x * c - this.padLook.x) * k; this.padLook.y += (_stick.y * c - this.padLook.y) * k;
      if (_stick.mag > 0) lookActive = true;
      rig.yaw -= this.padLook.x * 3.6 * ps * boost * friction * dt;
      rig.pitch -= this.padLook.y * 2.4 * ps * friction * dt * inv;
    }
    // ---- move (camera relative)
    let mx = 0, mz = 0;
    if (inp.down('KeyW') || inp.down('ArrowUp')) mz += 1;
    if (inp.down('KeyS') || inp.down('ArrowDown')) mz -= 1;
    if (inp.down('KeyA') || inp.down('ArrowLeft')) mx -= 1;
    if (inp.down('KeyD') || inp.down('ArrowRight')) mx += 1;
    if (inp.pad) { inp.padStick(0, 1, _stick, 0.14, 0.95); mx += _stick.x; mz -= _stick.y; }
    if (touch.active) { mx += touch.mx; mz += touch.mz; }   // left stick; already clamped to the rim by touch.js
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }
    // tracking assist: carry a share of the target's angular motion while the player is engaging (look or move input)
    if (as && as.prevValid && (lookActive || ml > 0.2 || it.fire)) {
      const share = 0.42 * as.strength * as.closeness;
      rig.yaw += angleDiff(as.prevYaw, as.yaw) * share;
      rig.pitch += (as.pitch - as.prevPitch) * share * 0.7;
    }
    rig.pitch = clamp(rig.pitch, -1.05, 1.15);
    a.aimYaw = rig.yaw;
    a.aimPitch = rig.pitch;
    const sy = Math.sin(rig.yaw), cy = Math.cos(rig.yaw);
    // forward = (sy, 0, cy); right = (-cy, 0, sy)
    it.move.set(sy * mz - cy * mx, 0, cy * mz + sy * mx);

    it.jump = inp.down('Space') || inp.padButton(0) || inp.touchHeld('jump');
    it.squid = inp.down('ShiftLeft') || inp.down('ShiftRight') || inp.padValue(6) > 0.3 || inp.touchHeld('squid');
    it.fire = inp.mouse.left || inp.padValue(7) > 0.3;
    it.sub = inp.mouse.right || inp.down('KeyE') || inp.padButton(5);
    it.special = inp.down('KeyF') || inp.down('KeyQ') || inp.padButton(3) || inp.padButton(11) || inp.touchHeld('special');
    this.mapHeld = inp.down('Tab') || inp.down('KeyM') || inp.padButton(8) || touch.map;
    // "Yeah!" signal (C / d-pad up outside the map): cheers on a teammate's Cheer Orb
    if (inp.wasPressed('KeyC') || (!this.mapHeld && inp.padPressed.has(12))) it.cheer = true;
    // the TAB map is a targeting UI (clicking a teammate beacon super jumps) — never fire or throw through it
    if (this.mapHeld) { it.fire = false; it.sub = false; }
    // super jump: while the map is open, 1-3 (or d-pad left/up/right) jumps to that teammate, 4 / d-pad down to spawn
    if (this.mapHeld && a.canSuperJump()) this._mapKeys(false);

    // ---- aim point from the camera centre ray
    this.computeAim();
  }

  // TAB-map number keys / d-pad: 1–3 teammates, 4 base, 5–9 + 0 team jump beacons (oldest first, as the map lists
  // them). Alive: jump now. Splatted (queue = true): plan the jump for the respawn instead — it never launches early.
  _mapKeys(queue) {
    const a = this.a, inp = this.input;
    const allies = G.actors.filter((o) => o.team === a.team && o !== a);
    const pick = (kind, target) => {
      if (queue) { this.queueJump(kind, target); return; }
      if (kind === 'ally') { if (target && target.alive && !target.superJumpState) a.superJump(target); }
      else if (kind === 'base') a.superJump(G.level.spawnPads[a.team].clone());
      else G.subs.jumpToBeacon(a, target);
    };
    if (inp.wasPressed('Digit1') || inp.padPressed.has(14)) pick('ally', allies[0]);
    if (inp.wasPressed('Digit2') || inp.padPressed.has(12)) pick('ally', allies[1]);
    if (inp.wasPressed('Digit3') || inp.padPressed.has(15)) pick('ally', allies[2]);
    if (inp.wasPressed('Digit4') || inp.padPressed.has(13)) pick('base', null);
    if (G.subs) {
      const bs = G.subs.beaconsFor(a.team).sort((x, y) => x.born - y.born);
      for (let k = 0; k < Math.min(6, bs.length); k++) if (inp.wasPressed('Digit' + ((k + 5) % 10))) pick('beacon', bs[k]);
    }
  }

  // ---- Super Jump planned while splatted -------------------------------------------------------------------------
  // Queue (or change) the jump for the respawn. kind 'base' clears the plan: you drop in at base anyway. A splatted
  // teammate can't be picked (they come back at base); one mid Super Jump can (you land where they come down).
  // Returns true when the pick was taken. Never jumps: the actor is splatted.
  queueJump(kind, target) {
    const a = this.a;
    if (a.alive) return false;
    let q = null;
    if (kind === 'ally') { if (target && target.team === a.team && target !== a && target.alive) q = { kind, target, name: target.name }; }
    else if (kind === 'beacon') { if (target && target.state === 'beacon' && target.team === a.team) q = { kind, target, name: target.owner === a ? 'Your beacon' : `${target.owner?.name || 'Team'}'s beacon` }; }
    if (kind === 'base') {
      const had = !!this.jumpQueue;
      this.jumpQueue = null;
      G.audio?.play(had ? 'ui_back' : 'ui_click', { volume: 0.5 });
      return true;
    }
    if (!q) { G.audio?.play('ui_error', { volume: 0.5 }); return false; }
    const same = this.jumpQueue && this.jumpQueue.target === q.target;
    this.jumpQueue = q;
    G.audio?.play('ui_confirm', { volume: same ? 0.35 : 0.6 });
    return true;
  }

  // is the planned target still there? (teammate alive, beacon standing)
  _queueGone(q) {
    if (!q) return null;
    if (q.kind === 'ally') return q.target && q.target.alive ? null : `${q.name} was splatted`;
    if (q.kind === 'beacon') return q.target && q.target.state === 'beacon' ? null : 'The jump beacon is gone';
    return null;
  }

  // while splatted: a planned target that goes down is dropped straight away (so you can pick again)
  _checkQueue() {
    const why = this._queueGone(this.jumpQueue);
    if (!why) return;
    this.jumpQueue = null;
    G.hud?.jumpNote?.(`${why} — Super Jump cancelled`);
    G.audio?.play('ui_error', { volume: 0.45 });
  }

  // On respawn (main.js 'respawn' handler): launch the planned jump through the normal Super Jump (charge + flight).
  // A target that's gone by now cancels it with a short note. Returns true if a jump started.
  launchQueuedJump() {
    const q = this.jumpQueue, a = this.a;
    if (!q || !a.alive) return false;   // (still splatted: the plan stays)
    this.jumpQueue = null;
    const why = this._queueGone(q);
    let ok = false;
    if (!why) ok = q.kind === 'beacon' ? !!G.subs?.jumpToBeacon(a, q.target) : a.superJump(q.target);
    if (!ok) { G.hud?.jumpNote?.(`${why || 'Can’t Super Jump right now'} — Super Jump cancelled`); G.audio?.play('ui_error', { volume: 0.45 }); }
    return ok;
  }

  // Best enemy near the crosshair for aim assist (angular cone scaled so it covers ~a body width at any range).
  _assistTarget(strength) {
    const as = this.assist;
    const a = this.a, cam = G.camera;
    if (!(strength > 0) || !cam) { as.has = false; as.target = null; return null; }
    const fwd = cam.getWorldDirection(_fwd);
    const w = a.weapon;
    const maxR = Math.min(32, weaponRange(w) * 1.15 + 2);
    let best = null, bestScore = Infinity, bYaw = 0, bPitch = 0, bClose = 0;
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive || e.anim.form === 'swim' || e.invuln > 0) continue;
      _c.set(e.pos.x, e.pos.y + (e.smoothY || 0) + (e.form === 'squid' ? 0.3 : 0.95), e.pos.z);
      _v.copy(_c).sub(cam.position);
      const d = _v.length();
      if (d > maxR + 4 || d < 0.5) continue;
      if (a.pos.distanceTo(e.pos) > maxR) continue;
      _v.multiplyScalar(1 / d);
      const ang = Math.acos(clamp(_v.dot(fwd), -1, 1));
      const cone = clamp(Math.atan2(1.0, d), 2.5 * DEG, 10 * DEG);
      if (ang > cone) continue;
      if (!G.physics.los(cam.position, _c)) continue;
      const score = ang / cone + d * 0.01;
      if (score < bestScore) { bestScore = score; best = e; bYaw = Math.atan2(_v.x, _v.z); bPitch = Math.asin(clamp(_v.y, -1, 1)); bClose = 1 - ang / cone; }
    }
    if (!best) { as.has = false; as.target = null; return null; }
    as.prevValid = as.has && as.target === best;
    as.prevYaw = as.yaw; as.prevPitch = as.pitch;
    as.target = best; as.yaw = bYaw; as.pitch = bPitch; as.closeness = clamp(bClose * 1.3, 0, 1); as.strength = strength; as.has = true;
    return as;
  }

  computeAim() {
    // the gameplay view — while the map diorama is up the rendered camera is overhead, aim stays with the player
    const a = this.a, cam = G.rig?.gameCam || G.camera;
    const fwd = cam.getWorldDirection(_fwd);
    // start the ray level with the player so geometry between camera and player is ignored
    _v.copy(a.pos); _v.y += 1.3;
    const along = Math.max(0, _v.sub(cam.position).dot(fwd));
    const start = _v2.copy(cam.position).addScaledVector(fwd, along);
    const hit = G.physics.raycast(start, fwd, 70, _hit, true);
    const dist = hit.hit ? hit.dist : 70;
    a.aimPoint.copy(start).addScaledVector(fwd, dist);
    // enemy under the crosshair? (visual body, generous by 0.2 m)
    this.onTarget = null;
    let best = dist, bestT = 0;
    const reach = Math.min(dist, 34);
    const end = _v.copy(start).addScaledVector(fwd, reach);
    for (const e of G.actors) {
      if (e.team === a.team || !e.alive) continue;
      if (e.anim.form === 'swim') continue;
      _c.set(e.pos.x, e.pos.y + (e.smoothY || 0), e.pos.z);
      Physics.segmentCapsuleDist(start, end, _c, PLAYER.radius, e.form === 'squid' ? PLAYER.squidHeight : PLAYER.height, _res);
      if (_res.dist < PLAYER.radius + 0.2) {
        const d = _res.t * reach;
        if (d < best) { best = d; bestT = _res.t; this.onTarget = e; }
      }
    }
    // boss mode: the crosshair stops on HULLBREAKER's shell (lobs land on it, the reticle lights up)
    if (G.boss) {
      const bd = G.boss.rayDist(start, fwd, best);
      if (bd > 0 && bd < best) { this.onTarget = G.boss; a.aimPoint.copy(start).addScaledVector(fwd, bd); }
    }
    if (this.onTarget && this.onTarget !== G.boss) {
      // bullet magnetism: converge on the enemy's body axis at the height the crosshair crosses it
      const e = this.onTarget;
      const h = e.form === 'squid' ? PLAYER.squidHeight : PLAYER.height;
      const py = start.y + fwd.y * best;
      const baseY = e.pos.y + (e.smoothY || 0);
      a.aimPoint.set(e.pos.x, clamp(py, baseY + 0.2, baseY + h - 0.12), e.pos.z);
    }
    // is the crosshair point inside the weapon's effective range? (HUD reticle state)
    const w = a.weapon;
    const range = weaponRange(w);
    this.inRange = a.aimPoint.distanceTo(a.pos) <= range + 0.5;
  }
}
