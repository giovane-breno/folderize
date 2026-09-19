import * as fs from 'fs';
import * as vscode from 'vscode';
import {
  getCategories,
  getProjectMeta,
  getUncategorizedPosition,
  listProjects,
  ProjectMeta,
  saveCategories,
  saveProjectMeta,
} from './projects';
import { OPEN_FOLDER_COLOR_ID } from './theme';
import { hasDockerCompose, isDockerAvailable, isDockerRunning } from './docker';

export const UNCATEGORIZED = '__uncategorized__';
export const PROJECT_MIME_TYPE = 'application/vnd.code.tree.folderizeProjects';
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
    this.contextValue = categoryId === UNCATEGORIZED ? 'uncategorized' : 'category';
    this.iconPath = new vscode.ThemeIcon('folder-opened');
    if (containsOpenProject) {
      this.resourceUri = vscode.Uri.from({ scheme: 'folderize', path: `category:${categoryId}`, query: 'open' });
    }
  }
}

export class ProjectTreeItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly fullPath: string,
    public readonly categoryId: string,
    public readonly isFavorite: boolean,
    showPinIcon: boolean = isFavorite,
    lastOpenedAt?: number
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);

    const exists = fs.existsSync(fullPath);
    const hasCompose = exists && hasDockerCompose(fullPath);
    const dockerUnavailable = hasCompose && !isDockerAvailable();
    const baseContextValue = !exists ? 'projectMissing' : isFavorite ? 'projectFavorite' : 'project';
    const dockerSuffix = !hasCompose
      ? ''
      : dockerUnavailable
      ? ' docker-unavailable'
      : isDockerRunning(fullPath)
      ? ' docker-running'
      : ' docker-stopped';
    this.contextValue = baseContextValue + dockerSuffix;

    const isOpen =
      exists && (vscode.workspace.workspaceFolders ?? []).some((f) => f.uri.fsPath === fullPath);

    if (!exists) {
      this.tooltip = `${fullPath} (${vscode.l10n.t('not found on disk')})`;
      this.iconPath = new vscode.ThemeIcon('warning');
      this.resourceUri = vscode.Uri.from({ scheme: 'folderize', authority: 'missing', path: fullPath });
    } else {
      let tooltip = isOpen ? `${fullPath} (${vscode.l10n.t('open in this window')})` : fullPath;
      if (lastOpenedAt) {
        const exact = new Date(lastOpenedAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
        tooltip += `\n${vscode.l10n.t('Last opened: {0}', exact)}`;
      }
      this.tooltip = tooltip;
      this.iconPath = isOpen
        ? new vscode.ThemeIcon('folder-active', new vscode.ThemeColor(OPEN_FOLDER_COLOR_ID))
        : new vscode.ThemeIcon(showPinIcon ? 'pinned' : 'folder');

      const flags = [isOpen && 'open', hasCompose && (dockerUnavailable ? 'docker-unavailable' : 'docker')]
        .filter(Boolean)
        .join('&');
      if (flags) {
        this.resourceUri = vscode.Uri.from({ scheme: 'folderize', path: fullPath, query: flags });
      }

      const branch = getGitBranch(fullPath);
      const lastOpened = lastOpenedAt ? formatRelativeTime(lastOpenedAt) : undefined;
      this.description = [branch, lastOpened].filter(Boolean).join(' · ') || undefined;
    }

    this.command = {
      command: 'folderize.openProject',
      title: vscode.l10n.t('Open project'),
      arguments: [this],
    };
  }
}

type FolderizeTreeItem = CategoryTreeItem | ProjectTreeItem;

