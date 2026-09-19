import * as vscode from 'vscode';

export interface RecentEntry {
  fullPath: string;
  openedAt: number;
}

const KEY = 'folderize.recentEntries';
const LEGACY_KEY = 'folderize.recentPaths';
const MAX_RECENTS = 10;

let memento: vscode.Memento | undefined;

export function initRecents(globalState: vscode.Memento): void {
  memento = globalState;
}

function readEntries(): RecentEntry[] {
  if (!memento) {
    return [];
  }
  const entries = memento.get<RecentEntry[]>(KEY);
  if (entries) {
    return entries.slice(0, MAX_RECENTS);
  }
  // First read after upgrading from the old plain-paths format: there's no
  // timestamp to recover, so treat them as having no known access time.
  const legacyPaths = memento.get<string[]>(LEGACY_KEY, []);
  return legacyPaths.slice(0, MAX_RECENTS).map((fullPath) => ({ fullPath, openedAt: 0 }));
}

export function getRecentEntries(): RecentEntry[] {
  return readEntries();
}

export function getRecentPaths(): string[] {
  return readEntries().map((e) => e.fullPath);
}

export async function recordRecentOpen(fullPath: string): Promise<void> {
  if (!memento) {
    return;
  }
  const current = readEntries().filter((e) => e.fullPath !== fullPath);
  current.unshift({ fullPath, openedAt: Date.now() });
  await memento.update(KEY, current.slice(0, MAX_RECENTS));
}

export async function pruneRecents(existingPaths: Set<string>): Promise<void> {
  if (!memento) {
    return;
  }
  const current = readEntries();
  const pruned = current.filter((e) => existingPaths.has(e.fullPath));
  if (pruned.length !== current.length) {
    await memento.update(KEY, pruned);
  }
}

export async function clearRecents(): Promise<void> {
  await memento?.update(KEY, []);
}

export async function restoreRecentEntries(entries: RecentEntry[]): Promise<void> {
  await memento?.update(KEY, entries.slice(0, MAX_RECENTS));
}

export async function restoreRecents(paths: string[]): Promise<void> {
  await restoreRecentEntries(paths.map((fullPath) => ({ fullPath, openedAt: 0 })));
}
