import * as THREE from 'three';

export function decodeAnatomy(buffer: ArrayBuffer): THREE.BufferGeometry {
  if (buffer.byteLength < 12) throw new Error('Anatomy mesh is truncated.');
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x314e5242) throw new Error('Unsupported anatomy mesh format.');
  const vertices = view.getUint32(4, true),
    triangles = view.getUint32(8, true);
  if (!vertices || !triangles || buffer.byteLength !== 12 + vertices * 16 + triangles * 12)
    throw new Error('Anatomy mesh has invalid dimensions.');
  const positions = new Float32Array(buffer, 12, vertices * 3);
  const shades = new Float32Array(buffer, 12 + vertices * 12, vertices);
  const indices = new Uint32Array(buffer, 12 + vertices * 16, triangles * 3);
  if (
    !positions.every(Number.isFinite) ||
    !shades.every(Number.isFinite) ||
    indices.some((index) => index >= vertices)
  )
    throw new Error('Anatomy mesh has invalid coordinates or faces.');
  const colors = new Float32Array(vertices * 3);
  for (let i = 0; i < vertices; i++) colors.fill(shades[i], i * 3, i * 3 + 3);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function disposeAnatomy(group: THREE.Group) {
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        material.dispose();
    }
  });
}

const palette: Record<string, string> = {
  accumbens: '#cfa269',
  amygdala: '#ce8587',
  caudate: '#79a399',
  hippocampus: '#bc97b1',
  pallidum: '#bda75f',
  putamen: '#8e9cbd',
  thalamus: '#d29b76',
  ventricle: '#89bcca',
  cerebellum: '#c58c9a',
  brainstem: '#d4a59c',
  ventral: '#c5ad84',
  white: '#e8d9d0',
  corpus: '#ead7b3',
  third: '#89bcca',
  fourth: '#89bcca',
};

export async function loadAnatomy(signal: AbortSignal, color = '#df9ca3') {
  const cortex = new THREE.Group(),
    subcortex = new THREE.Group();
  try {
    const response = await fetch('/anatomy/manifest.json', { signal });
    if (!response.ok) throw new Error(`Anatomy manifest returned HTTP ${response.status}.`);
    const manifest = (await response.json()) as {
      version: number;
      meshes: Array<{ name: string; file: string; kind: string }>;
    };
    if (manifest.version !== 1 || !Array.isArray(manifest.meshes) || manifest.meshes.length !== 28)
      throw new Error('The anatomy manifest is incomplete.');
    const results = await Promise.allSettled(
      manifest.meshes.map(async (entry) => {
        if (!/^[a-z-]+\.bin$/.test(entry.file)) throw new Error('Invalid anatomy asset path.');
        const response = await fetch(`/anatomy/${entry.file}`, { signal });
        if (!response.ok) throw new Error(`Anatomy surface returned HTTP ${response.status}.`);
        const geometry = decodeAnatomy(await response.arrayBuffer());
        const isCortex = entry.kind === 'cortex';
        const material = new THREE.MeshPhysicalMaterial({
          color: isCortex ? color : palette[entry.name.split('-')[0]] || '#bcaaa0',
          vertexColors: isCortex,
          roughness: isCortex ? 0.66 : 0.48,
          metalness: 0,
          clearcoat: isCortex ? 0.06 : 0.1,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = entry.name;
        mesh.userData.anatomyKind = entry.kind;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        (isCortex ? cortex : subcortex).add(mesh);
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    return { cortex, subcortex };
  } catch (error) {
    disposeAnatomy(cortex);
    disposeAnatomy(subcortex);
    throw error;
  }
}

export function setAnatomyMode(cortex: THREE.Group, subcortex: THREE.Group, enabled: boolean) {
  subcortex.visible = true;
  subcortex.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const kind = object.userData.anatomyKind;
    object.visible = enabled || kind === 'hindbrain';
    const material = object.material as THREE.MeshPhysicalMaterial;
    const translucent = kind === 'white-matter' || (kind === 'ventricle' && enabled);
    material.transparent = translucent;
    material.opacity = kind === 'white-matter' ? 0.11 : translucent ? 0.4 : 1;
    material.depthWrite = !translucent;
    material.needsUpdate = true;
    object.castShadow = !translucent;
  });
  cortex.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      const material = object.material as THREE.MeshPhysicalMaterial;
      material.transparent = enabled;
      material.opacity = enabled ? 0.13 : 1;
      material.depthWrite = !enabled;
      material.needsUpdate = true;
      object.castShadow = !enabled;
    }
  });
}
