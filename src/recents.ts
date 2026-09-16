import * as vscode from 'vscode';

const KEY = 'folderize.recentPaths';
const MAX_RECENTS = 10;

let memento: vscode.Memento | undefined;

export function initRecents(globalState: vscode.Memento): void {
  memento = globalState;
}

export function getRecentPaths(): string[] {
  return memento?.get<string[]>(KEY, []) ?? [];
}

export async function recordRecentOpen(fullPath: string): Promise<void> {
  if (!memento) {
    return;
  }
  const current = getRecentPaths().filter((p) => p !== fullPath);
  current.unshift(fullPath);
  await memento.update(KEY, current.slice(0, MAX_RECENTS));
}

export async function pruneRecents(existingPaths: Set<string>): Promise<void> {
  if (!memento) {
    return;
  }
  const current = getRecentPaths();
  const pruned = current.filter((p) => existingPaths.has(p));
  if (pruned.length !== current.length) {
    await memento.update(KEY, pruned);
  }
}

export async function clearRecents(): Promise<void> {
  await memento?.update(KEY, []);
}
