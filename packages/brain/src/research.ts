import * as THREE from 'three';

/**
 * Cortex² research overlay: a see-through "tractometrics" illustration.
 *
 * Anchors sit at approximate cortical projections of 10-20 electrode sites
 * (MNI-like millimetres mapped into the anatomy scene frame). Fibers are
 * procedurally generated streamlines bundled between anchors and coloured by
 * local direction like a DTI colour map. They are an illustrative anatomical
 * overlay, NOT tractography reconstructed from scalp EEG.
 */
export type ResearchMood = 'idle' | 'curious' | 'excited' | 'sleepy' | 'surprised' | 'happy';

export interface ResearchOverlay {
  /** One value in [0, 1] per anchor in RESEARCH_ANCHORS order. */
  intensities: number[];
  labels?: string[];
  /** Hover tooltip rows per anchor, e.g. { channel: 'FP1-F7', alpha: '12.1 %' }. */
  values?: Array<Record<string, number | string>>;
  opacity: number;
  shellOpacity?: number;
  mood?: ResearchMood;
  /** Increment on each detected blink; the brain blinks right away. */
  blinkSignal?: number;
  /** Optional gaze target in normalized screen coordinates (y down). */
  gaze?: { x: number; y: number } | null;
}

/** [name, MNI x (right +), MNI y (anterior +), MNI z (superior +)] cortical projections. */
const ANCHOR_MNI: Array<[string, number, number, number]> = [
  ['Fp1', -24, 66, 6],
  ['Fp2', 24, 66, 6],
  ['F7', -52, 30, -4],
  ['F3', -38, 42, 40],
  ['Fz', 0, 42, 54],
  ['F4', 38, 42, 40],
  ['F8', 52, 30, -4],
  ['T7', -64, -14, -6],
  ['C3', -50, -16, 52],
  ['Cz', 0, -14, 70],
  ['C4', 50, -16, 52],
  ['T8', 64, -14, -6],
  ['P7', -56, -58, -2],
  ['P3', -40, -62, 48],
  ['Pz', 0, -62, 58],
  ['P4', 40, -62, 48],
  ['P8', 56, -58, -2],
  ['O1', -26, -94, 6],
  ['O2', 26, -94, 6],
];
export const RESEARCH_ANCHORS = ANCHOR_MNI.map(([name]) => name);

/** Same transform as the anatomy manifest: [-R, S-15, A+17] * 0.015 + [0, 0.35, 0]. */
export function mniToScene(x: number, y: number, z: number, inset = 0.96) {
  return new THREE.Vector3(
    -x * 0.015 * inset,
    (z - 15) * 0.015 * inset + 0.35,
    (y + 17) * 0.015 * inset,
  );
}

const CENTER = new THREE.Vector3(0, 0.42, 0.05);

type Connection = { a: number; b: number; kind: 'local' | 'commissural' | 'association' };

