import * as vscode from 'vscode';
import { getProjectMeta, listProjects } from './projects';
import { ProjectTreeItem, UNCATEGORIZED } from './projectsTreeProvider';
import { getRecentPaths } from './recents';

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
    return getRecentPaths()
      .map((fullPath) => byPath.get(fullPath))
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map(
        (p) =>
          new ProjectTreeItem(
            p.label,
            p.fullPath,
            meta[p.fullPath]?.category ?? UNCATEGORIZED,
            !!meta[p.fullPath]?.favorite,
            false
          )
      );
  }
}
