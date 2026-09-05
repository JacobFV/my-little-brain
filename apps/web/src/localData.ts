import { restoreWorkspace, uid, type Workspace, type Twin } from '@little-brain/core';
export const WORKSPACE_KEY = 'little-brain.workspace.v1';
export const MAX_BACKUP_BYTES = 12_000_000;
export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export function parseBackup(raw: string): Workspace {
  if (new TextEncoder().encode(raw).length > MAX_BACKUP_BYTES)
    throw new Error('This backup exceeds the 12 MB import limit.');
  const restored = restoreWorkspace(raw);
  if (!restored)
    throw new Error('This is not a valid My Little Brain workspace backup. Nothing was changed.');
  // Explicitly retain workspace fields only; imported secrets/unknown metadata stay out.
  return {
    version: 1,
    activeId: restored.activeId,
    twins: restored.twins.map((t) => ({
      id: t.id,
      name: t.name,
      personality: t.personality,
      color: t.color,
      createdAt: t.createdAt,
      messages: t.messages.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        x: m.x,
        y: m.y,
        createdAt: m.createdAt,
        status: m.status,
      })),
      activity: t.activity.map((a) => ({ id: a.id, text: a.text, createdAt: a.createdAt })),
    })),
  };
}
export function mergeBackup(current: Workspace, incoming: Workspace): Workspace {
  const twins: Twin[] = [...current.twins];
  for (const twin of incoming.twins) {
    const existing = twins.find((t) => t.id === twin.id);
    if (existing && JSON.stringify(existing) === JSON.stringify(twin)) continue;
    twins.push(
      existing ? { ...twin, id: uid(), name: `${twin.name.slice(0, 29)} (imported)` } : twin,
    );
  }
  if (twins.length > 50)
    throw new Error('This import would exceed 50 twins. Export or reduce the backup first.');
  return { ...current, twins };
}

/** Keeps the last observed value so another tab's changes never get silently clobbered. */
export class WorkspaceStorage {
  raw: string | null = null;
  blocked = false;
  error = '';
  constructor(private storage: StorageLike) {}
  load(): Workspace | null {
    try {
      this.raw = this.storage.getItem(WORKSPACE_KEY);
      if (this.raw === null) return null;
      return parseBackup(this.raw);
    } catch {
      this.blocked = true;
      this.error =
        'Saved data is unreadable or storage is unavailable. Automatic saving is paused to preserve it. Open Local data to recover or export.';
      return null;
    }
  }
  save(workspace: Workspace): boolean {
    if (this.blocked) return false;
    try {
      if (this.storage.getItem(WORKSPACE_KEY) !== this.raw) {
        this.blocked = true;
        this.error =
          'Another tab or restore changed the saved workspace. Saving is paused. Export this window before reloading, or archive the saved copy in Local data.';
        return false;
      }
      const next = JSON.stringify(workspace);
      this.storage.setItem(WORKSPACE_KEY, next);
      this.raw = next;
      this.error = '';
      return true;
    } catch {
      this.error =
        'Local storage is full or unavailable. Your current workspace is in memory; export a backup before closing.';
      return false;
    }
  }
  resume(raw: string) {
    this.raw = raw;
    this.blocked = false;
    this.error = '';
  }
}

/** Deliberate recovery: retain the exact existing bytes before replacing the main key. */
export function archiveAndSave(storage: StorageLike, workspace: Workspace): string {
  const prior = storage.getItem(WORKSPACE_KEY);
  if (prior !== null) storage.setItem(`${WORKSPACE_KEY}.recovery.${Date.now()}.${uid()}`, prior);
  const raw = JSON.stringify(workspace);
  storage.setItem(WORKSPACE_KEY, raw);
  return raw;
}

export const AUXILIARY_KEYS = [
  'little-brain.settings',
  'little-brain.attention.v1',
  'little-brain.background.v1',
] as const;
export type LocalBackup = {
  format: 'little-brain-backup';
  version: 1;
  workspace: Workspace;
  local: Record<string, string>;
};
function safeAuxiliary(key: string, raw: string): string {
  const parsed = JSON.parse(raw);
  if (key === 'little-brain.settings') {
    const { showThoughts, reducedMotion, endpoint, chatWidth } = parsed ?? {};
    return JSON.stringify({ showThoughts, reducedMotion, endpoint, chatWidth });
  }
  return JSON.stringify(parsed);
}
export function exportLocalBackup(workspace: Workspace, storage: StorageLike): LocalBackup {
  const local: Record<string, string> = {};
  for (const key of AUXILIARY_KEYS) {
    const raw = storage.getItem(key);
    if (raw !== null) {
      try {
        local[key] = safeAuxiliary(key, raw);
      } catch {
        /* preserve unreadable bytes in place */
      }
    }
  }
  return {
    format: 'little-brain-backup',
    version: 1,
    workspace: parseBackup(JSON.stringify(workspace)),
    local,
  };
}
export function parseLocalBackup(raw: string): LocalBackup {
  if (new TextEncoder().encode(raw).length > MAX_BACKUP_BYTES)
    throw new Error('This backup exceeds the 12 MB import limit.');
  const value = JSON.parse(raw);
  if (value?.format !== 'little-brain-backup')
    return { format: 'little-brain-backup', version: 1, workspace: parseBackup(raw), local: {} };
  if (value.version !== 1) throw new Error('This backup version is unsupported.');
  const workspace = parseBackup(JSON.stringify(value.workspace));
  const local: Record<string, string> = {};
  for (const key of AUXILIARY_KEYS)
    if (typeof value.local?.[key] === 'string') local[key] = safeAuxiliary(key, value.local[key]);
  return { format: 'little-brain-backup', version: 1, workspace, local };
}
/** Never overwrite a conflicting local journal or preference: archive the imported version. */
export function restoreAuxiliary(backup: LocalBackup, storage: StorageLike): void {
  for (const [key, value] of Object.entries(backup.local)) {
    const current = storage.getItem(key);
    if (current === value) continue;
    storage.setItem(current === null ? key : `${key}.recovery.${Date.now()}.${uid()}`, value);
  }
}