function connections(points: THREE.Vector3[]): Connection[] {
  const out: Connection[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, kind: Connection['kind']) => {
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    out.push({ a, b, kind });
  };
  // U-fibres between nearby sites.
  for (let i = 0; i < points.length; i++) {
    const near = points
      .map((p, j) => ({ j, d: p.distanceTo(points[i]) }))
      .filter((v) => v.j !== i)
      .sort((u, v) => u.d - v.d)
      .slice(0, 3);
    for (const n of near) add(i, n.j, 'local');
  }
  // Homologous left/right pairs through the corpus callosum.
  const index = (n: string) => RESEARCH_ANCHORS.indexOf(n);
  for (const [l, r] of [
    ['Fp1', 'Fp2'],
    ['F3', 'F4'],
    ['F7', 'F8'],
    ['C3', 'C4'],
    ['T7', 'T8'],
    ['P3', 'P4'],
    ['P7', 'P8'],
    ['O1', 'O2'],
  ])
    add(index(l), index(r), 'commissural');
  // Long association bundles (arcuate / IFOF / SLF style, per hemisphere).
  for (const [a, b] of [
    ['F7', 'P7'],
    ['F8', 'P8'],
    ['Fp1', 'O1'],
    ['Fp2', 'O2'],
    ['F3', 'P3'],
    ['F4', 'P4'],
    ['T7', 'O1'],
    ['T8', 'O2'],
    ['Fz', 'Pz'],
    ['F7', 'T7'],
    ['F8', 'T8'],
  ])
    add(index(a), index(b), 'association');
  return out;
}

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function fiberCurve(
  a: THREE.Vector3,
  b: THREE.Vector3,
  kind: Connection['kind'],
  rand: () => number,
) {
  const jitter = () =>
    new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.07);
  const start = a.clone().add(jitter());
  const end = b.clone().add(jitter());
  const depth = kind === 'local' ? 0.22 : kind === 'commissural' ? 0.62 : 0.42;
  const mids = [0.3, 0.5, 0.7].map((t) => {
    const p = start.clone().lerp(end, t);
    // pull towards the white-matter centre so fibres dive beneath the cortex
    const pull = Math.sin(Math.PI * t) * depth;
    return p.lerp(CENTER, pull).add(jitter().multiplyScalar(0.8));
  });
  return new THREE.CatmullRomCurve3([start, ...mids, end], false, 'centripetal');
}

function dotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.35, 'rgba(255,255,255,.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createResearchOverlay(fibersPerConnection = 2) {
  const root = new THREE.Group();
  root.name = 'cortex2-research-overlay';
  const anchors = ANCHOR_MNI.map(([, x, y, z]) => mniToScene(x, y, z));
  const conns = connections(anchors);
  const rand = seeded(20261025);
  const fiberMaterials: THREE.MeshBasicMaterial[] = [];
  const fibers: Array<{
    mesh: THREE.Mesh;
    curve: THREE.CatmullRomCurve3;
    a: number;
    b: number;
    phase: number;
    speed: number;
  }> = [];
  const SEGMENTS = 36,
    RADIAL = 4;
  for (const c of conns) {
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
    });
    fiberMaterials.push(material);
    const n = c.kind === 'association' ? fibersPerConnection + 1 : fibersPerConnection;
    for (let k = 0; k < n; k++) {
      const curve = fiberCurve(anchors[c.a], anchors[c.b], c.kind, rand);
      const radius = c.kind === 'local' ? 0.0055 : 0.008;
      const geometry = new THREE.TubeGeometry(curve, SEGMENTS, radius, RADIAL, false);
      const colors = new Float32Array(geometry.attributes.position.count * 3);
      for (let i = 0; i <= SEGMENTS; i++) {
        const t = curve.getTangentAt(i / SEGMENTS);
        // DTI-style direction colour: left-right red, anterior-posterior green, superior-inferior blue
        const r = Math.abs(t.x),
          g = Math.abs(t.z),
          bl = Math.abs(t.y);
        const m = Math.max(r, g, bl, 1e-6);
        const rgb = [
          0.18 + 0.72 * (r / m) * r,
          0.24 + 0.56 * (g / m) * g,
          0.3 + 0.62 * (bl / m) * bl,
        ];
        for (let j = 0; j <= RADIAL; j++) colors.set(rgb, (i * (RADIAL + 1) + j) * 3);
      }
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = 5;
      root.add(mesh);
      fibers.push({ mesh, curve, a: c.a, b: c.b, phase: rand(), speed: 0.6 + rand() * 0.8 });
    }
  }
  // Travelling activity pulses: one point per fibre, updated each frame.
  const texture = dotTexture();
  const pulseGeometry = new THREE.BufferGeometry();
  const pulsePositions = new Float32Array(fibers.length * 3);
  const pulseColors = new Float32Array(fibers.length * 3);
  pulseGeometry.setAttribute('position', new THREE.BufferAttribute(pulsePositions, 3));
  pulseGeometry.setAttribute('color', new THREE.BufferAttribute(pulseColors, 3));
  const pulseMaterial = new THREE.PointsMaterial({
    size: 0.13,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const pulses = new THREE.Points(pulseGeometry, pulseMaterial);
  pulses.renderOrder = 7;
  root.add(pulses);
  // Anchor glows.
  const anchorGeometry = new THREE.BufferGeometry().setFromPoints(anchors);
  const anchorColors = new Float32Array(anchors.length * 3);
  anchorGeometry.setAttribute('color', new THREE.BufferAttribute(anchorColors, 3));
  const anchorMaterial = new THREE.PointsMaterial({
    size: 0.2,
    map: texture,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
  });
  const anchorPoints = new THREE.Points(anchorGeometry, anchorMaterial);
  anchorPoints.renderOrder = 8;
  root.add(anchorPoints);

  const cool = new THREE.Color('#6fc3b6');
  const warm = new THREE.Color('#f2b067');
  const hot = new THREE.Color('#f07b8f');
  const tmp = new THREE.Color();
  const heat = (v: number) =>
    v < 0.6 ? tmp.copy(cool).lerp(warm, v / 0.6) : tmp.copy(warm).lerp(hot, (v - 0.6) / 0.4);
  const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

  const update = (overlay: ResearchOverlay, seconds: number, reducedMotion: boolean) => {
    const opacity = clamp01(overlay.opacity);
    const I = anchors.map((_, i) => clamp01(overlay.intensities[i] ?? 0));
    for (let i = 0; i < conns.length; i++) {
      const s = (I[conns[i].a] + I[conns[i].b]) / 2;
      fiberMaterials[i].opacity = opacity * (0.38 + 0.55 * s);
    }
    for (let k = 0; k < fibers.length; k++) {
      const f = fibers[k];
      const s = (I[f.a] + I[f.b]) / 2;
      const t = reducedMotion ? f.phase : (f.phase + seconds * f.speed * (0.12 + 0.45 * s)) % 1;
      // direction of travel alternates with the stronger endpoint
      const along = I[f.a] >= I[f.b] ? t : 1 - t;
      const p = f.curve.getPoint(along);
      pulsePositions[k * 3] = p.x;
      pulsePositions[k * 3 + 1] = p.y;
      pulsePositions[k * 3 + 2] = p.z;
      const c = heat(s);
      pulseColors[k * 3] = c.r;
      pulseColors[k * 3 + 1] = c.g;
      pulseColors[k * 3 + 2] = c.b;
    }
    pulseGeometry.attributes.position.needsUpdate = true;
    pulseGeometry.attributes.color.needsUpdate = true;
    for (let i = 0; i < anchors.length; i++) {
      const c = heat(I[i]);
      anchorColors[i * 3] = c.r;
      anchorColors[i * 3 + 1] = c.g;
      anchorColors[i * 3 + 2] = c.b;
    }
    anchorGeometry.attributes.color.needsUpdate = true;
    pulseMaterial.opacity = opacity * 0.95;
    anchorMaterial.opacity = opacity * 0.9;
  };

  const dispose = () => {
    root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Points) o.geometry.dispose();
    });
    fiberMaterials.forEach((m) => m.dispose());
    pulseMaterial.dispose();
    anchorMaterial.dispose();
    texture.dispose();
  };

  return {
    root,
    anchors,
    update,
    dispose,
    fiberCount: fibers.length,
    connectionCount: conns.length,
  };
}

/** Eye/scale modulation for each mood; applied on top of the regular blink. */
export function moodEyes(mood: ResearchMood | undefined, seconds: number) {
  switch (mood) {
    case 'surprised':
      return { lid: 1, scale: 1.14, bob: 1, glance: 0 };
    case 'sleepy':
      return { lid: 0.42 + 0.06 * Math.sin(seconds * 0.8), scale: 0.98, bob: 0.5, glance: 0 };
    case 'happy':
      return { lid: 0.72, scale: 1.04, bob: 1.8, glance: 0 };
    case 'excited':
      return { lid: 1, scale: 1.08, bob: 2.6, glance: 0 };
    case 'curious':
      return { lid: 0.92, scale: 1.05, bob: 1, glance: 0.55 };
    default:
      return { lid: 1, scale: 1, bob: 1, glance: 0 };
  }
}