export class ProjectsTreeProvider
  implements vscode.TreeDataProvider<FolderizeTreeItem>, vscode.TreeDragAndDropController<FolderizeTreeItem>
{
  readonly dropMimeTypes = [PROJECT_MIME_TYPE, CATEGORY_MIME_TYPE, 'text/uri-list'];
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

    for (const id of orderedIds) {
      if (id === UNCATEGORIZED) {
        const uncategorized = allProjects
          .filter((p) => !meta[p.fullPath]?.category)
          .sort((a, b) => compareByOrder(meta, a.fullPath, b.fullPath))
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

    const filtered = listProjects().filter(
      (p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === categoryId
    );

    filtered.sort((a, b) => compareByOrder(meta, a.fullPath, b.fullPath));
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
      return;
    }

    const uriListTransfer = dataTransfer.get('text/uri-list');
    if (uriListTransfer) {
      await this.handleExternalDrop(uriListTransfer);
    }
  }

  // Dragging a folder in from the OS Explorer view (or the system file manager)
  // delivers it as a standard 'text/uri-list' payload rather than our internal
  // MIME types — hand the paths off to the command that decides project vs. root.
  private async handleExternalDrop(item: vscode.DataTransferItem): Promise<void> {
    const raw = await item.asString();
    const paths = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        try {
          return vscode.Uri.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((uri): uri is vscode.Uri => !!uri && uri.scheme === 'file')
      .map((uri) => uri.fsPath)
      .filter((fsPath) => {
        try {
          return fs.statSync(fsPath).isDirectory();
        } catch {
          return false;
        }
      });

    if (paths.length > 0) {
      await vscode.commands.executeCommand('folderize.addDroppedPaths', paths);
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

    const allInCategory = listProjects()
      .filter((p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === targetCategoryId)
      .sort((a, b) => compareByOrder(meta, a.fullPath, b.fullPath))
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

    await saveProjectMeta(meta);
    this.refresh();
  }
}

// Favorite status only controls membership in the Favorites view — it must not
// reorder projects within the main Projects tree.
function compareByOrder(meta: ProjectMeta, pathA: string, pathB: string): number {
  return (meta[pathA]?.order ?? 0) - (meta[pathB]?.order ?? 0);
}

// Re-reading and re-parsing .git/HEAD on every tree render (every project, every
// view) is wasted work when the branch hasn't changed since the last render — a
// cheap `stat` to compare mtime is enough to tell, so the read+regex only happens
// when the file actually changed.
const gitBranchCache = new Map<string, { mtimeMs: number; branch: string | undefined }>();

function getGitBranch(projectPath: string): string | undefined {
  const headPath = `${projectPath}/.git/HEAD`;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(headPath).mtimeMs;
  } catch {
    gitBranchCache.delete(projectPath);
    return undefined;
  }

  const cached = gitBranchCache.get(projectPath);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.branch;
  }

  let branch: string | undefined;
  try {
    const content = fs.readFileSync(headPath, 'utf8').trim();
    const match = content.match(/^ref:\s*refs\/heads\/(.+)$/);
    // HEAD "solto" (detached): mostra os 7 primeiros caracteres do commit.
    branch = match ? match[1] : content.length >= 7 ? content.slice(0, 7) : undefined;
  } catch {
    branch = undefined;
  }

  gitBranchCache.set(projectPath, { mtimeMs, branch });
  return branch;
}

function formatRelativeTime(timestamp: number): string {
  const now = new Date();
  const then = new Date(timestamp);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(then)) / 86400000);
  const time = then.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

  if (dayDiff <= 0) {
    return vscode.l10n.t('Today, {0}', time);
  }
  if (dayDiff === 1) {
    return vscode.l10n.t('Yesterday, {0}', time);
  }
  if (dayDiff < 7) {
    return vscode.l10n.t('{0} days ago', dayDiff);
  }

  const weekDiff = Math.round(dayDiff / 7);
  if (dayDiff < 30) {
    return weekDiff === 1 ? vscode.l10n.t('1 week ago') : vscode.l10n.t('{0} weeks ago', weekDiff);
  }

  const monthDiff = Math.round(dayDiff / 30);
  if (dayDiff < 365) {
    return monthDiff === 1 ? vscode.l10n.t('1 month ago') : vscode.l10n.t('{0} months ago', monthDiff);
  }

  const yearDiff = Math.round(dayDiff / 365);
  return yearDiff === 1 ? vscode.l10n.t('1 year ago') : vscode.l10n.t('{0} years ago', yearDiff);
}
