import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  getCategories,
  getProjectMeta,
  getUncategorizedPosition,
  listProjects,
  ProjectMeta,
  saveCategories,
} from './projects';
import { OPEN_FOLDER_COLOR_ID } from './theme';

export const UNCATEGORIZED = '__uncategorized__';
export const PINNED = '__pinned__';
const PROJECT_MIME_TYPE = 'application/vnd.code.tree.folderizeProjects';
const CATEGORY_MIME_TYPE = 'application/vnd.code.tree.folderizeCategories';

export function getOrderedCategoryIds(usedCategories: Set<string>): string[] {
  // Defensivo: versões antigas podiam ter salvo o marcador junto com nomes reais.
  const combined = getCategories().filter((c) => c !== UNCATEGORIZED);
  for (const c of usedCategories) {
    if (!combined.includes(c)) {
      combined.push(c);
    }
  }

  const pos = getUncategorizedPosition();
  const insertAt = pos === -1 || pos > combined.length ? combined.length : pos;
  combined.splice(insertAt, 0, UNCATEGORIZED);
  return combined;
}

export class CategoryTreeItem extends vscode.TreeItem {
  constructor(
    public readonly categoryId: string,
    label: string,
    count: number,
    containsOpenProject: boolean
  ) {
    super(`${label} (${count})`, vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue =
      categoryId === UNCATEGORIZED ? 'uncategorized' : categoryId === PINNED ? 'pinnedCategory' : 'category';
    this.iconPath = new vscode.ThemeIcon(categoryId === PINNED ? 'pinned' : 'folder-opened');
    if (containsOpenProject) {
      this.resourceUri = vscode.Uri.from({ scheme: 'folderize', path: `category:${categoryId}` });
    }
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fullPath: string,
    public readonly categoryId: string,
    isFavorite: boolean,
    showPinIcon: boolean = isFavorite
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    const exists = fs.existsSync(fullPath);
    this.contextValue = !exists
      ? 'projectMissing'
      : isFavorite
      ? 'projectFavorite'
      : 'project';

    const isOpen =
      exists && (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === fullPath);

    if (!exists) {
      this.tooltip = `${fullPath} (não encontrado no disco)`;
      this.iconPath = new vscode.ThemeIcon('warning');
      this.resourceUri = vscode.Uri.from({ scheme: 'folderize', authority: 'missing', path: fullPath });
    } else {
      this.tooltip = isOpen ? `${fullPath} (aberto nesta janela)` : fullPath;
      this.iconPath = isOpen
        ? new vscode.ThemeIcon('folder-active', new vscode.ThemeColor(OPEN_FOLDER_COLOR_ID))
        : new vscode.ThemeIcon(showPinIcon ? 'pinned' : 'folder');
      if (isOpen) {
        this.resourceUri = vscode.Uri.from({ scheme: 'folderize', path: fullPath });
      }
    }

    this.command = {
      command: 'folderize.openProject',
      title: 'Abrir projeto',
      arguments: [this],
    };
  }
}

type FolderizeTreeItem = CategoryTreeItem | ProjectTreeItem;

export class ProjectsTreeProvider
  implements vscode.TreeDataProvider<FolderizeTreeItem>, vscode.TreeDragAndDropController<FolderizeTreeItem>
{
  readonly dropMimeTypes = [PROJECT_MIME_TYPE, CATEGORY_MIME_TYPE];
  readonly dragMimeTypes = [PROJECT_MIME_TYPE, CATEGORY_MIME_TYPE];

  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: FolderizeTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: FolderizeTreeItem): FolderizeTreeItem[] {
    if (element instanceof CategoryTreeItem) {
      return this.getProjectsForCategory(element.categoryId);
    }

    const meta = getProjectMeta();
    const allProjects = listProjects();

    const usedCategories = new Set(
      allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
    );
    const orderedIds = getOrderedCategoryIds(usedCategories);

    const openPaths = new Set((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));

    const items: FolderizeTreeItem[] = [];

    const pinnedCount = allProjects.filter((p) => meta[p.fullPath]?.favorite).length;
    if (pinnedCount > 0) {
      const pinnedHasOpen = allProjects.some((p) => meta[p.fullPath]?.favorite && openPaths.has(p.fullPath));
      items.push(new CategoryTreeItem(PINNED, 'Fixados', pinnedCount, pinnedHasOpen));
    }

    for (const id of orderedIds) {
      if (id === UNCATEGORIZED) {
        const uncategorized = allProjects
          .filter((p) => !meta[p.fullPath]?.category)
          .sort((a, b) => compareByFavoriteThenOrder(meta, a.fullPath, b.fullPath))
          .map(
            (p) =>
              new ProjectTreeItem(p.label, p.fullPath, UNCATEGORIZED, !!meta[p.fullPath]?.favorite, false)
          );
        items.push(...uncategorized);
      } else {
        const projectsInCategory = allProjects.filter((p) => meta[p.fullPath]?.category === id);
        const hasOpen = projectsInCategory.some((p) => openPaths.has(p.fullPath));
        items.push(new CategoryTreeItem(id, id, projectsInCategory.length, hasOpen));
      }
    }

    return items;
  }

