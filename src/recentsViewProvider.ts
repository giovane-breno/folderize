import * as vscode from 'vscode';
import { getProjectMeta, listProjects } from './projects';
import { ProjectTreeItem, UNCATEGORIZED } from './projectsTreeProvider';
import { getRecentEntries } from './recents';

export class RecentsViewProvider implements vscode.TreeDataProvider<ProjectTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: ProjectTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): ProjectTreeItem[] {
    const meta = getProjectMeta();
    const byPath = new Map(listProjects().map((p) => [p.fullPath, p]));
    return getRecentEntries()
      .map((entry) => {
        const p = byPath.get(entry.fullPath);
        return p ? { project: p, openedAt: entry.openedAt } : undefined;
      })
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map(
        ({ project: p, openedAt }) =>
          new ProjectTreeItem(
            p.label,
            p.fullPath,
            meta[p.fullPath]?.category ?? UNCATEGORIZED,
            !!meta[p.fullPath]?.favorite,
            false,
            openedAt || undefined
          )
      );
  }
}
