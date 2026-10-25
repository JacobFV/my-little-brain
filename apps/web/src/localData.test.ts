import { describe, it, expect } from 'vitest';
import { createTwin } from '@little-brain/core';
import {
  WorkspaceStorage,
  WORKSPACE_KEY,
  exportLocalBackup,
  parseLocalBackup,
  restoreAuxiliary,
  mergeBackup,
} from './localData';
function memory() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}
const twin = createTwin('Pip');
const workspace = { version: 1 as const, activeId: twin.id, twins: [twin] };
describe('private local data', () => {
  it('preserves unreadable data and concurrent updates', () => {
    const storage = memory();
    storage.setItem(WORKSPACE_KEY, '{broken');
    const broken = new WorkspaceStorage(storage);
    expect(broken.load()).toBeNull();
    expect(broken.save(workspace)).toBe(false);
    expect(storage.getItem(WORKSPACE_KEY)).toBe('{broken');
    storage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
    const store = new WorkspaceStorage(storage);
    store.load();
    storage.setItem(WORKSPACE_KEY, 'other tab');
    expect(store.save(workspace)).toBe(false);
    expect(storage.getItem(WORKSPACE_KEY)).toBe('other tab');
  });
  it('backs up allowlisted auxiliary data while excluding credentials', () => {
    const storage = memory();
    storage.setItem(
      'little-brain.settings',
      JSON.stringify({ token: 'secret', showThoughts: true }),
    );
    storage.setItem('little-brain.token', 'secret');
    storage.setItem('little-brain.background.v1', '[]');
    const raw = JSON.stringify(exportLocalBackup(workspace, storage));
    expect(raw).not.toContain('secret');
    expect(parseLocalBackup(raw).local['little-brain.background.v1']).toBe('[]');
    expect(parseLocalBackup(JSON.stringify(workspace)).workspace).toEqual(workspace);
  });
  it('archives conflicting imports and keeps existing twins', () => {
    const storage = memory();
    storage.setItem('little-brain.attention.v1', '{"pip":0.5}');
    const backup = {
      ...exportLocalBackup(workspace, storage),
      local: { 'little-brain.attention.v1': '{"pip":0.8}' },
    };
    restoreAuxiliary(backup, storage);
    expect(storage.getItem('little-brain.attention.v1')).toBe('{"pip":0.5}');
    expect([...storage.values.keys()].some((key) => key.includes('.recovery.'))).toBe(true);
    expect(
      mergeBackup(workspace, { ...workspace, twins: [{ ...twin, name: 'Other' }] }).twins,
    ).toHaveLength(2);
  });
});
