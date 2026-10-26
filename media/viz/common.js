// Shared helpers for the deterministic hype-video visualizations.
// Everything is driven by window.render(t) — no rAF, no Math.random.
import * as THREE from 'three';

export { THREE };
export const W = 1920, H = 1080;
export const PAL = {
  red: new THREE.Color('#ff3b2f'), gold: new THREE.Color('#ffcf6b'), violet: new THREE.Color('#b07de0'),
  orange: new THREE.Color('#ff6a1a'), blue: new THREE.Color('#6fa8ff'), ink: new THREE.Color('#14161f'),
  peri: new THREE.Color('#cfdcfb'), white: new THREE.Color('#ffffff'),
};

export function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export const clamp01 = (v) => Math.max(0, Math.min(1, v));
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const ease = (x) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
export const lerp = (a, b, t) => a + (b - a) * t;

// ---------------------------------------------------------------- stage
export function initStage({ fov = 30 } = {}) {
  const canvas = document.getElementById('c');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, W / H, 0.05, 200);
  return { renderer, scene, camera };
}

// Drifting background blobs (DOM, deck-style). Call each frame.
const BLOBS = [
  ['#ff3b2f', -120, 640, 620, 0.0], ['#ffcf6b', 120, -180, 560, 1.3], ['#b07de0', 760, 260, 820, 2.1],
  ['#ff6a1a', 1100, 700, 600, 3.4], ['#6fa8ff', 1520, 820, 760, 4.2], ['#c78cff', 1600, -160, 600, 5.0],
  ['#7fb2ff', -200, 880, 520, 0.7],
];
export function makeBlobs(strength = 0.3) {
  const host = document.getElementById('bg');
  const els = BLOBS.map(([c, x, y, s]) => {
    const d = document.createElement('div');
    d.className = 'blob';
    Object.assign(d.style, { background: c, width: s + 'px', height: s + 'px', left: x + 'px', top: y + 'px', opacity: strength });
    host.appendChild(d);
    return d;
  });
  return (t) => els.forEach((d, i) => {
    const ph = BLOBS[i][4];
    d.style.transform = `translate(${Math.sin(t * 0.21 + ph) * 60}px, ${Math.cos(t * 0.17 + ph * 1.7) * 45}px) scale(${1 + 0.06 * Math.sin(t * 0.3 + ph)})`;
  });
}

// ---------------------------------------------------------------- glow sprite texture
let _glow;
export function glowTexture() {
  if (_glow) return _glow;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  _glow = new THREE.CanvasTexture(c);
  return _glow;
}

