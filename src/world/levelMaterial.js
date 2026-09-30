// Level surface material: MeshPhysicalMaterial + injected procedural surface patterns and the wet ink layer.
import * as THREE from 'three';
import { STAGE_SURFACES, FIRST_STAGE_SLOT, LAST_STAGE_SLOT } from './stages/surfaces.js';
import { TEXLIB_GLSL } from './texlib.js';
import { G } from '../core/ctx.js';
import { inkUniforms, inkBeforeRender, INK_PARS, INK_COLOR, INK_ROUGH, INK_GEL, INK_SLOPE, INK_EMISSIVE, INK_LIGHTS, INK_LIGHT_MAPS, INK_SHADE } from './inkShading.js';

// Street lamps light the deck at dusk: each bulb is a real punctual light through the material's own BRDF (diffuse +
// the ink's wet coat, so fresh ink glints under a lamp), windowed to a few metres and culled per pixel in world space
// (only fragments inside a pool pay for it). No shadows: the pools are soft and the bulbs sit over open deck.
const MAX_LAMPS = 12, LAMP_R = 10, LAMP_HEX = '#ffc48a', LAMP_I = 16;
const LAMP_LIGHTS = /* glsl */`
for (int i = 0; i < ${MAX_LAMPS}; i++) {
  if (i >= uLampN) break;
  vec3 lw = uLamps[i] - vWPos;
  float d2 = dot(lw, lw);
  if (d2 > ${(LAMP_R * LAMP_R).toFixed(2)}) continue;
  float w = clamp(1.0 - d2 * d2 / ${(LAMP_R ** 4).toFixed(1)}, 0.0, 1.0);
  IncidentLight lampL;
  lampL.direction = normalize((viewMatrix * vec4(lw, 0.0)).xyz);
  lampL.color = uLampCol * (w * w / max(d2, 0.35));
  lampL.visible = true;
  RE_Direct(lampL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
}`;

// Bulb positions of the stage's street lamps (same placement rule as decor.js _buildLamps: mirrored pairs, the arm
// reaching 0.92 m toward the arena centre, bulb 4.9 m up) → uniforms; k = environment night factor (0 = off).
export function setLevelLamps(mat, level, k = 0) {
  const u = mat && mat.userData && mat.userData.uniforms;
  if (!u || !u.uLamps) return;
  const L = (level && level.layout && level.layout.decor && level.layout.decor.lamps) || [];
  const pts = k > 0.01 ? [...L, ...L.map(([x, z]) => [-x, -z])].slice(0, MAX_LAMPS) : [];
  pts.forEach(([x, z], i) => u.uLamps.value[i].set(x + 0.92 * (x > 0 ? -1 : 1), Math.max(0, level.groundHeight(x, z)) + 4.9, z));
  u.uLampN.value = pts.length;
  u.uLampCol.value.set(LAMP_HEX).multiplyScalar(LAMP_I * k);
}

