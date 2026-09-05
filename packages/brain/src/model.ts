import * as THREE from 'three';

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, segments = 60) {
  return new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), segments, radius, 7, false),
    material,
  );
}

export function createBrain(color = '#e8a3aa') {
  const group = new THREE.Group();
  const skin = new THREE.MeshPhysicalMaterial({
    color,
    roughness: 0.52,
    metalness: 0,
    clearcoat: 0.12,
    clearcoatRoughness: 0.65,
  });
  const nerve = new THREE.MeshStandardMaterial({ color: '#ecc4b4', roughness: 0.7 });
  const bone = new THREE.MeshStandardMaterial({ color: '#f1dfc7', roughness: 0.64 });
  const eyeWhite = new THREE.MeshPhysicalMaterial({
    color: '#fffdf4',
    roughness: 0.23,
    clearcoat: 0.7,
  });
  const irisMat = new THREE.MeshStandardMaterial({ color: '#887649', roughness: 0.55 });
  const irisDark = new THREE.MeshStandardMaterial({ color: '#3d4030', roughness: 0.65 });
  const pupilMat = new THREE.MeshBasicMaterial({ color: '#182322' });
  const catchlightMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
  const eyes: THREE.Group[] = [];
  const eyeRoots: THREE.Group[] = [];
  // The cortical and subcortical surfaces are loaded from public templates.
  // Only the character attachments below are stylized procedural geometry.
  const cortex = new THREE.Group();
  const subcortex = new THREE.Group();
  group.add(cortex, subcortex);
  for (const side of [-1, 1]) {
    const eyeRoot = new THREE.Group();
    eyeRoot.position.set(side * 0.47, -0.43, 1.06);
    const eyeball = new THREE.Group();
    const white = new THREE.Mesh(new THREE.SphereGeometry(0.255, 40, 32), eyeWhite);
    white.castShadow = true;
    eyeball.add(white);
    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.115, 32, 24), irisMat);
    iris.scale.z = 0.2;
    iris.position.z = 0.243;
    eyeball.add(iris);
    const irisRing = new THREE.Mesh(new THREE.TorusGeometry(0.107, 0.009, 8, 48), irisDark);
    irisRing.position.z = 0.252;
    eyeball.add(irisRing);
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2;
      const fiber = tube(
        [
          new THREE.Vector3(Math.cos(a) * 0.051, Math.sin(a) * 0.051, 0.266),
          new THREE.Vector3(Math.cos(a + 0.045) * 0.08, Math.sin(a + 0.045) * 0.08, 0.264),
          new THREE.Vector3(Math.cos(a) * 0.103, Math.sin(a) * 0.103, 0.257),
        ],
        0.0019,
        irisDark,
        5,
      );
      eyeball.add(fiber);
    }
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.058, 24, 20), pupilMat);
    pupil.scale.z = 0.15;
    pupil.position.z = 0.269;
    eyeball.add(pupil);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.021, 12, 12), catchlightMat);
    glint.scale.z = 0.3;
    glint.position.set(-0.037, 0.041, 0.28);
    eyeball.add(glint);
    eyeRoot.add(eyeball);
    group.add(eyeRoot);
    eyes.push(eyeball);
    eyeRoots.push(eyeRoot);
    for (let k = 0; k < 8; k++) {
      const offset = (k - 3.5) * 0.015;
      group.add(
        tube(
          [
            new THREE.Vector3(side * 0.24 + offset, -0.46, 0.1),
            new THREE.Vector3(side * 0.35 + offset, -0.59, 0.37),
            new THREE.Vector3(side * 0.47 + offset, -0.44 + offset, 0.91),
          ],
          0.013,
          nerve,
          20,
        ),
      );
    }
  }
  // The actual brainstem comes from fsaverage. This short cervical extension
  // starts at the medulla and follows a gentle posterior curve, with a taper.
  const cordCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.008, -0.88, -0.397),
    new THREE.Vector3(0.005, -1.02, -0.37),
    new THREE.Vector3(0.018, -1.29, -0.3),
    new THREE.Vector3(0.008, -1.54, -0.235),
    new THREE.Vector3(0, -1.75, -0.22),
  ]);
  const cordGeometry = new THREE.TubeGeometry(cordCurve, 56, 1, 16, false);
  const cordPositions = cordGeometry.attributes.position;
  for (let row = 0; row <= 56; row++) {
    const t = row / 56,
      center = cordCurve.getPointAt(t);
    const radius = 0.085 * (1 - 0.5 * t) + 0.023 * Math.exp(-Math.pow((t - 0.2) * 5, 2));
    for (let col = 0; col <= 16; col++) {
      const i = row * 17 + col;
      cordPositions.setXYZ(
        i,
        center.x + (cordPositions.getX(i) - center.x) * radius,
        center.y + (cordPositions.getY(i) - center.y) * radius,
        center.z + (cordPositions.getZ(i) - center.z) * radius,
      );
    }
  }
  cordGeometry.computeVertexNormals();
  const cord = new THREE.Mesh(cordGeometry, skin);
  cord.name = 'stylized-cervical-cord';
  group.add(cord);
  for (let row = 0; row < 7; row++) {
    const t = 0.15 + row * 0.11,
      center = cordCurve.getPointAt(t);
    for (const side of [-1, 1])
      for (const anterior of [-1, 1])
        for (let rootlet = 0; rootlet < 3; rootlet++) {
          const offset = (rootlet - 1) * 0.013;
          const root = tube(
            [
              new THREE.Vector3(
                center.x + side * 0.07,
                center.y + offset,
                center.z + anterior * 0.025,
              ),
              new THREE.Vector3(side * 0.15, center.y - 0.025 + offset, center.z + anterior * 0.04),
              new THREE.Vector3(
                side * (0.29 - row * 0.013),
                center.y - 0.09,
                center.z + anterior * 0.07,
              ),
              new THREE.Vector3(side * (0.36 - row * 0.015), center.y - 0.13, center.z + 0.015),
            ],
            0.0065,
            nerve,
            20,
          );
          root.name = 'stylized-cervical-rootlet';
          group.add(root);
        }
  }
  for (let i = 0; i < 4; i++) {
    const center = cordCurve.getPointAt(0.57 + i * 0.115);
    const vertebra = new THREE.Group();
    vertebra.name = 'stylized-cervical-vertebra';
    vertebra.position.copy(center);
    vertebra.position.z -= 0.015;
    vertebra.rotation.x = -0.12;
    const arch = new THREE.Mesh(
      new THREE.TorusGeometry(0.12 - i * 0.007, 0.03, 10, 28, Math.PI * 1.8),
      bone,
    );
    arch.rotation.x = Math.PI / 2;
    vertebra.add(arch);
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.085, 18, 14), bone);
    body.scale.set(1.35, 0.52, 0.7);
    body.position.z = 0.115;
    vertebra.add(body);
    for (const side of [-1, 1]) {
      const wing = new THREE.Mesh(new THREE.SphereGeometry(0.05, 14, 10), bone);
      wing.scale.set(1.7, 0.45, 0.65);
      wing.position.set(side * 0.135, 0, -0.01);
      vertebra.add(wing);
    }
    group.add(vertebra);
  }
  group.rotation.x = 0.045;
  return { group, eyes, eyeRoots, cortex, subcortex };
}