// Points with per-vertex size/color/alpha (size in px at distance 1 * scale).
export function glowPoints(n, { scale = 1, blending = THREE.NormalBlending, core = 0.0 } = {}) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3));
  geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n).fill(10), 1));
  geo.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(n).fill(1), 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: glowTexture() }, uScale: { value: scale }, uCore: { value: core } },
    vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; varying vec3 vC; varying float vA;
      uniform float uScale;
      void main(){ vC=color; vA=alpha; vec4 mv=modelViewMatrix*vec4(position,1.); gl_PointSize=size*uScale/(-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform sampler2D map; uniform float uCore; varying vec3 vC; varying float vA;
      void main(){ vec4 t=texture2D(map,gl_PointCoord); float r=length(gl_PointCoord-.5);
        float core=smoothstep(.09,.0,r)*uCore; vec3 col=mix(vC,vec3(1.),core);
        gl_FragColor=vec4(col, (t.a*.95+core)*vA); }`,
    transparent: true, depthWrite: false, blending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 10;
  pts.set = (i, p, c, size, alpha) => {
    geo.attributes.position.setXYZ(i, p.x, p.y, p.z);
    if (c) geo.attributes.color.setXYZ(i, c.r, c.g, c.b);
    geo.attributes.size.setX(i, size);
    geo.attributes.alpha.setX(i, alpha);
  };
  pts.commit = () => ['position', 'color', 'size', 'alpha'].forEach((k) => (geo.attributes[k].needsUpdate = true));
  return pts;
}

// ---------------------------------------------------------------- real anatomy
const ANAT = '/apps/web/public/anatomy/';
function decodeAnatomy(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x314e5242) throw new Error('bad anatomy');
  const v = view.getUint32(4, true), t = view.getUint32(8, true);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffer, 12, v * 3), 3));
  geo.setAttribute('shade', new THREE.BufferAttribute(new Float32Array(buffer, 12 + v * 12, v), 1));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buffer, 12 + v * 16, t * 3), 1));
  geo.computeVertexNormals();
  return geo;
}

// Fresnel "glass" shell: faint body, coloured rim, fake specular.
export function glassMaterial({ tint = '#c4c2ff', rim = '#5b50d6', body = 0.05, rimA = 0.5, spec = 0.7 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: { uTint: { value: new THREE.Color(tint) }, uRim: { value: new THREE.Color(rim) },
      uBody: { value: body }, uRimA: { value: rimA }, uSpec: { value: spec }, uFade: { value: 1 } },
    vertexShader: `attribute float shade; varying vec3 vN; varying vec3 vV; varying float vS;
      void main(){ vec4 mv=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz); vS=shade;
        gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uTint; uniform vec3 uRim; uniform float uBody,uRimA,uSpec,uFade; varying vec3 vN; varying vec3 vV; varying float vS;
      void main(){ vec3 n=normalize(vN); if(!gl_FrontFacing) n=-n; float d=abs(dot(n,vV));
        float fr=pow(1.-d,2.4);
        vec3 L=normalize(vec3(-.4,.7,.6)); vec3 Hh=normalize(L+vV); float sp=pow(max(dot(n,Hh),0.),40.)*uSpec;
        float gy=smoothstep(.75,1.03,vS);
        vec3 col=mix(uTint,uRim,fr); col=mix(col,vec3(1.),sp);
        float a=(uBody*(.5+gy)+fr*uRimA*(.55+.45*gy)+sp*.6)*uFade;
        gl_FragColor=vec4(col,a); }`,
    transparent: true, depthWrite: false, side: THREE.FrontSide,
  });
}

export async function loadBrain({ nuclei = true, cerebellum = true, glass = {} } = {}) {
  const group = new THREE.Group();
  const want = ['cortex-l', 'cortex-r'];
  if (cerebellum) want.push('cerebellum-l', 'cerebellum-r', 'brainstem');
  const nucl = ['thalamus-l', 'thalamus-r', 'caudate-l', 'caudate-r', 'putamen-l', 'putamen-r', 'hippocampus-l', 'hippocampus-r', 'amygdala-l', 'amygdala-r'];
  if (nuclei) want.push(...nucl);
  const ncol = { thalamus: '#ff6a1a', caudate: '#6fa8ff', putamen: '#b07de0', hippocampus: '#ff3b2f', amygdala: '#ffcf6b' };
  const shellMat = glassMaterial(glass);
  const hindMat = glassMaterial({ ...glass, body: (glass.body ?? 0.035) * 0.8, rimA: (glass.rimA ?? 0.5) * 0.7 });
  const mats = [shellMat, hindMat];
  await Promise.all(want.map(async (name) => {
    const geo = decodeAnatomy(await (await fetch(ANAT + name + '.bin')).arrayBuffer());
    let mat;
    if (name.startsWith('cortex')) mat = shellMat;
    else if (nucl.includes(name)) {
      mat = glassMaterial({ tint: ncol[name.split('-')[0]], rim: ncol[name.split('-')[0]], body: 0.1, rimA: 0.4, spec: 0.3 });
      mats.push(mat);
    } else mat = hindMat;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = name;
    mesh.renderOrder = name.startsWith('cortex') ? 20 : nucl.includes(name) ? 2 : 3;
    group.add(mesh);
  }));
  group.userData.mats = mats;
  group.fade = (f) => mats.forEach((m) => (m.uniforms.uFade.value = f));
  return group;
}

// ---------------------------------------------------------------- 10-20 anchors + fibers (port of packages/brain/src/research.ts)
export const ANCHOR_MNI = [
  ['Fp1', -24, 66, 6], ['Fp2', 24, 66, 6], ['F7', -52, 30, -4], ['F3', -38, 42, 40], ['Fz', 0, 42, 54],
  ['F4', 38, 42, 40], ['F8', 52, 30, -4], ['T7', -64, -14, -6], ['C3', -50, -16, 52], ['Cz', 0, -14, 70],
  ['C4', 50, -16, 52], ['T8', 64, -14, -6], ['P7', -56, -58, -2], ['P3', -40, -62, 48], ['Pz', 0, -62, 58],
  ['P4', 40, -62, 48], ['P8', 56, -58, -2], ['O1', -26, -94, 6], ['O2', 26, -94, 6],
];
export const ANCHORS = ANCHOR_MNI.map((a) => a[0]);
export const mniToScene = (x, y, z, inset = 0.96) =>
  new THREE.Vector3(-x * 0.015 * inset, (z - 15) * 0.015 * inset + 0.35, (y + 17) * 0.015 * inset);
const CENTER = new THREE.Vector3(0, 0.42, 0.05);

function connections(points) {
  const out = [], seen = new Set();
  const add = (a, b, kind) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key); out.push({ a, b, kind });
  };
  for (let i = 0; i < points.length; i++)
    points.map((p, j) => ({ j, d: p.distanceTo(points[i]) })).filter((v) => v.j !== i)
      .sort((u, v) => u.d - v.d).slice(0, 3).forEach((n) => add(i, n.j, 'local'));
  const ix = (n) => ANCHORS.indexOf(n);
  [['Fp1', 'Fp2'], ['F3', 'F4'], ['F7', 'F8'], ['C3', 'C4'], ['T7', 'T8'], ['P3', 'P4'], ['P7', 'P8'], ['O1', 'O2']]
    .forEach(([l, r]) => add(ix(l), ix(r), 'commissural'));
  [['F7', 'P7'], ['F8', 'P8'], ['Fp1', 'O1'], ['Fp2', 'O2'], ['F3', 'P3'], ['F4', 'P4'], ['T7', 'O1'], ['T8', 'O2'], ['Fz', 'Pz'], ['F7', 'T7'], ['F8', 'T8']]
    .forEach(([a, b]) => add(ix(a), ix(b), 'association'));
  return out;
}

function fiberCurve(a, b, kind, rand) {
  const jit = () => new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.07);
  const s = a.clone().add(jit()), e = b.clone().add(jit());
  const depth = kind === 'local' ? 0.22 : kind === 'commissural' ? 0.62 : 0.42;
  const mids = [0.3, 0.5, 0.7].map((t) => s.clone().lerp(e, t).lerp(CENTER, Math.sin(Math.PI * t) * depth).add(jit().multiplyScalar(0.8)));
  return new THREE.CatmullRomCurve3([s, ...mids, e], false, 'centripetal');
}

// Activation heat ramp in deck colours: blue -> violet -> orange/red -> gold core
export function heat(v, out = new THREE.Color()) {
  v = clamp01(v);
  if (v < 0.35) return out.copy(PAL.blue).lerp(PAL.violet, v / 0.35);
  if (v < 0.7) return out.copy(PAL.violet).lerp(PAL.red, (v - 0.35) / 0.35);
  return out.copy(PAL.red).lerp(PAL.gold, (v - 0.7) / 0.3);
}

export function createFibers({ perConnection = 2, radius = 1 } = {}) {
  const root = new THREE.Group();
  const anchors = ANCHOR_MNI.map(([, x, y, z]) => mniToScene(x, y, z));
  const scalp = anchors.map((p) => p.clone().sub(CENTER).multiplyScalar(1.14).add(CENTER));
  const conns = connections(anchors);
  const rand = seeded(20261025);
  const SEG = 64, RAD = 6;
  const geos = [], fibers = [];
  for (const c of conns) {
    const n = c.kind === 'association' ? perConnection + 1 : perConnection;
    for (let k = 0; k < n; k++) {
      const curve = fiberCurve(anchors[c.a], anchors[c.b], c.kind, rand);
      const r = (c.kind === 'local' ? 0.011 : 0.016) * radius;
      const g = new THREE.TubeGeometry(curve, SEG, r, RAD, false);
      const cnt = g.attributes.position.count;
      const dti = new Float32Array(cnt * 3), fa = new Float32Array(cnt * 4);
      const phase = rand(), speed = 0.35 + rand() * 0.45, dir = rand() < 0.5 ? 1 : -1;
      for (let i = 0; i <= SEG; i++) {
        const t = curve.getTangentAt(i / SEG);
        const rr = Math.abs(t.x), gg = Math.abs(t.z), bb = Math.abs(t.y);
        // DTI direction colour remapped into the deck palette
        const col = new THREE.Color(0, 0, 0).add(PAL.red.clone().multiplyScalar(rr)).add(PAL.gold.clone().multiplyScalar(gg * 0.8))
          .add(PAL.blue.clone().multiplyScalar(bb)).multiplyScalar(1 / Math.max(rr + gg * 0.8 + bb, 1e-3));
        for (let j = 0; j <= RAD; j++) {
          const o = i * (RAD + 1) + j;
          dti.set([col.r, col.g, col.b], o * 3);
          fa.set([c.a, c.b, phase, speed * dir], o * 4);
        }
      }
      g.setAttribute('dti', new THREE.BufferAttribute(dti, 3));
      g.setAttribute('fib', new THREE.BufferAttribute(fa, 4));
      geos.push(g);
      fibers.push({ curve, a: c.a, b: c.b, phase, speed, dir });
    }
  }
  const geo = mergeGeometries(geos);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uI: { value: new Float32Array(19) }, uT: { value: 0 }, uFade: { value: 1 }, uBase: { value: 0.24 } },
    vertexShader: `attribute vec3 dti; attribute vec4 fib; uniform float uI[19]; uniform float uT;
      varying vec3 vD; varying float vS; varying float vG; varying vec3 vN; varying vec3 vV;
      float I(float k){ int i=int(k+.5); float r=0.; for(int j=0;j<19;j++){ if(j==i) r=uI[j]; } return r; }
      void main(){ vD=dti; float s=(I(fib.x)+I(fib.y))*.5; vS=s;
        float u=uv.x; float sp=fib.w; float p=fract(fib.z+uT*abs(sp)); float uu=sp>0.?u:1.-u;
        float g=0.;
        for(int k=0;k<2;k++){ float pk=fract(p+float(k)*.5); float d=uu-pk; d=d-floor(d+.5);
          g+=exp(-d*d/.0016)+ .45*exp(-max(-d,0.)*14.)*step(d,0.)*step(-.25,d); }
        vG=g*(.25+.95*s);
        vec4 mv=modelViewMatrix*vec4(position,1.); vN=normalize(normalMatrix*normal); vV=normalize(-mv.xyz);
        gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform float uFade,uBase; varying vec3 vD; varying float vS; varying float vG; varying vec3 vN; varying vec3 vV;
      vec3 heat(float v){ vec3 b=vec3(.435,.659,1.), vi=vec3(.69,.49,.878), r=vec3(1.,.231,.184), g=vec3(1.,.81,.42);
        v=clamp(v,0.,1.); return v<.35?mix(b,vi,v/.35):v<.7?mix(vi,r,(v-.35)/.35):mix(r,g,(v-.7)/.3); }
      void main(){ float d=abs(dot(normalize(vN),vV));
        vec3 col=mix(vD*.9,heat(vS),.18+.45*vS); col=mix(col,mix(heat(.55+vS*.45),vec3(1.,.97,.9),.35),clamp(vG,0.,1.));
        col*=.75+.35*d;
        float a=(uBase+.45*vS+.8*clamp(vG,0.,1.))*(.55+.45*d)*uFade;
        gl_FragColor=vec4(col,clamp(a,0.,1.)); }`,
    transparent: true, depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  root.add(mesh);

  // pulse heads (2 per fibre) + electrode glows
  const heads = glowPoints(fibers.length * 2, { scale: 8, core: 0.7 });
  root.add(heads);
  const elec = glowPoints(19 * 2, { scale: 8, core: 1.0 });
  elec.renderOrder = 30;
  root.add(elec);
  const tmp = new THREE.Color();
  const update = (t, I, fade = 1) => {
    mat.uniforms.uI.value.set(I);
    mat.uniforms.uT.value = t;
    mat.uniforms.uFade.value = fade;
    fibers.forEach((f, k) => {
      const s = (I[f.a] + I[f.b]) / 2;
      const p = (f.phase + t * f.speed) % 1;
      for (let h = 0; h < 2; h++) {
        let u = (p + h * 0.5) % 1;
        if (f.dir < 0) u = 1 - u;
        heads.set(k * 2 + h, f.curve.getPointAt(u), heat(0.5 + s * 0.5, tmp), 14 + 34 * s, (0.25 + 0.75 * s) * fade);
      }
    });
    heads.commit();
    for (let i = 0; i < 19; i++) {
      elec.set(i, scalp[i], heat(0.3 + 0.7 * I[i], tmp), 50 + 120 * I[i], (0.55 + 0.45 * I[i]) * fade);
      elec.set(19 + i, scalp[i], PAL.white, 9, 0.95 * fade);
    }
    elec.commit();
  };
  return { root, anchors, scalp, update, fibers, mesh, heads, elec, count: fibers.length };
}

function mergeGeometries(geos) {
  let nv = 0, ni = 0;
  geos.forEach((g) => { nv += g.attributes.position.count; ni += g.index.count; });
  const out = new THREE.BufferGeometry();
  const names = Object.keys(geos[0].attributes);
  const arrs = {};
  names.forEach((n) => (arrs[n] = new Float32Array(nv * geos[0].attributes[n].itemSize)));
  const idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  geos.forEach((g) => {
    names.forEach((n) => arrs[n].set(g.attributes[n].array, ov * g.attributes[n].itemSize));
    for (let i = 0; i < g.index.count; i++) idx[oi + i] = g.index.array[i] + ov;
    ov += g.attributes.position.count; oi += g.index.count;
  });
  names.forEach((n) => out.setAttribute(n, new THREE.BufferAttribute(arrs[n], geos[0].attributes[n].itemSize)));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

// ---------------------------------------------------------------- simulated EEG band power (deterministic)
export const BANDS = ['δ', 'θ', 'α₁', 'α₂', 'β₁', 'β₂', 'β₃', 'γ₁', 'γ₂', 'γ₃'];
const chRand = seeded(77);
const CH = ANCHOR_MNI.map(([, x, y, z]) => ({ x, y, z, ph: chRand() * 6.28, f: 0.35 + chRand() * 0.5, g: chRand() }));
export function bandPower(t) {
  // per-channel scalar activation: posterior->anterior travelling wave + local flicker
  return CH.map((c) => {
    const wave = Math.max(0, Math.sin(t * 1.6 - c.y * 0.035 + Math.sin(t * 0.4) * 0.8));
    const side = 0.5 + 0.5 * Math.sin(t * 0.9 + c.x * 0.05);
    const flick = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * c.f + c.ph);
    return clamp01(0.08 + 0.62 * wave * wave * (0.5 + 0.5 * side) + 0.28 * flick * c.g);
  });
}
export function spectra(t) {
  const I = bandPower(t);
  return CH.map((c, i) => BANDS.map((_, b) => {
    const pink = 1 / (1 + b * 0.38);
    const alpha = (b === 2 || b === 3) ? (0.35 + 0.65 * smooth(-20, -90, c.y)) * 0.9 : 0;
    const beta = (b >= 4 && b <= 6) ? 0.35 * smooth(0, 60, c.y) : 0;
    const flick = 0.5 + 0.5 * Math.sin(t * (1.3 + b * 0.37) + c.ph * (b + 1));
    return clamp01((0.25 * pink + alpha + beta) * (0.55 + 0.45 * I[i]) + 0.12 * flick * pink);
  }));
}

// ---------------------------------------------------------------- hypercube
export function hypercube() {
  const nodes = [], edges = [];
  for (let x = 0; x < 256; x++) {
    const v = [];
    for (let q = 0; q < 8; q++) v.push(((x >> (7 - q)) & 1) ? 1 : -1);
    nodes.push(v);
    for (let q = 0; q < 8; q++) { const y = x ^ (1 << (7 - q)); if (y > x) edges.push([x, y, q]); }
  }
  return { nodes, edges };
}
// rotating 8D -> 3D projection
export function projector(t, radius = 1, wob = 0.03) {
  // base: Petrie-style polygon in xy + alternating depth
  const P = [];
  for (let d = 0; d < 8; d++) {
    const a = (Math.PI * d) / 8 + wob * Math.sin(t * 0.7 + d);
    const b = (3 * Math.PI * d) / 8 + t * 0.5;
    P.push([Math.cos(a) * radius, Math.sin(a) * radius, Math.cos(b) * radius * 0.55]);
  }
  return (v, out = new THREE.Vector3()) => {
    let x = 0, y = 0, z = 0;
    for (let d = 0; d < 8; d++) { x += v[d] * P[d][0]; y += v[d] * P[d][1]; z += v[d] * P[d][2]; }
    return out.set(x, y, z);
  };
}
export const bits = (x) => x.toString(2).padStart(8, '0');

// ---------------------------------------------------------------- HTML labels anchored to 3D points
export function labelLayer() {
  const host = document.getElementById('labels');
  const v = new THREE.Vector3();
  return {
    add(text, cls = 'lab') {
      const d = document.createElement('div');
      d.className = cls; d.textContent = text; host.appendChild(d);
      return d;
    },
    place(el, p, camera, opacity = 1, dx = 0, dy = 0) {
      camera.updateMatrixWorld(); v.copy(p).project(camera);
      const x = (v.x * 0.5 + 0.5) * W + dx, y = (-v.y * 0.5 + 0.5) * H + dy;
      el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%,-50%)`;
      el.style.opacity = v.z > 1 ? 0 : opacity;
    },
  };
}

export function ready(render, duration) {
  window.render = render;
  window.DURATION = duration;
  document.fonts.ready.then(() => { render(0); window.ready = true; });
}
