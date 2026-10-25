import * as THREE from 'three';
export type DistractionKind = 'fly' | 'butterfly' | 'mote';
export function createDistraction() {
  const root = new THREE.Group();
  root.name = 'playful-distraction';
  const dark = new THREE.MeshStandardMaterial({ color: '#3e4540', roughness: 0.6 });
  const translucent = new THREE.MeshPhysicalMaterial({
    color: '#d5e8da',
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    roughness: 0.3,
  });
  const coral = new THREE.MeshStandardMaterial({
    color: '#e9ae82',
    side: THREE.DoubleSide,
    roughness: 0.7,
  });
  const fly = new THREE.Group(),
    butterfly = new THREE.Group(),
    mote = new THREE.Group();
  const wings: THREE.Mesh[] = [];
  for (const [insect, material, size] of [
    [fly, translucent, 0.075],
    [butterfly, coral, 0.13],
  ] as const) {
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.032, 12, 10), dark);
    body.scale.set(0.65, 1.7, 0.7);
    insect.add(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), material);
      wing.scale.set(1, 0.67, 0.07);
      wing.position.set(side * size * 0.72, 0.015, 0);
      insect.add(wing);
      wings.push(wing);
      if (insect === butterfly) {
        const lower = wing.clone();
        lower.scale.multiplyScalar(0.68);
        lower.position.set(side * size * 0.6, -0.067, 0);
        insect.add(lower);
        wings.push(lower);
      }
    }
  }
  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.032, 12, 12),
    new THREE.MeshStandardMaterial({
      color: '#f7dc88',
      emissive: '#c2993b',
      emissiveIntensity: 0.7,
    }),
  );
  mote.add(glow);
  root.add(fly, butterfly, mote);
  root.visible = false;
  return {
    root,
    update(
      kind: DistractionKind | null | undefined,
      time: number,
      reducedMotion: boolean,
      energy: number,
    ) {
      root.visible = Boolean(kind);
      fly.visible = kind === 'fly';
      butterfly.visible = kind === 'butterfly';
      mote.visible = kind === 'mote';
      const t = reducedMotion ? 0 : time * (0.5 + energy * 0.5);
      root.position.set(
        1.35 * Math.cos(t * 0.68),
        0.35 + Math.sin(t * 1.13) * 0.72,
        1.55 + Math.sin(t * 0.43) * 0.15,
      );
      root.rotation.z = Math.sin(t * 0.9) * 0.3;
      wings.forEach((wing, i) => {
        wing.rotation.y = reducedMotion
          ? 0
          : Math.sin(t * (kind === 'fly' ? 45 : 12)) * 0.9 * (i % 2 ? 1 : -1);
      });
    },
  };
}
