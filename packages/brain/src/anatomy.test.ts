import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeAnatomy } from './anatomy';

const base = new URL('../../../apps/web/public/anatomy/', import.meta.url);
describe('public template anatomy assets', () => {
  it('verifies every shipped surface against the provenance manifest', () => {
    const manifest = JSON.parse(readFileSync(new URL('manifest.json', base), 'utf8'));
    expect(manifest.meshes).toHaveLength(28);
    let triangles = 0;
    for (const entry of manifest.meshes) {
      const bytes = readFileSync(new URL(entry.file, base));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      const geometry = decodeAnatomy(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      expect(geometry.getAttribute('position').count).toBe(entry.vertices);
      expect(geometry.index!.count / 3).toBe(entry.triangles);
      expect(geometry.boundingSphere!.radius).toBeGreaterThan(0);
      if (entry.segmentationLabels) {
        const positions = geometry.getAttribute('position');
        const indices = geometry.index!;
        let volume = 0;
        for (let i = 0; i < indices.count; i += 3) {
          const a = indices.getX(i),
            b = indices.getX(i + 1),
            c = indices.getX(i + 2);
          volume +=
            positions.getX(a) *
              (positions.getY(b) * positions.getZ(c) - positions.getZ(b) * positions.getY(c)) +
            positions.getY(a) *
              (positions.getZ(b) * positions.getX(c) - positions.getX(b) * positions.getZ(c)) +
            positions.getZ(a) *
              (positions.getX(b) * positions.getY(c) - positions.getY(b) * positions.getX(c));
        }
        expect(volume).toBeGreaterThan(0);
      }
      triangles += entry.triangles;
      geometry.dispose();
    }
    expect(triangles).toBeGreaterThan(300000);
    expect(manifest.meshes.map((entry: { name: string }) => entry.name)).toEqual(
      expect.arrayContaining([
        'brainstem',
        'cerebellum-l',
        'cerebellum-r',
        'white-matter-l',
        'white-matter-r',
        'ventral-diencephalon-l',
        'ventral-diencephalon-r',
        'third-ventricle',
        'fourth-ventricle',
        'corpus-callosum',
      ]),
    );
  });
  it('rejects malformed files instead of rendering misleading geometry', () => {
    expect(() => decodeAnatomy(new ArrayBuffer(4))).toThrow('truncated');
    expect(() => decodeAnatomy(new ArrayBuffer(12))).toThrow('format');
    const bytes = readFileSync(new URL('cortex-l.bin', base));
    expect(() =>
      decodeAnatomy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 40)),
    ).toThrow('dimensions');
  });
});