  private getProjectsForCategory(categoryId: string): ProjectTreeItem[] {
    const meta = getProjectMeta();

    if (categoryId === PINNED) {
      return listProjects()
        .filter((p) => meta[p.fullPath]?.favorite)
        .sort((a, b) => (meta[a.fullPath]?.order ?? 0) - (meta[b.fullPath]?.order ?? 0))
        .map(
          (p) =>
            new ProjectTreeItem(p.label, p.fullPath, meta[p.fullPath]?.category ?? UNCATEGORIZED, true, true)
        );
    }

    const filtered = listProjects().filter(
      (p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === categoryId
    );

    filtered.sort((a, b) => compareByFavoriteThenOrder(meta, a.fullPath, b.fullPath));
    return filtered.map(
      (p) => new ProjectTreeItem(p.label, p.fullPath, categoryId, !!meta[p.fullPath]?.favorite, false)
    );
  }

  async handleDrag(source: readonly FolderizeTreeItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
    const projectPaths = source
      .filter((item): item is ProjectTreeItem => item instanceof ProjectTreeItem)
      .map((item) => item.fullPath);
    if (projectPaths.length > 0) {
      dataTransfer.set(PROJECT_MIME_TYPE, new vscode.DataTransferItem(projectPaths));
    }

    const categoryIds = source
      .filter((item): item is CategoryTreeItem => item instanceof CategoryTreeItem)
      .filter((item) => item.categoryId !== PINNED)
      .map((item) => item.categoryId);
    if (categoryIds.length > 0) {
      dataTransfer.set(CATEGORY_MIME_TYPE, new vscode.DataTransferItem(categoryIds));
    }
  }

  async handleDrop(target: FolderizeTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const categoryTransfer = dataTransfer.get(CATEGORY_MIME_TYPE);
    if (categoryTransfer) {
      await this.handleCategoryDrop(target, categoryTransfer.value);
      return;
    }

    const projectTransfer = dataTransfer.get(PROJECT_MIME_TYPE);
    if (projectTransfer) {
      await this.handleProjectDrop(target, projectTransfer.value);
    }
  }

  private async handleCategoryDrop(
    target: FolderizeTreeItem | undefined,
    draggedIds: string[]
  ): Promise<void> {
    if (!draggedIds || draggedIds.length === 0) {
      return;
    }

    const meta = getProjectMeta();
    const allProjects = listProjects();
    const usedCategories = new Set(
      allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
    );
    const order = getOrderedCategoryIds(usedCategories);

    const draggedId = draggedIds[0];
    const fromIndex = order.indexOf(draggedId);
    if (fromIndex === -1) {
      return;
    }

    const targetCategoryId =
      target instanceof CategoryTreeItem
        ? target.categoryId
        : target instanceof ProjectTreeItem
        ? target.categoryId
        : undefined;
    const targetOriginalIndex = targetCategoryId ? order.indexOf(targetCategoryId) : -1;
    const droppedFromAbove = targetOriginalIndex !== -1 && fromIndex < targetOriginalIndex;

    order.splice(fromIndex, 1);

    let targetIndex = order.length;
    if (targetCategoryId) {
      const idx = order.indexOf(targetCategoryId);
      targetIndex = idx === -1 ? order.length : idx + (droppedFromAbove ? 1 : 0);
    }

    order.splice(targetIndex, 0, draggedId);
    await saveCategories(order, UNCATEGORIZED);
    this.refresh();
  }

  private async handleProjectDrop(
    target: FolderizeTreeItem | undefined,
    draggedPaths: string[]
  ): Promise<void> {
    if (!draggedPaths || draggedPaths.length === 0) {
      return;
    }

    const targetCategoryId =
      target instanceof CategoryTreeItem
        ? target.categoryId
        : target instanceof ProjectTreeItem
        ? target.categoryId
        : UNCATEGORIZED;

    const meta = getProjectMeta();

    if (targetCategoryId === PINNED) {
      for (const p of draggedPaths) {
        meta[p] = { ...meta[p], favorite: true };
      }
      await saveMeta(meta);
      this.refresh();
      return;
    }

    const allInCategory = listProjects()
      .filter((p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === targetCategoryId)
      .sort((a, b) => compareByFavoriteThenOrder(meta, a.fullPath, b.fullPath))
      .map((p) => p.fullPath);

    const draggedOriginalIndex = allInCategory.indexOf(draggedPaths[0]);
    const isCrossCategoryMove = draggedOriginalIndex === -1;

    const siblingPaths = allInCategory.filter((p) => !draggedPaths.includes(p));

    let insertIndex = siblingPaths.length;
    if (!isCrossCategoryMove && target instanceof ProjectTreeItem) {
      const targetOriginalIndex = allInCategory.indexOf(target.fullPath);
      const droppedFromAbove = targetOriginalIndex !== -1 && draggedOriginalIndex < targetOriginalIndex;
      const idx = siblingPaths.indexOf(target.fullPath);
      insertIndex = idx === -1 ? siblingPaths.length : idx + (droppedFromAbove ? 1 : 0);
    }

    const newOrder = [...siblingPaths];
    newOrder.splice(insertIndex, 0, ...draggedPaths);

    newOrder.forEach((p, idx) => {
      meta[p] = {
        ...meta[p],
        category: targetCategoryId === UNCATEGORIZED ? undefined : targetCategoryId,
        order: idx,
      };
    });

    await saveMeta(meta);
    this.refresh();
  }
}

async function saveMeta(meta: ReturnType<typeof getProjectMeta>): Promise<void> {
  await vscode.workspace
    .getConfiguration('folderize')
    .update('projectMeta', meta, vscode.ConfigurationTarget.Global);
}

function compareByFavoriteThenOrder(meta: ProjectMeta, pathA: string, pathB: string): number {
  const favA = meta[pathA]?.favorite ? 1 : 0;
  const favB = meta[pathB]?.favorite ? 1 : 0;
  if (favA !== favB) {
    return favB - favA;
  }
  return (meta[pathA]?.order ?? 0) - (meta[pathB]?.order ?? 0);
}