export function createLevelMaterial(paintTexture, atlasSize, muralTexture = null, opts = {}) {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.08,
    envMapIntensity: 0.9,
  });
  const uniforms = {
    uPaint: { value: paintTexture },
    uTexel: { value: 1 / atlasSize },
    uTeamA: { value: new THREE.Color('#ff8a14') },
    uTeamB: { value: new THREE.Color('#2f5bff') },
    uTime: { value: 0 },
    uInkGlow: { value: 0.06 },
    uMural: { value: muralTexture },
    uLight: { value: opts.lightmap || null },
    uSeeA: { value: new THREE.Vector3() },   // camera position
    uSeeB: { value: new THREE.Vector3() },   // player chest
    uSeeOn: { value: 0 },
    uSeeFeet: { value: 0 },                  // local player's feet height (set per draw below)
    uSeeA2C: { value: 0 },                   // 1 when drawing into a multisampled target (alpha-to-coverage fade)
    uAO: { value: opts.lightmap ? 1.0 : 0.0 },
    // dusk lamp pools (setLevelLamps, driven by main._applyNight): bulb positions (world) + warm colour × strength
    uLamps: { value: Array.from({ length: MAX_LAMPS }, () => new THREE.Vector3()) }, uLampN: { value: 0 }, uLampCol: { value: new THREE.Color(0, 0, 0) },
    uAtlasSize: { value: atlasSize },
    uPpm: { value: opts.ppm || 20 },          // atlas texels per metre (from the paint system, set per draw)
    ...inkUniforms(),                        // wet-ink layer (inkShading.js): paint clock + ripple table
    uGel: { value: 13 },                      // texlib layer of the ink gel micro-surface
    // swim wakes (src/fx/swimWake.js): 4 swimmers × 12-point trails (xyz, birth time; w < -1 = empty/break),
    // per-swimmer bounds (xyz centre, radius; 0 = off), head position + presence, head direction + speed
    uWake: { value: Array.from({ length: 48 }, () => new THREE.Vector4(0, 0, 0, -9)) },
    uWakeB: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, -999, 0, 0)) },
    uSwimH: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, -999, 0, 0)) },
    uSwimF: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 1, 0)) },
  };
  // Texture library: one slot per PATTERN id (maps.js) → uTL (layer, 1/scale, anti-tiling mode, sym) and uTLt (tint
  // mode, normal strength, slot used on vertical faces, slot used on top faces). Tint mode 0 = own colours, 1 = albedo x
  // block colour, 2 = premultiplied paint mask (albedo.rgb + block colour x albedo.a x 1.25, see texlib 'mask').
  // The last slot (TL_SIDE) = concrete, used for the vertical sides of ramps / asphalt / boatyard slabs.
  const lib = opts.texlib || null;
  if (lib) {
    const L = lib.layers, M = lib.meta;
    const map = ['concrete', 'pavers', 'tiles', 'concrete', 'rubber', 'corrugated', 'boardwalk', 'metalpanel', 'tiles', 'concrete',
      'asphalt', 'metalpanel', 'grate', 'brick', 'rubber', 'glasstile', 'pavers',
      /* 17 planks … 23 render (marina set) */ 'planks', 'hullpaint', 'nonslip', 'gelcoat', 'yard', 'weatherboard', 'render',
      /* 24 treads … 27 gangdeck (stairs + ramps) */ 'treads', 'stonestep', 'rampboard', 'gangdeck',
      /* 28 … LAST_STAGE_SLOT: stage-owned surfaces (stages/<id>/surfaces.js), concrete where a slot is unused */
      ...Array.from({ length: LAST_STAGE_SLOT - FIRST_STAGE_SLOT + 1 }, (_, k) => (STAGE_SURFACES.find((s) => s.slot === FIRST_STAGE_SLOT + k) || { name: 'concrete' }).name),
      /* TL_SIDE */ 'concrete'];
    const SIDE = map.length - 1;
    // ramp / asphalt / yard sides → concrete; car-deck edge → hull plating; stair / ramp sides → steel stringer plating,
    // rendered cheek wall, timber skirting, painted steel
    const onWall = { 4: SIDE, 10: SIDE, 21: SIDE, 19: 18, 24: 18, 25: 23, 26: 17, 27: 11 };
    const onTop = { 20: 17 };                                  // gelcoat hulls get a planked deck on top
    for (const s of STAGE_SURFACES) { if (s.onWall != null) onWall[s.slot] = s.onWall; if (s.onTop != null) onTop[s.slot] = s.onTop; }
    uniforms.tAlbedo = { value: lib.albedo };
    uniforms.tNormal = { value: lib.normal };
    uniforms.tOrm = { value: lib.orm };
    uniforms.uTexSize = { value: lib.stats?.size || 512 };
    // The three per-slot tables live in ONE float texture, not three uniform arrays.
    //
    // GLSL ES rounds every array element up to a full vec4 uniform slot whatever its type, so `uTL[50] + uTLt[50] +
    // uTLs[50]` alone cost 150 of a phone's 256 fragment uniform vectors. Add the wake (60), mural (36) and lamp (12)
    // tables and the level shader went over the limit and FAILED TO LINK on an Adreno 730 — the ground and the sea
    // simply were not drawn, while a desktop GPU (1024 slots) never showed a symptom. A texture costs one sampler.
    //
    // Rows: 0 = uTL (layer, 1/scale, anti-tiling mode, sym), 1 = uTLt (tint mode, grate, onWall, onTop), 2 = uTLs (stair).
    const tlRows = [
      map.map((n) => [L[n] ?? 0, 1 / ((M[n] && M[n].scale) || 4), (M[n] && M[n].mode) ?? 1, (M[n] && M[n].sym) ?? 7]),
      map.map((n, i) => [M[n] && M[n].mask ? 2 : (M[n] && M[n].tint === false ? 0 : 1), n === 'grate' ? 0.6 : 1.0, onWall[i] ?? i, onTop[i] ?? i]),
      map.map((n) => { const st = (M[n] && M[n].stair) || [0, 0, 0, 0]; return [st[0], st[1], st[2], st[3]]; }),
    ];
    const tlData = new Float32Array(map.length * 3 * 4);
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < map.length; i++) {
        const o = (row * map.length + i) * 4, r = tlRows[row][i];
        tlData[o] = r[0]; tlData[o + 1] = r[1]; tlData[o + 2] = r[2]; tlData[o + 3] = r[3];
      }
    }
    const tlTex = new THREE.DataTexture(tlData, map.length, 3, THREE.RGBAFormat, THREE.FloatType);
    tlTex.magFilter = tlTex.minFilter = THREE.NearestFilter;   // exact texel fetch: no interpolation, no mips
    tlTex.generateMipmaps = false;
    tlTex.needsUpdate = true;
    uniforms.uTLTex = { value: tlTex };
    uniforms.uGel.value = L.gel ?? -1;
    mat.defines = { ...(mat.defines || {}), USE_TEXLIB: 1, TL_SLOTS: map.length };
  }
  // Mural / signage table (murals.js → texture.userData.murals, indexed by mural id): atlas rect, placement on the face
  // (metres), weathering. Without a table: the original four 8:1 strips.
  {
    const MUR = 12;
    const rows = (muralTexture && muralTexture.userData && muralTexture.userData.murals) || [0, 1, 2, 3].map((id) => ({ rect: [0, 1, (3 - id) / 4, 1 / 4], place: [0, -8, 0, 0] }));
    uniforms.uMurA = { value: Array.from({ length: MUR }, (_, i) => new THREE.Vector4(...((rows[i] && rows[i].rect) || [0, 1, 0, 0.25]))) };
    uniforms.uMurB = { value: Array.from({ length: MUR }, (_, i) => new THREE.Vector4(...((rows[i] && rows[i].place) || [0, -8, 0, 0]))) };
    uniforms.uMurC = { value: Array.from({ length: MUR }, (_, i) => new THREE.Vector2(...((rows[i] && rows[i].fx) || [0, 0]))) };
  }
  mat.userData.uniforms = uniforms;
  // see-through window: feet height of the local player + whether this draw is multisampled (main.js drives the rest)
  mat.alphaToCoverage = true;
  mat.onBeforeRender = (renderer) => {
    const loc = G.match && !G.match.attract ? G.match.local : null;
    uniforms.uSeeFeet.value = loc ? loc.pos.y : uniforms.uSeeB.value.y - 1.0;
    const rt = renderer.getRenderTarget();
    uniforms.uSeeA2C.value = rt && rt.samples > 0 ? 1 : 0;
    // paint system: atlas density, paint clock + ripples (inkShading.js)
    const P = opts.paint || G.paint;
    if (P && P.texture === uniforms.uPaint.value) {
      uniforms.uPpm.value = P.ppm;
      inkBeforeRender(uniforms, P);
    }
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 paintUv;
attribute vec2 faceUv;
attribute vec4 faceData;
attribute vec3 faceFlags;
attribute vec3 faceTan;
attribute vec2 lightUv;
varying vec2 vLightUv;
varying vec3 vFaceTan;
varying vec2 vPaintUv;
varying vec2 vFaceUv;
varying vec4 vFaceData;
varying vec3 vFaceFlags;
varying vec3 vWPos;
varying vec3 vWNorm;`)
      .replace('#include <project_vertex>', `#include <project_vertex>
vPaintUv = paintUv; vFaceUv = faceUv; vFaceData = faceData; vFaceFlags = faceFlags;
vFaceTan = normalize(mat3(modelMatrix) * faceTan);
vLightUv = lightUv;
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNorm = normalize(mat3(modelMatrix) * objectNormal);`);

    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uPaint;
uniform float uTexel;
uniform vec3 uTeamA;
uniform vec3 uTeamB;
uniform float uTime;
uniform float uInkGlow;
uniform sampler2D uMural;
uniform sampler2D uLight;
uniform float uAO;
uniform vec3 uLamps[${MAX_LAMPS}];
uniform int uLampN;
uniform vec3 uLampCol;
uniform vec3 uSeeA;
uniform vec3 uSeeB;
uniform float uSeeOn;
uniform float uSeeFeet;
uniform float uSeeA2C;
uniform float uAtlasSize;
uniform float uPpm;
uniform float uGel;
uniform vec4 uWake[48];
uniform vec4 uWakeB[4];
uniform vec4 uSwimH[4];
uniform vec4 uSwimF[4];
varying vec2 vLightUv;
varying vec3 vFaceTan;
varying vec2 vPaintUv;
varying vec2 vFaceUv;
varying vec4 vFaceData;
varying vec3 vFaceFlags;
varying vec3 vWPos;
varying vec3 vWNorm;

float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return s; }
// anti-aliased grid line: returns 1 on the line
float gridLine(float x, float period, float width) {
  float fx = abs(fract(x / period + 0.5) - 0.5) * period;
  float w = fwidth(x) * 0.75;
  return 1.0 - smoothstep(width - w, width + w, fx);
}
${INK_PARS}
vec2 fsz0(vec4 fd) { return fd.zw; }
#ifdef USE_TEXLIB
precision highp sampler2DArray;
uniform sampler2DArray tAlbedo;
uniform sampler2DArray tNormal;
uniform sampler2DArray tOrm;
uniform float uTexSize;
uniform sampler2D uTLTex;   // the uTL / uTLt / uTLs tables as one float texture (row 0 / 1 / 2) — see createLevelMaterial
vec4 tlSlot(int i, int row) {
  return texture2D(uTLTex, vec2((float(i) + 0.5) / float(TL_SLOTS), (float(row) + 0.5) / 3.0));
}
${TEXLIB_GLSL}
#endif
uniform vec4 uMurA[12];
uniform vec4 uMurB[12];
uniform vec2 uMurC[12];
vec3 gTexMod = vec3(1.0);   // surface albedo modulation (≈ 1 mean) + paint coverage, for weathered murals
float gTexPaint = 1.0;
vec3 gTexN = vec3(0.0, 0.0, 1.0);
vec4 gTexORM = vec4(1.0, 0.8, 0.0, 0.5);
float gTexStr = 0.0;
vec4 gStair = vec4(0.0);    // stair / ramp top: distance across from one side (m), width (m), edge kind, step coordinate
float gTexKeep = 0.0;       // share of the texture relief kept under ink (stairs keep their steps)
float gTexAlpha = 1.0;
float gInk = 0.0;
vec3 gInkCol = vec3(0.0);
float gBaseRough = 0.8;
float gInkH = 0.0;
vec2 gInkD = vec2(0.0);
float gRib = 0.0;
float gFresh = 0.0;
float gInkNear = 0.0;
float gInkS = 0.0;
float gWake = 0.0;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  // see-through: geometry in front of the local player that overlaps their on-screen silhouette dissolves, so low
  // cover never hides your character. The window is a capsule in screen space around the body (feet → head) with a
  // soft edge; only fragments clearly in front of the player dissolve (never anything behind them), and floors /
  // platform sides at or below the player's feet are never cut (no holes under you).
  // With MSAA the fade uses alpha-to-coverage (sub-pixel, smooth); without it an 8×8 ordered dither + discard.
  diffuseColor.a = 1.0;
  if (uSeeOn > 0.001) {
    vec3 Bv = (viewMatrix * vec4(uSeeB, 1.0)).xyz;
    float dB = -Bv.z, dP = vViewPosition.z;
    if (dB > 0.6 && dP < dB - 0.2) {
      float bodyH = uSeeB.y - uSeeFeet;                        // kid ≈ 1.0, squid ≈ 0.4
      vec3 Fv = (viewMatrix * vec4(uSeeB.x, uSeeFeet + 0.05, uSeeB.z, 1.0)).xyz;
      vec3 Hv = (viewMatrix * vec4(uSeeB.x, uSeeFeet + bodyH * 1.42 + 0.06, uSeeB.z, 1.0)).xyz;
      vec2 p = -vViewPosition.xy / dP, f = Fv.xy / max(-Fv.z, 0.05), h = Hv.xy / max(-Hv.z, 0.05);
      vec2 fh = h - f;
      float t = clamp(dot(p - f, fh) / max(dot(fh, fh), 1e-8), 0.0, 1.0);
      float sd = length(p - (f + fh * t)) * dB;                  // metres, measured at the player's distance
      float R = mix(0.3, 0.46, clamp(bodyH, 0.0, 1.0));          // body half-width + margin
      float k = 1.0 - smoothstep(R, R + 0.42, sd);
      k *= smoothstep(dB - 0.2, dB - 0.75, dP);                  // only well in front of the player
      // never cut floors at the player's feet, nor the sides of the platform they stand on
      float feetTop = uSeeFeet + 0.3;
      if (vWNorm.y > 0.6 && vWPos.y < feetTop) k = 0.0;
      if (abs(vWNorm.y) < 0.6 && vWPos.y + max(vFaceData.w - vFaceUv.y, 0.0) * 0.9 < feetTop) k = 0.0;
      k *= uSeeOn;
      if (k > 0.002) {
        ivec2 q = ivec2(gl_FragCoord.xy) & 7;
        int xy = q.x ^ q.y;
        float bay = (float(((xy & 1) << 5) | ((q.x & 1) << 4) | ((xy & 2) << 2) | ((q.x & 2) << 1) | ((xy & 4) >> 1) | ((q.x & 4) >> 2)) + 0.5) / 64.0;
        // alpha-to-coverage gives 4 levels per pixel; a small ordered offset fills the steps in between, tapered so
        // the open centre and the untouched rim stay perfectly clean (no screen-door grain over the character)
        float a = 1.0 - k;
        if (uSeeA2C > 0.5) diffuseColor.a = clamp(a + (bay - 0.5) * 0.25 * smoothstep(0.0, 0.2, a) * smoothstep(1.0, 0.8, a), 0.0, 1.0);
        else if (k > bay * 0.98 + 0.01) discard;
      }
    }
  }
  vec2 fu = vFaceUv;
  float pattern = vFaceData.x;
#ifdef GRATE
  // bar grating: 4 cm bars on a 7 cm pitch one way, 2 cm cross-bars every 20 cm; holes are cut out
  {
    float gw = fwidth(fu.x) + 1e-4;
    float bx = 1.0 - smoothstep(0.02 - gw, 0.02 + gw, abs(fract(fu.x / 0.07 + 0.5) - 0.5) * 0.07);
    float by = 1.0 - smoothstep(0.01 - gw, 0.01 + gw, abs(fract(fu.y / 0.2 + 0.5) - 0.5) * 0.2);
    float edge = 1.0 - smoothstep(0.05, 0.06, min(min(fu.x, fsz0(vFaceData).x - fu.x), min(fu.y, fsz0(vFaceData).y - fu.y)));
    float solid = max(max(bx, by), edge);
    if (abs(vWNorm.y) < 0.5) solid = 1.0;
    if (solid < 0.5) discard;
  }
#endif
  vec2 fsz = vFaceData.zw;
  vec3 base = diffuseColor.rgb;
  float rough = 0.82;
  float big = fbm(vWPos.xz * 0.18 + vWPos.y * 0.1);
  float fine = vnoise(fu * 9.0);
#ifdef USE_TEXLIB
  {
    int pid = int(pattern + 0.5);
    bool vertical = abs(vWNorm.y) < 0.5;
    // per-slot remaps: ramp / asphalt / yard sides → concrete, car-deck edge → plating, gelcoat tops → planks
    if (vertical) pid = int(tlSlot(pid, 1).z + 0.5); else if (vWNorm.y > 0.5) pid = int(tlSlot(pid, 1).w + 0.5);
    vec4 tl = tlSlot(pid, 0); vec4 tt = tlSlot(pid, 1);
    // stairs / ramps: sample in the ramp's own frame — u across, v downhill from the top landing — with v phase-locked so
    // a whole number of steps fits the visible flight (the slab runs 0.6 m on under the floor at its low end, level.js)
    vec2 tuv = fu * tl.y;
    vec4 sp = tlSlot(pid, 2);
    vec2 tA = vec2(1.0, 0.0), tD = vec2(0.0, 1.0);
    if (sp.x > 0.0 && vWNorm.y > 0.5) {
      bool alongU = abs(vFaceTan.y) > 0.02;                                   // x-running ramps: face u runs up/down the slope
      float sg = alongU ? sign(vFaceTan.y) : sign(vWNorm.z * vFaceTan.x - vWNorm.x * vFaceTan.z);   // uphill = +axis?
      float fa = alongU ? fu.x : fu.y, fcr = alongU ? fu.y : fu.x;
      float La = alongU ? fsz.x : fsz.y, Wd = alongU ? fsz.y : fsz.x;
      float dTop = sg > 0.0 ? La - fa : fa;
      if (dTop > La - 0.3) { sg = -sg; dTop = La - dTop; }                   // bevel past the crest: visible fragments never sit in the buried tail
      float Lv = max(La - 0.6, sp.x);
      float Ps = Lv / max(1.0, floor(Lv / sp.x + 0.5));
      tuv = vec2(fcr * tl.y, dTop / (Ps * sp.y));
      tA = alongU ? vec2(0.0, 1.0) : vec2(1.0, 0.0);
      tD = alongU ? vec2(-sg, 0.0) : vec2(0.0, -sg);
      gStair = vec4(fcr, Wd, sp.w, dTop / Ps);
      gTexKeep = sp.z;
    }
    TexlibSample ts = texlibSample(tAlbedo, tNormal, tOrm, tuv, tl.x, int(tl.z), int(tl.w));
    ts.normal = vec3(ts.normal.x * tA + ts.normal.y * tD, ts.normal.z);      // back into the face's (u, v) frame
    base = tt.x > 1.5 ? ts.albedo.rgb + diffuseColor.rgb * ts.albedo.a * 1.25
         : (tt.x > 0.5 ? diffuseColor.rgb * ts.albedo.rgb * 1.25 : ts.albedo.rgb);
    base *= texlibMacro(vWPos.xz + vWPos.y * 0.7);
    base *= mix(1.0, ts.orm.r, 0.85);                            // cavity occlusion in grout / seams / grooves
    gTexMod = (tt.x > 1.5 ? vec3(ts.albedo.a * 1.25) : (tt.x > 0.5 ? ts.albedo.rgb * 1.25 : vec3(1.0))) * mix(1.0, ts.orm.r, 0.85);
    gTexPaint = tt.x > 1.5 ? clamp(ts.albedo.a * 1.45, 0.0, 1.0) : 1.0;
    rough = ts.orm.g;
    gTexN = ts.normal; gTexORM = ts.orm; gTexStr = tt.y; gTexAlpha = ts.albedo.a;
    #ifdef GRATE
      if (texlibCoverage(ts.albedo.a, fu * tl.y, uTexSize) < 0.5 && !vertical) discard;
    #endif
  }
  if (pattern < 0.5) {
  } else if (pattern < 1.5) {
    // court markings over the pavers
    float rr = length(vWPos.xz);
    float wr = fwidth(rr);
    float mark = 1.0 - smoothstep(0.09 - wr, 0.09 + wr, abs(rr - 9.5));
    float wz = fwidth(vWPos.z);
    mark = max(mark, (1.0 - smoothstep(0.07 - wz, 0.07 + wz, abs(vWPos.z))) * step(9.5, abs(vWPos.x)));
    mark *= 0.75 + 0.25 * step(0.35, vnoise(vWPos.xz * 6.0));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.97, 0.96, 0.92), mark * 0.9);
  } else if (pattern > 3.5 && pattern < 4.5) {
    float edge = 1.0 - smoothstep(0.16, 0.2, min(fu.x, fsz.x - fu.x));
    if (vWNorm.y > 0.5) { base = mix(base, vec3(0.93, 0.72, 0.12), edge * 0.95); rough = mix(rough, 0.6, edge); }
  } else if (pattern > 7.5 && pattern < 8.5) {
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float band = 1.0 - smoothstep(0.34, 0.36, e);
    float chev = step(0.5, fract((fu.x + fu.y) * 1.6));
    if (vWNorm.y > 0.5) base = mix(base, mix(vec3(0.95, 0.76, 0.1), vec3(0.12), chev), band * step(0.05, e));
  } else if (pattern > 8.5 && pattern < 9.5) {
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float bed = smoothstep(0.24, 0.27, e) * step(0.5, vWNorm.y);
    vec3 grass = vec3(0.32, 0.55, 0.22) * (0.8 + 0.35 * fbm(fu * 6.0));
    base = mix(base, grass, bed);
    rough = mix(rough, 0.95, bed);
    gTexStr *= 1.0 - bed;
  }
  // ---- modelled detail (shader-only, no layout change) ----
  {
    int pid = int(pattern + 0.5);
    vec2 wp = vWPos.xz;
    float ef = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    bool isTop = vWNorm.y > 0.6;
    bool isWall = abs(vWNorm.y) < 0.5;
    // floors: soft grime patches, sun-bleached warm areas and smoother traffic-polished patches (sheen at grazing sun)
    if (isTop && (pid == 1 || pid == 16 || pid == 10 || pid == 2 || pid == 8 || pid == 17 || pid == 19 || pid == 21)) {
      float m1 = vnoise(wp * 0.09 + 5.3), m2 = vnoise(wp * 0.31 + 1.7), m3 = vnoise(wp * 1.3);
      float grime = smoothstep(0.52, 0.86, m1 * 0.65 + m2 * 0.35);
      base *= 1.0 - 0.075 * grime * (0.7 + 0.3 * m3);
      base *= mix(vec3(1.0), vec3(1.025, 1.005, 0.965), smoothstep(0.42, 0.12, m1));
      rough = mix(rough, rough * 0.72, smoothstep(0.62, 0.9, m2) * 0.7);
    }
    // stone coping on exposed tops of walls / platforms / parapets, with a drip-groove shadow under the cap
    if (pid == 0 || pid == 2 || pid == 3 || pid == 13 || pid == 15 || pid == 16 || pid == 23) {
      float cop = 0.0, groove = 0.0;
      float cw = mix(0.2, 0.26, step(3.0, min(fsz.x, fsz.y)));
      if (isTop) {
        cop = min(fsz.x, fsz.y) < 1.15 ? 1.0 : 1.0 - smoothstep(cw - 0.008, cw + 0.008, ef);
        groove = (1.0 - smoothstep(0.004, 0.012, abs(ef - cw))) * step(1.15, min(fsz.x, fsz.y));
      } else if (isWall && vFaceFlags.x > 0.5) {
        float dt = fsz.y - fu.y;
        cop = 1.0 - smoothstep(0.1, 0.108, dt);
        groove = 1.0 - smoothstep(0.005, 0.016, abs(dt - 0.118));
      }
      vec3 stone = vec3(0.9, 0.885, 0.845) * (0.95 + 0.07 * vnoise(fu * 9.0) + 0.03 * vnoise(fu * 41.0));
      base = mix(base, stone * texlibMacro(wp + vWPos.y * 0.7), cop);
      rough = mix(rough, 0.72, cop);
      gTexStr *= 1.0 - 0.8 * cop;
      base *= 1.0 - 0.28 * groove;
    }
    // ramps: anti-slip grooves across the slope
    if (pid == 4 && isTop) {
      vec3 Tt = normalize(vFaceTan - vWNorm * dot(vFaceTan, vWNorm)), Bb = cross(vWNorm, Tt);
      vec2 up2 = vec2(Tt.y, Bb.y);
      float along = dot(fu, up2 / max(length(up2), 1e-4));
      float g = gridLine(along, 0.32, 0.016);
      base *= 1.0 - 0.2 * g;
      rough = mix(rough, 0.95, g);
    }
    // containers: rust streaks bleeding from the top rail and corners, dirt toward the bottom
    if (pid == 5 && isWall) {
      float st = vnoise(vec2(dot(wp, vec2(0.707)) * 5.5 + vWPos.x * 0.8, vWPos.y * 0.35));
      float fromTop = smoothstep(fsz.y * 0.25, fsz.y, fu.y);
      float rust = smoothstep(0.6, 0.92, st) * (0.35 + 0.65 * fromTop);
      rust = max(rust, (1.0 - smoothstep(0.05, 0.3, ef)) * smoothstep(0.45, 0.8, vnoise(fu * 3.0)) * 0.8);
      base = mix(base, vec3(0.42, 0.2, 0.1) * (0.8 + 0.4 * vnoise(fu * 11.0)), rust * 0.42);
      rough = mix(rough, 0.85, rust);
      base *= mix(0.84, 1.0, smoothstep(0.0, 0.7, fu.y));
    }
    // stairs / ramps: soft contact shadow along the stringers / kick plates / cheek walls the props put at both sides;
    // the stone stair is worn smoother and paler down its middle, the steel stair's plate polished along the walking line
    if (gStair.z > 0.5) {
      float e = min(gStair.x, gStair.y - gStair.x);
      float kind = gStair.z;
      float sw = kind < 1.5 ? 0.16 : (kind < 2.5 ? 0.3 : (kind < 3.5 ? 0.14 : 0.12));
      base *= 1.0 - (kind < 2.5 ? 0.26 : 0.2) * (1.0 - smoothstep(0.0, sw, e));
      float mid = 1.0 - smoothstep(0.18, 0.42, abs(gStair.x / max(gStair.y, 0.01) - 0.5));
      if (kind > 1.5 && kind < 2.5) { base *= 1.0 + 0.05 * mid; rough = mix(rough, rough * 0.78, mid); }
      if (kind < 1.5) rough = mix(rough, rough * 0.85, mid * (1.0 - gTexPaint));
    }
    // painted render / timber cladding: rain-washed grime streaks hanging from the top edge of each wall face
    if ((pid == 23 || pid == 22) && isWall) {
      float fromTop = fsz.y - fu.y;
      float st = 0.6 * vnoise(vec2(fu.x * 1.9, fromTop * 0.3 + 7.1)) + 0.4 * vnoise(vec2(fu.x * 6.3, fromTop * 0.8 + 2.3));
      float streak = smoothstep(0.5, 0.85, st) * exp(-fromTop * 0.75);
      base *= 1.0 - 0.2 * streak;
      rough = mix(rough, 0.9, streak * 0.6);
    }
    // boatyard: galvanised slot drain round the tug's wash-down bay (Alpha-half coordinates; the 180° twin follows)
    if (pid == 21 && isTop) {
      vec2 q = wp.y > 0.0 ? -wp : wp;
      vec2 d = abs(q - vec2(17.5, -18.4)) - vec2(4.4, 7.0);
      float sd = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      float e = abs(sd), aw = fwidth(e) + 1e-4;
      float chan = 1.0 - smoothstep(0.08 - aw, 0.08 + aw, e);
      float lip = (1.0 - smoothstep(0.105 - aw, 0.105 + aw, e)) * (1.0 - chan);
      float run = d.x > d.y ? q.y : q.x;
      float fw = fwidth(run) + 1e-5;
      float slot = smoothstep(0.3 - fw / 0.025, 0.3 + fw / 0.025, abs(fract(run / 0.025) - 0.5) * 2.0);
      float bar = mix(0.4, slot, clamp(0.025 / (fw * 4.0) - 0.5, 0.0, 1.0));
      base = mix(base, mix(vec3(0.025), vec3(0.34, 0.35, 0.36), bar), chan);
      base = mix(base, vec3(0.4, 0.41, 0.42) * (0.9 + 0.2 * fine), lip * 0.85);
      rough = mix(rough, 0.48, max(chan * bar, lip));
      gTexORM.b = mix(gTexORM.b, 0.75, max(chan * bar, lip));
      gTexStr *= 1.0 - max(chan, lip);
      base *= mix(vec3(1.0), vec3(0.94, 0.9, 0.87), step(sd, -0.105) * 0.8);   // the bay floor: darker, run-off stained
      // world-scale (non-repeating) oil drips and a worn service-lane wheel track beside the bay
      float oilW = smoothstep(0.68, 0.88, 0.65 * vnoise(q * 0.9 + 13.1) + 0.35 * vnoise(q * 3.1 + 2.7));
      base *= 1.0 - 0.26 * oilW * (1.0 - chan);
      rough = mix(rough, 0.62, oilW * 0.5);
      float tx = q.x - (12.15 + 0.25 * sin(q.y * 0.37));
      float track = (1.0 - smoothstep(0.1, 0.17, min(abs(tx - 0.85), abs(tx + 0.85)))) * step(q.y, -7.6) * (0.5 + 0.5 * vnoise(q * vec2(1.3, 0.35)));
      base *= 1.0 - 0.1 * track;
      rough = mix(rough, rough * 0.85, track);
    }
  }
  if (false) { if (pattern < 0.5) {   // legacy procedural chain below is compiled out of use
#else
  base *= 0.93 + 0.1 * big;
  if (pattern < 0.5) {
#endif
    // plain painted concrete
    base *= 0.97 + 0.05 * fine;
  } else if (pattern < 1.5) {
    // deck: 2 m concrete slabs with dark joints, tone per slab, speckle
    vec2 cell = floor(fu / 2.0);
    base *= 0.95 + 0.08 * h21(cell);
    float j = max(gridLine(fu.x, 2.0, 0.018), gridLine(fu.y, 2.0, 0.018));
    base *= 1.0 - 0.28 * j;
    base *= 0.96 + 0.06 * step(0.93, h21(floor(fu * 22.0)));
    // painted court markings: centre ring + halfway line (slightly worn)
    float rr = length(vWPos.xz);
    float wr = fwidth(rr);
    float mark = 1.0 - smoothstep(0.09 - wr, 0.09 + wr, abs(rr - 9.5));
    float wz = fwidth(vWPos.z);
    mark = max(mark, (1.0 - smoothstep(0.07 - wz, 0.07 + wz, abs(vWPos.z))) * step(9.5, abs(vWPos.x)));
    mark *= 0.75 + 0.25 * step(0.35, vnoise(vWPos.xz * 6.0));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.97, 0.96, 0.92), mark * 0.9);
    rough = 0.86;
  } else if (pattern < 2.5) {
    // tiles: 0.5 m tiles with lighter grout
    vec2 cell = floor(fu / 0.5);
    base *= 0.94 + 0.09 * h21(cell + 3.1);
    float j = max(gridLine(fu.x, 0.5, 0.012), gridLine(fu.y, 0.5, 0.012));
    base = mix(base, base * 0.78 + 0.08, j);
    rough = 0.6;
  } else if (pattern < 3.5) {
    // concrete wall: formwork bands + tie holes + low grime
    float band = gridLine(fu.y, 1.2, 0.01);
    base *= 1.0 - 0.14 * band;
    vec2 tp = vec2(fract(fu.x / 1.2) - 0.5, fract(fu.y / 1.2 - 0.25) - 0.5) * 1.2;
    base *= 1.0 - 0.35 * (1.0 - smoothstep(0.02, 0.035, length(tp)));
    base *= 0.94 + 0.06 * smoothstep(0.0, 0.9, fu.y);
    rough = 0.9;
  } else if (pattern < 4.5) {
    // ramps: grip grooves + yellow safety edges
    float g = gridLine(fu.y, 0.35, 0.02);
    base *= 1.0 - 0.18 * g;
    float edge = 1.0 - smoothstep(0.16, 0.2, min(fu.x, fsz.x - fu.x));
    if (vWNorm.y > 0.5) base = mix(base, vec3(0.93, 0.72, 0.12), edge * 0.95);
    rough = 0.75;
  } else if (pattern < 5.5) {
    // shipping container: vertical corrugation ribs
    float rib = sin(fu.x / 0.28 * 6.2831);
    gRib = rib;
    base *= 0.92 + 0.1 * rib;
    float frame = 1.0 - smoothstep(0.08, 0.1, min(min(fu.y, fsz.y - fu.y), min(fu.x, fsz.x - fu.x)));
    base = mix(base, base * 0.7, frame);
    base *= 0.95 + 0.07 * fbm(fu * vec2(3.0, 0.7));
    rough = 0.55;
  } else if (pattern < 6.5) {
    // wood planks
    float pl = gridLine(fu.y, 0.26, 0.008);
    float plank = floor(fu.y / 0.26);
    float grain = fbm(vec2(fu.x * 0.7 + h21(vec2(plank)) * 30.0, fu.y * 18.0));
    base *= 0.84 + 0.22 * grain;
    base *= 1.0 - 0.35 * pl;
    float frame = 1.0 - smoothstep(0.1, 0.12, min(min(fu.y, fsz.y - fu.y), min(fu.x, fsz.x - fu.x)));
    base = mix(base, base * 0.82, frame * step(fsz.x, 3.0) * step(fsz.y, 3.0));
    rough = 0.78;
  } else if (pattern < 7.5) {
    // metal railing: brushed + rivets
    base *= 0.92 + 0.08 * vnoise(vec2(fu.x * 40.0, fu.y * 1.5));
    vec2 rp = vec2(fract(fu.x / 0.8) - 0.5, fu.y - fsz.y + 0.12) * vec2(0.8, 1.0);
    base *= 1.0 - 0.3 * (1.0 - smoothstep(0.02, 0.03, length(rp)));
    rough = 0.45;
  } else if (pattern < 8.5) {
    // spawn deck: tiles + chevron hazard band around the edges
    vec2 cell = floor(fu / 0.6);
    base *= 0.95 + 0.06 * h21(cell + 7.7);
    float j = max(gridLine(fu.x, 0.6, 0.01), gridLine(fu.y, 0.6, 0.01));
    base *= 1.0 - 0.15 * j;
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float band = 1.0 - smoothstep(0.34, 0.36, e);
    float chev = step(0.5, fract((fu.x + fu.y) * 1.6));
    if (vWNorm.y > 0.5) base = mix(base, mix(vec3(0.95, 0.76, 0.1), vec3(0.12), chev), band * step(0.05, e));
    rough = 0.65;
  } else if (pattern > 9.5 && pattern < 10.5) {
    if (abs(vWNorm.y) < 0.5) {
      // slab edges / trench walls read as poured concrete
      base = base * 1.18 * (0.95 + 0.05 * fine);
      base *= 1.0 - 0.12 * gridLine(fu.y, 1.2, 0.01);
      rough = 0.9;
    } else {
      base *= 0.92 + 0.08 * vnoise(fu * 3.0) + 0.04 * (vnoise(fu * 37.0) - 0.5) * (1.0 - smoothstep(0.02, 0.06, length(fwidth(fu))));
      rough = 0.92;
    }
  } else if (pattern > 10.5 && pattern < 11.5) {
    // painted steel panels: 1.2 m panels with seams + bolt rows
    float seam = max(gridLine(fu.x, 1.2, 0.008), gridLine(fu.y, 1.2, 0.008));
    base *= 1.0 - 0.22 * seam;
    base *= 0.95 + 0.06 * fbm(fu * 1.3);
    rough = 0.5;
  } else if (pattern > 11.5 && pattern < 12.5) {
    base *= 0.9;
    rough = 0.45;
  } else if (pattern > 15.5 && pattern < 16.5) {
    // pavers: 2 m slabs
    vec2 cell = floor(fu / 2.0);
    base *= 0.95 + 0.07 * h21(cell + 1.3);
    float j = max(gridLine(fu.x, 2.0, 0.02), gridLine(fu.y, 2.0, 0.02));
    base *= 1.0 - 0.25 * j;
    rough = 0.84;
  } else if (pattern > 12.5) {
    base *= 0.95 + 0.05 * fine;
    rough = 0.7;
  } else {
    // planter: stone rim with grass bed on top
    float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
    float bed = smoothstep(0.24, 0.27, e) * step(0.5, vWNorm.y);
    vec3 grass = vec3(0.32, 0.55, 0.22) * (0.8 + 0.35 * fbm(fu * 6.0));
    base = mix(base * (0.95 + 0.05 * fine), grass, bed);
    rough = mix(0.8, 0.95, bed);
  }
#ifdef USE_TEXLIB
  }
#endif
  // murals / signage
  if (vFaceFlags.z > -0.5) {
    // atlas rect (mA) + placement on the face in metres (mB: x0, xLen, y0, yLen; xLen < 0 = strip repeating every
    // -xLen face heights, yLen <= 0 = full face height) + weathering (mC: surface shows through, paint damage cuts it)
    int mi = int(vFaceFlags.z + 0.5);
    vec4 mA = uMurA[mi], mB = uMurB[mi];
    vec2 mC = uMurC[mi];
    float my = mB.w > 0.0 ? (fu.y - mB.z) / mB.w : fu.y / fsz.y;
    float mx = mB.y < 0.0 ? fu.x / (-mB.y * fsz.y) : clamp((fu.x - mB.x) / mB.y, 0.0005, 0.9995);
    vec2 muv = vec2(mA.x + mA.y * mx, mA.z + mA.w * clamp(my, 0.004, 0.996));
    vec4 mc = texture2D(uMural, muv);
    mc.rgb *= mix(vec3(1.0), gTexMod, mC.x);
    mc.a *= mix(1.0, gTexPaint, mC.y);
    base = mix(base, mc.rgb * (0.92 + 0.1 * big), mc.a * 0.96);
  }
  // crisp modelled edges: thin bright chamfer + soft inner shadow
  float e = min(min(fu.x, fsz.x - fu.x), min(fu.y, fsz.y - fu.y));
  float ew = fwidth(e);
  // (edges are real bevel geometry now; the old painted chamfer lines drew seams where faces stack)
  // contact darkening at the foot of walls that stand on something
  if (vFaceFlags.x > 0.5 && vFaceFlags.y > 0.5) {
    base *= mix(0.55, 1.0, smoothstep(0.0, 0.85, fu.y));
  }
  gBaseRough = rough;

  // ---- wet ink (src/world/inkShading.js) ----
${INK_COLOR}
  diffuseColor.rgb = base;
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
${INK_ROUGH}`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
#ifdef USE_TEXLIB
metalnessFactor = gTexORM.b * (1.0 - gInk);
#endif`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
{
  // slopes along the face's u / v axes (height per unit length), applied in the face's world tangent frame
  vec2 slope = gInkD;
${INK_GEL}
#ifndef USE_TEXLIB
  if (vFaceData.x > 4.5 && vFaceData.x < 5.5) {
    // corrugation on containers (only where not inked), analytic derivative
    slope.x += (1.0 - gInk) * -sin(vFaceUv.x / 0.28 * 6.2831) * 0.35;
  }
#endif
  vec3 T = normalize(vFaceTan - vWNorm * dot(vFaceTan, vWNorm));
  vec3 Bt = cross(vWNorm, T);
  if (gInk > 0.01) {
    // swim wakes: the ink itself ripples where a squid swims. Each trail segment sheds an expanding ripple (a stadium
    // around the path — their envelope opens into the V-wake) and the submerged body pushes up a glossy mound with a
    // small bow ridge at speed. Height field → analytic gradient in the face's tangent plane.
    vec3 wS = vec3(0.0); float wG = 0.0;
    for (int s = 0; s < 4; s++) {
      vec4 Bd = uWakeB[s];
      if (Bd.w <= 0.0 || distance(vWPos, Bd.xyz) > Bd.w) continue;
      for (int i = 0; i < 11; i++) {
        vec4 A0 = uWake[s * 12 + i], A1 = uWake[s * 12 + i + 1];
        if (A0.w < -1.0 || A1.w < -1.0) continue;
        vec3 ab = A1.xyz - A0.xyz;
        float t = clamp(dot(vWPos - A0.xyz, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
        float age = uTime - mix(A0.w, A1.w, t);
        if (age <= 0.0 || age > 1.15) continue;
        vec3 D = vWPos - (A0.xyz + ab * t);
        D -= vWNorm * dot(D, vWNorm);
        float d = length(D);
        float r = 0.1 + age * 0.95, w = 0.075 + age * 0.085;
        float x = d - r;
        float env = exp(-x * x / (w * w));
        if (env < 0.003) continue;
        float fade = 1.0 - age / 1.15;
        fade *= fade * smoothstep(0.0, 0.05, age);
        float amp = 0.0135 * fade;
        float dh = amp * env * (-2.0 * x / (w * w) * cos(x * 25.0) - 25.0 * sin(x * 25.0));
        wS += D * (dh / max(d, 1e-4));
        wG += env * fade * 0.6;
      }
      vec4 H = uSwimH[s], F = uSwimF[s];
      if (H.w > 0.002) {
        vec3 D = vWPos - H.xyz;
        D -= vWNorm * dot(D, vWNorm);
        vec3 Fp = F.xyz - vWNorm * dot(F.xyz, vWNorm);
        float fl = length(Fp);
        Fp = fl > 1e-3 ? Fp / fl : T;
        float al = dot(D, Fp);
        vec3 Cv = D - Fp * al;
        float ac = length(Cv);
        vec3 Cn = Cv / max(ac, 1e-4);
        // mound over the body (sits a touch behind the head, stretches with speed)
        float am = al + 0.1, La = 0.3 + 0.2 * F.w, Lc = 0.19;
        float hm = 0.05 * H.w * exp(-(am * am) / (La * La) - (ac * ac) / (Lc * Lc));
        // bow ridge pushed ahead of the head
        float ab2 = al - 0.3, hb = 0.022 * H.w * F.w * exp(-(ab2 * ab2) / 0.012 - (ac * ac) / 0.07);
        wS += Fp * (-2.0 * am / (La * La) * hm - 2.0 * ab2 / 0.012 * hb) + Cn * (-2.0 * ac / (Lc * Lc) * hm - 2.0 * ac / 0.07 * hb);
        wG += hm * 16.0 + hb * 20.0;
      }
    }
    // clamp the slope so crests never flip the normal; fade with distance like the gel (no shimmer on far floors)
    float wl = length(wS);
    if (wl > 0.9) wS *= 0.9 / wl;
    float wFar = 1.0 - smoothstep(0.05, 0.16, length(fwidth(vWPos)));
    slope += vec2(dot(wS, T), dot(wS, Bt)) * gInk * wFar;
    gWake = clamp(wG, 0.0, 1.0) * gInk * wFar;
  }
${INK_SLOPE}
  vec3 nBase = vWNorm;
#ifdef USE_TEXLIB
  // surface relief from the texture library; ink fills the grooves so the relief fades out under it
  // (on corrugated metal the ink still follows the ribs)
  float keep = max((vFaceData.x > 4.5 && vFaceData.x < 5.5) ? 0.55 : 0.0, gTexKeep);   // containers + stairs
  nBase = texlibPerturbNormal(gTexN, T, Bt, vWNorm, gTexStr * (1.0 - gInk * (1.0 - max(keep, gInkKeep))));
#endif
  vec3 wn = normalize(nBase - slope.x * T - slope.y * Bt);
  normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
}`)
      .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>${LAMP_LIGHTS}`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>${INK_SHADE}`)
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
if (uAO > 0.0 && vLightUv.x >= 0.0) {
  // baked ambient occlusion: full on sky/indirect light, a touch on the sun so contact shadows read in daylight
  float bao = mix(1.0, texture2D(uLight, vLightUv).r, uAO);
  reflectedLight.indirectDiffuse *= bao;
  reflectedLight.indirectSpecular *= mix(1.0, bao, 0.85);
  reflectedLight.directDiffuse *= mix(1.0, bao, 0.4);
}`)
      .replace('#include <clearcoat_normal_fragment_begin>', `#include <clearcoat_normal_fragment_begin>
clearcoatNormal = normal;`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
${INK_EMISSIVE}`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>${INK_LIGHTS}`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>${INK_LIGHT_MAPS}`)
      .replace('#include <opaque_fragment>', `outgoingLight = min(outgoingLight, vec3(5.0));
#include <opaque_fragment>`);
  };
  if (opts.grate) {
    mat.side = THREE.DoubleSide;
    mat.defines = { ...(mat.defines || {}), GRATE: 1 };
  }
  mat.customProgramCacheKey = () => 'inkwave-level-v6' + (opts.grate ? '-grate' : '');
  return mat;
}
