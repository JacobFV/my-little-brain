#!/usr/bin/env python3
"""Convert public fsaverage/ENIGMA template surfaces to compact browser meshes.

Requires numpy and nibabel. Reads only the explicitly named public template files.
Usage: python scripts/convert-anatomy.py --assets /path/to/win/data/assets
"""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import struct
import nibabel as nib
import numpy as np
from scipy.ndimage import gaussian_filter
from skimage.measure import marching_cubes

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assets', type=Path, required=True)
parser.add_argument('--output', type=Path, default=Path('apps/web/public/anatomy'))
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
manifest = {'version': 1, 'description': 'Modified public population-template visualization geometry, not individual anatomy.',
            'coordinates': 'Input FreeSurfer RAS mm -> scene [-R, S-15, A+17] * 0.015 + [0,0.35,0]. Anterior faces viewer; anatomical right is viewer left.',
            'sources': [], 'meshes': []}
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def source(path, upstream):
    manifest['sources'].append({'path': str(path.relative_to(args.assets)), 'sha256': sha(path), 'upstream': upstream})
def write_mesh(name, vertices, faces, kind, sulc=None):
    vertices = np.asarray(vertices, dtype=np.float32).copy()
    faces = np.asarray(faces, dtype=np.uint32)
    assert vertices.ndim == faces.ndim == 2 and vertices.shape[1] == faces.shape[1] == 3
    assert np.isfinite(vertices).all() and faces.max() < len(vertices)
    # A proper rotation (determinant +1) preserves winding and anatomical laterality.
    vertices = np.column_stack([-vertices[:,0], vertices[:,2]-15, vertices[:,1]+17]) * .015
    vertices[:,1] += .35
    shade = np.ones(len(vertices), dtype=np.float32)
    if sulc is not None:
        assert len(sulc) == len(vertices)
        shade = (.88 - .16 * np.tanh(np.asarray(sulc, dtype=np.float32))).astype(np.float32)
    # Header + position(float32 xyz) + shade(float32) + triangle(uint32 ijk).
    data = struct.pack('<4sII', b'BRN1', len(vertices), len(faces)) + vertices.astype('<f4').tobytes() + shade.astype('<f4').tobytes() + faces.astype('<u4').tobytes()
    target = args.output / (name + '.bin'); target.write_bytes(data)
    manifest['meshes'].append({'name': name, 'kind': kind, 'file': target.name, 'vertices': len(vertices), 'triangles': len(faces), 'bytes': len(data), 'sha256': sha(target)})

template = args.assets / 'cache/neuromaps/atlases/fsaverage'
for hemi in ['L', 'R']:
    pial = template / f'tpl-fsaverage_den-41k_hemi-{hemi}_pial.surf.gii'
    sulc = template / f'tpl-fsaverage_den-41k_hemi-{hemi}_desc-sulc_midthickness.shape.gii'
    image = nib.load(pial)
    vertices, faces = image.darrays[0].data, image.darrays[1].data
    source(pial, 'https://netneurolab.github.io/neuromaps/generated/neuromaps.datasets.fetch_fsaverage.html')
    source(sulc, 'https://netneurolab.github.io/neuromaps/generated/neuromaps.datasets.fetch_fsaverage.html')
    write_mesh('cortex-' + hemi.lower(), vertices, faces, 'cortex', nib.load(sulc).darrays[0].data)

enigma = args.assets / 'src/enigma'
surfaces = enigma / 'enigmatoolbox/datasets/surfaces'
names = ['accumbens', 'amygdala', 'caudate', 'hippocampus', 'pallidum', 'putamen', 'thalamus', 'ventricle']
# Published vertex ordering from ENIGMA subcorticalvertices(), not inferred labels.
counts = {'lh': [867,1419,3012,3784,1446,4003,3726,7653], 'rh': [838,1457,3208,3742,1373,3871,3699,7180]}
for hemi in ['lh', 'rh']:
    path = surfaces / f'sctx_{hemi}.gii'
    image = nib.load(path); vertices, faces = image.darrays[0].data, image.darrays[1].data
    source(path, 'https://github.com/MICA-MNI/ENIGMA/tree/b08974b55243060cbc1fad12c87048037446e8f7/enigmatoolbox/datasets/surfaces')
    assert sum(counts[hemi]) == len(vertices)
    start = 0; total_faces = 0
    for name, count in zip(names, counts[hemi]):
        selected = faces[np.all((faces >= start) & (faces < start + count), axis=1)]
        total_faces += len(selected)
        write_mesh(name + '-' + hemi[0], vertices[start:start+count], selected-start, 'ventricle' if name == 'ventricle' else 'subcortex')
        start += count
    assert total_faces == len(faces), 'A triangle crosses the published structure boundaries.'
# Public fsaverage segmentation, never a participant's volume. Its tkregister
# voxel-to-RAS transform aligns with the FreeSurfer surface coordinate frame.
aseg = args.assets.parent / 'mne-sample/processed-v6/MNE-sample-data/subjects/fsaverage/mri/aseg.mgz'
volume = nib.load(aseg)
labels = np.asarray(volume.dataobj)
manifest['sources'].append({'path': str(aseg.relative_to(args.assets.parent)), 'sha256': sha(aseg), 'upstream': 'https://surfer.nmr.mgh.harvard.edu/fswiki/FsAverage'})
structures = [
    ('cerebellum-l', [7, 8], 'hindbrain'), ('cerebellum-r', [46, 47], 'hindbrain'),
    ('brainstem', [16], 'hindbrain'),
    ('ventral-diencephalon-l', [28], 'subcortex'), ('ventral-diencephalon-r', [60], 'subcortex'),
    ('white-matter-l', [2], 'white-matter'), ('white-matter-r', [41], 'white-matter'),
    ('third-ventricle', [14], 'ventricle'), ('fourth-ventricle', [15], 'ventricle'),
    ('corpus-callosum', [251, 252, 253, 254, 255], 'subcortex'),
]
for name, ids, kind in structures:
    mask = np.isin(labels, ids)
    assert mask.any(), f'Missing template labels for {name}'
    # Smooth the 1 mm segmentation boundary by 0.65 voxels, avoiding blocky
    # voxel stair steps. This is segmented anatomy, not surface-distribution data.
    field = gaussian_filter(mask.astype(np.float32), .65)
    voxels, faces, _, _ = marching_cubes(field, .5, step_size=1, allow_degenerate=False)
    vertices = nib.affines.apply_affine(volume.header.get_vox2ras_tkr(), voxels)
    # tkregister's orientation reverses marching-cubes winding into outward
    # surface normals; retain these face indices after the voxel transform.
    write_mesh(name, vertices, faces, kind)
    manifest['meshes'][-1]['segmentationLabels'] = ids
    manifest['meshes'][-1]['processing'] = 'fsaverage aseg; gaussian sigma 0.65 voxel; marching cubes level 0.5; tkregister RAS'
shutil.copyfile(enigma / 'LICENSE', args.output / 'LICENSE-ENIGMA.txt')
(args.output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f"Exported {len(manifest['meshes'])} meshes: {sum(m['triangles'] for m in manifest['meshes']):,} triangles, {sum(m['bytes'] for m in manifest['meshes']):,} bytes")
