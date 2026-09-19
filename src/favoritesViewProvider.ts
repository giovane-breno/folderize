import * as vscode from 'vscode';
import { getProjectMeta, listProjects, saveProjectMeta } from './projects';
import { PROJECT_MIME_TYPE, ProjectTreeItem, UNCATEGORIZED } from './projectsTreeProvider';

export class FavoritesViewProvider
  implements vscode.TreeDataProvider<ProjectTreeItem>, vscode.TreeDragAndDropController<ProjectTreeItem>
{
  readonly dropMimeTypes = [PROJECT_MIME_TYPE];
  readonly dragMimeTypes = [PROJECT_MIME_TYPE];

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
    return listProjects()
      .filter((p) => meta[p.fullPath]?.favorite)
      .sort((a, b) => (meta[a.fullPath]?.favoriteOrder ?? 0) - (meta[b.fullPath]?.favoriteOrder ?? 0))
      .map(
        (p) =>
          new ProjectTreeItem(p.label, p.fullPath, meta[p.fullPath]?.category ?? UNCATEGORIZED, true, true)
      );
  }

  async handleDrag(source: readonly ProjectTreeItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
    dataTransfer.set(
      PROJECT_MIME_TYPE,
      new vscode.DataTransferItem(source.map((item) => item.fullPath))
    );
  }

  async handleDrop(target: ProjectTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const transfer = dataTransfer.get(PROJECT_MIME_TYPE);
    if (!transfer) {
      return;
    }
    const draggedPaths: string[] = transfer.value;
    if (!draggedPaths || draggedPaths.length === 0) {
      return;
    }

    const meta = getProjectMeta();
    const favorites = listProjects()
      .filter((p) => meta[p.fullPath]?.favorite)
      .sort((a, b) => (meta[a.fullPath]?.favoriteOrder ?? 0) - (meta[b.fullPath]?.favoriteOrder ?? 0))
      .map((p) => p.fullPath);

    const draggedOriginalIndex = favorites.indexOf(draggedPaths[0]);
    const isNewFavorite = draggedOriginalIndex === -1;

    const siblingPaths = favorites.filter((p) => !draggedPaths.includes(p));

    let insertIndex = siblingPaths.length;
    if (!isNewFavorite && target) {
      const targetOriginalIndex = favorites.indexOf(target.fullPath);
      const droppedFromAbove = targetOriginalIndex !== -1 && draggedOriginalIndex < targetOriginalIndex;
      const idx = siblingPaths.indexOf(target.fullPath);
      insertIndex = idx === -1 ? siblingPaths.length : idx + (droppedFromAbove ? 1 : 0);
    }

    const newOrder = [...siblingPaths];
    newOrder.splice(insertIndex, 0, ...draggedPaths);

    newOrder.forEach((p, idx) => {
      meta[p] = { ...meta[p], favorite: true, favoriteOrder: idx };
    });

    await saveProjectMeta(meta);
    this.refresh();
  }
}
