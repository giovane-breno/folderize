import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export class RootFolderTreeItem extends vscode.TreeItem {
  constructor(public readonly fullPath: string, exists: boolean) {
    super(path.basename(fullPath) || fullPath, vscode.TreeItemCollapsibleState.Expanded);
    this.description = fullPath;
    this.contextValue = exists ? 'rootFolder' : 'rootFolderMissing';
    this.iconPath = new vscode.ThemeIcon(exists ? 'folder-library' : 'warning');
    this.tooltip = exists ? fullPath : `${fullPath} (${vscode.l10n.t('not found on disk')})`;
  }
}

type StatKind = 'found' | 'ignored' | 'missing';

export class RootStatTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    icon: string,
    public readonly kind?: StatKind,
    public readonly rootPath?: string,
    expandable: boolean = false
  ) {
    super(label, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

// A single project name under a root's "found"/"ignored" group — deliberately
// plain (just the name) so this stays a quick glance, not a second project tree.
export class RootChildItem extends vscode.TreeItem {
  constructor(public readonly fullPath: string, kind: Exclude<StatKind, undefined>) {
    super(path.basename(fullPath) || fullPath, vscode.TreeItemCollapsibleState.None);
    this.tooltip = fullPath;

    if (kind === 'ignored') {
      this.contextValue = 'ignoredPath';
      this.iconPath = new vscode.ThemeIcon('eye-closed');
    } else if (kind === 'missing') {
      this.contextValue = 'rootMissingPath';
      this.iconPath = new vscode.ThemeIcon('warning');
    } else {
      this.contextValue = 'foundPath';
      this.iconPath = new vscode.ThemeIcon('folder');
      this.command = {
        command: 'folderize.openProject',
        title: vscode.l10n.t('Open project'),
        arguments: [this],
      };
    }
  }
}

type RootsTreeItem = RootFolderTreeItem | RootStatTreeItem | RootChildItem;

interface RootFolderStats {
  exists: boolean;
  foundCount: number;
  ignoredCount: number;
  missingCount: number;
}

function getRootSubfolders(root: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(root, entry.name));
}

function getRootChildPaths(root: string, kind: 'found' | 'ignored'): string[] {
  const excludedPaths = new Set(
    vscode.workspace.getConfiguration('folderize').get<string[]>('excludedPaths', [])
  );
  return getRootSubfolders(root).filter((p) => (kind === 'ignored' ? excludedPaths.has(p) : !excludedPaths.has(p)));
}

// Found/ignored count immediate subfolders (what listProjects() would also scan);
// missing counts individually-added projects (folderize.projects) that live directly
// under this root but were deleted from disk — the root's own equivalent of the
// "projectMissing" warning already shown for those entries in the main tree.
function getRootFolderStats(root: string): RootFolderStats {
  const exists = fs.existsSync(root);
  if (!exists) {
    return { exists: false, foundCount: 0, ignoredCount: 0, missingCount: 0 };
  }

  const config = vscode.workspace.getConfiguration('folderize');
  const explicitProjects = config.get<string[]>('projects', []);
  const excludedPaths = new Set(config.get<string[]>('excludedPaths', []));
  const subfolderPaths = getRootSubfolders(root);

  const ignoredCount = subfolderPaths.filter((p) => excludedPaths.has(p)).length;
  const foundCount = subfolderPaths.length - ignoredCount;

  const resolvedRoot = path.resolve(root);
  const missingCount = explicitProjects.filter(
    (p) => path.resolve(path.dirname(p)) === resolvedRoot && !fs.existsSync(p)
  ).length;

  return { exists, foundCount, ignoredCount, missingCount };
}

export class RootsTreeProvider implements vscode.TreeDataProvider<RootsTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: RootsTreeItem): vscode.TreeItem {
    return element;
  }

  getRootFolders(): string[] {
    return vscode.workspace.getConfiguration('folderize').get<string[]>('rootFolders', []);
  }

  getChildren(element?: RootsTreeItem): RootsTreeItem[] {
    if (element instanceof RootFolderTreeItem) {
      const stats = getRootFolderStats(element.fullPath);
      if (!stats.exists) {
        return [new RootStatTreeItem(vscode.l10n.t('Path not found on disk'), 'warning')];
      }

      const items: RootStatTreeItem[] = [];
      items.push(
        new RootStatTreeItem(
          stats.foundCount === 1
            ? vscode.l10n.t('1 project found')
            : vscode.l10n.t('{0} projects found', stats.foundCount),
          'folder',
          'found',
          element.fullPath,
          stats.foundCount > 0
        )
      );
      if (stats.ignoredCount > 0) {
        items.push(
          new RootStatTreeItem(
            stats.ignoredCount === 1
              ? vscode.l10n.t('1 ignored')
              : vscode.l10n.t('{0} ignored', stats.ignoredCount),
            'eye-closed',
            'ignored',
            element.fullPath,
            true
          )
        );
      }
      if (stats.missingCount > 0) {
        items.push(
          new RootStatTreeItem(
            stats.missingCount === 1
              ? vscode.l10n.t('1 missing path')
              : vscode.l10n.t('{0} missing paths', stats.missingCount),
            'warning'
          )
        );
      }
      return items;
    }

    if (element instanceof RootStatTreeItem && (element.kind === 'found' || element.kind === 'ignored') && element.rootPath) {
      return getRootChildPaths(element.rootPath, element.kind).map(
        (p) => new RootChildItem(p, element.kind as 'found' | 'ignored')
      );
    }

    return this.getRootFolders().map((root) => new RootFolderTreeItem(root, fs.existsSync(root)));
  }
}
