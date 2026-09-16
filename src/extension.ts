import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getCategories,
  getProjectMeta,
  invalidateSubfolderCache,
  isFromScannedRootFolder,
  listProjects,
  removeProjectEverywhere,
  renameCategoryEverywhere,
  removeCategoryEverywhere,
  saveCategories,
  saveProjectMeta,
  unexcludePath,
  updateProjectMeta,
} from './projects';
import {
  CategoryTreeItem,
  getOrderedCategoryIds,
  ProjectTreeItem,
  ProjectsTreeProvider,
  UNCATEGORIZED,
} from './projectsTreeProvider';
import { FavoritesViewProvider } from './favoritesViewProvider';
import { HelpViewProvider } from './helpViewProvider';
import { OpenFolderDecorationProvider } from './openFolderDecorationProvider';
import { openReorderPanel, ReorderCategory } from './reorderPanel';
import { clearRecents, initRecents, pruneRecents, recordRecentOpen } from './recents';
import { RecentsViewProvider } from './recentsViewProvider';

export function activate(context: vscode.ExtensionContext) {
  let manageSaveListener: vscode.Disposable | undefined;

  initRecents(context.globalState);
  pruneRecents(new Set(listProjects().map((p) => p.fullPath)));

  const treeProvider = new ProjectsTreeProvider();
  const treeView = vscode.window.createTreeView('folderize.projectsView', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
  });

  const favoritesProvider = new FavoritesViewProvider();
  const favoritesView = vscode.window.createTreeView('folderize.favoritesView', {
    treeDataProvider: favoritesProvider,
    dragAndDropController: favoritesProvider,
  });
  context.subscriptions.push(favoritesView);

  const recentsProvider = new RecentsViewProvider();
  const recentsView = vscode.window.createTreeView('folderize.recentsView', {
    treeDataProvider: recentsProvider,
  });
  context.subscriptions.push(recentsView);

  function refreshAll(): void {
    treeProvider.refresh();
    favoritesProvider.refresh();
    recentsProvider.refresh();
  }

  const decorationProvider = new OpenFolderDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      'folderize.helpView',
      new HelpViewProvider(context.extension.packageJSON.version)
    )
  );

  function describeCount(count: number): string {
    return count === 1 ? vscode.l10n.t('1 project') : vscode.l10n.t('{0} projects', count);
  }

  function updateDescription(): void {
    treeView.description = describeCount(listProjects().length);
  }
  updateDescription();
  context.subscriptions.push(treeProvider.onDidChangeTreeData(() => updateDescription()));

  function updateFavoritesDescription(): void {
    const count = favoritesProvider.getChildren().length;
    favoritesView.description = describeCount(count);
    vscode.commands.executeCommand('setContext', 'folderize.hasFavorites', count > 0);
  }
  updateFavoritesDescription();
  context.subscriptions.push(favoritesProvider.onDidChangeTreeData(() => updateFavoritesDescription()));

  function updateRecentsDescription(): void {
    const count = recentsProvider.getChildren().length;
    recentsView.description = count > 0 ? describeCount(count) : undefined;
  }
  updateRecentsDescription();
  context.subscriptions.push(recentsProvider.onDidChangeTreeData(() => updateRecentsDescription()));

  let folderWatchers: vscode.Disposable[] = [];
  function setupFolderWatchers(): void {
    folderWatchers.forEach((w) => w.dispose());
    folderWatchers = [];

    const roots = vscode.workspace.getConfiguration('folderize').get<string[]>('rootFolders', []);
    for (const root of roots) {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*'));
      watcher.onDidCreate(async (uri) => {
        invalidateSubfolderCache(root);
        const name = path.basename(uri.fsPath);
        let isRealDirectory = false;
        if (!name.startsWith('.')) {
          try {
            isRealDirectory = !!fs.statSync(uri.fsPath, { throwIfNoEntry: false })?.isDirectory();
          } catch {
            isRealDirectory = false;
          }
        }
        if (isRealDirectory) {
          // New folder is hidden until the user confirms, so it doesn't show up
          // in the tree before they've had a chance to decide.
          const config = vscode.workspace.getConfiguration('folderize');
          const excludedPaths = config.get<string[]>('excludedPaths', []);
          if (!excludedPaths.includes(uri.fsPath)) {
            await config.update(
              'excludedPaths',
              [...excludedPaths, uri.fsPath],
              vscode.ConfigurationTarget.Global
            );
          }

          const add = vscode.l10n.t('Add');
          const ignore = vscode.l10n.t('Ignore');
          const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t('Folderize detected a new folder: "{0}". Add it?', name),
            add,
            ignore
          );
          if (choice === add) {
            await unexcludePath(uri.fsPath);
          }
        }
        refreshAll();
      });
      watcher.onDidDelete(() => {
        invalidateSubfolderCache(root);
        refreshAll();
      });
      folderWatchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }
  setupFolderWatchers();

  async function addRootFolderPath(newPath: string): Promise<void> {
    const subfolderPaths = getSubfolderPaths(newPath);

    if (subfolderPaths.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('No subfolders found in "{0}".', path.basename(newPath)));
      return;
    }

    const picked = await vscode.window.showQuickPick(
      subfolderPaths.map((p) => ({
        label: path.basename(p),
        description: p,
        picked: true,
        fullPath: p,
      })),
      {
        canPickMany: true,
        placeHolder: vscode.l10n.t('Select projects to add ({0} found)', subfolderPaths.length),
      }
    );
    if (!picked) {
      return;
    }

    const config = vscode.workspace.getConfiguration('folderize');
    const current = config.get<string[]>('rootFolders', []);
    if (!current.includes(newPath)) {
      await config.update('rootFolders', [...current, newPath], vscode.ConfigurationTarget.Global);
    }
    await unexcludePath(newPath);
    await updateProjectMeta(newPath, { favorite: false });

    const selectedPaths = new Set(picked.map((p) => p.fullPath));
    const excludedPaths = config.get<string[]>('excludedPaths', []);
    const newExcluded = new Set(excludedPaths);
    for (const subPath of subfolderPaths) {
      if (selectedPaths.has(subPath)) {
        newExcluded.delete(subPath);
      } else {
        newExcluded.add(subPath);
      }
    }
    await config.update('excludedPaths', [...newExcluded], vscode.ConfigurationTarget.Global);

    refreshAll();

    vscode.window.showInformationMessage(
      vscode.l10n.t('{0} project(s) added from "{1}".', picked.length, path.basename(newPath))
    );
  }

  async function addProjectPath(newPath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('folderize');
    const current = config.get<string[]>('projects', []);
    if (!current.includes(newPath)) {
      await config.update('projects', [...current, newPath], vscode.ConfigurationTarget.Global);
    }
    await unexcludePath(newPath);
    await updateProjectMeta(newPath, { favorite: false });
    refreshAll();
    vscode.window.showInformationMessage(vscode.l10n.t('Project added: {0}.', path.basename(newPath)));
  }

  async function detectSiblingProjects(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return;
    }

    const currentPath = folders[0].uri.fsPath;
    const parentDir = path.dirname(currentPath);
    const ignoredParents = context.globalState.get<string[]>('folderize.ignoredScanParents', []);
    if (ignoredParents.includes(parentDir)) {
      return;
    }

    const tracked = new Set(listProjects().map((p) => p.fullPath));
    const excludedPaths = new Set(
      vscode.workspace.getConfiguration('folderize').get<string[]>('excludedPaths', [])
    );

    const candidates = getSubfolderPaths(parentDir).filter(
      (p) => p !== currentPath && looksLikeProject(p) && !tracked.has(p) && !excludedPaths.has(p)
    );

    if (candidates.length === 0) {
      return;
    }

    const addAll = vscode.l10n.t('Add All');
    const review = vscode.l10n.t('Review');
    const ignore = vscode.l10n.t('Ignore');

    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Folderize found {0} new project(s) near "{1}". Add them?',
        candidates.length,
        path.basename(currentPath)
      ),
      addAll,
      review,
      ignore
    );

    if (choice === addAll) {
      for (const p of candidates) {
        await addProjectPath(p);
      }
    } else if (choice === review) {
      const picked = await vscode.window.showQuickPick(
        candidates.map((p) => ({
          label: path.basename(p),
          description: p,
          picked: true,
          fullPath: p,
        })),
        { canPickMany: true, placeHolder: vscode.l10n.t('Select the projects to add ({0} found)', candidates.length) }
      );
      for (const p of picked ?? []) {
        await addProjectPath(p.fullPath);
      }
    } else if (choice === ignore) {
      await context.globalState.update('folderize.ignoredScanParents', [...ignoredParents, parentDir]);
    }
  }

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.tooltip = vscode.l10n.t('Folderize: open quick project search');
  statusBarItem.command = 'folderize.quickOpen';
  statusBarItem.show();

  function updateStatusBarItem(): void {
    const folders = vscode.workspace.workspaceFolders;
    const name =
      folders && folders.length > 0 ? path.basename(folders[0].uri.fsPath) : vscode.l10n.t('Projects');
    statusBarItem.text = `$(folder-library) ${name}`;
  }
  updateStatusBarItem();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBarItem()));

  context.subscriptions.push(
    treeView,
    statusBarItem,

    vscode.commands.registerCommand('folderize.showVersion', () => {
      vscode.window.showInformationMessage(`Folderize v${context.extension.packageJSON.version}`);
    }),

    vscode.commands.registerCommand('folderize.openGithub', () => {
      const url = context.extension.packageJSON.repository?.url as string | undefined;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t("Folderize doesn't have a public repository yet."));
      }
    }),

    vscode.commands.registerCommand('folderize.reportIssue', () => {
      const url = context.extension.packageJSON.bugs?.url as string | undefined;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage(
          vscode.l10n.t("Folderize doesn't have a public repository to report issues yet.")
        );
      }
    }),

    vscode.commands.registerCommand('folderize.starRepo', () => {
      const url = context.extension.packageJSON.repository?.url as string | undefined;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
        vscode.window.showInformationMessage(vscode.l10n.t('Thanks! Leave a star on GitHub ⭐'));
      } else {
        vscode.window.showInformationMessage(vscode.l10n.t("Folderize doesn't have a public repository yet."));
      }
    }),

    vscode.commands.registerCommand('folderize.quickOpen', async () => {
      const projects = listProjects();
      const projectPaths = new Set(projects.map((p) => p.fullPath));
      const meta = getProjectMeta();

      type QuickOpenItem = vscode.QuickPickItem & { fullPath?: string; addCurrent?: boolean };
      const items: QuickOpenItem[] = [];

      const openFolders = vscode.workspace.workspaceFolders ?? [];
      const currentFolderNotAdded = openFolders.find((f) => !projectPaths.has(f.uri.fsPath));
      if (currentFolderNotAdded) {
        items.push({
          label: `$(save) ${vscode.l10n.t('Add current folder')}`,
          description: currentFolderNotAdded.uri.fsPath,
          addCurrent: true,
        });
      }

      const pinned = projects.filter((p) => meta[p.fullPath]?.favorite);
      if (pinned.length > 0) {
        items.push({ label: vscode.l10n.t('Favorites'), kind: vscode.QuickPickItemKind.Separator });
        items.push(
          ...pinned.map((p) => ({ label: p.label, description: p.fullPath, fullPath: p.fullPath }))
        );
      }

      const grouped = new Map<string, typeof projects>();
      for (const p of projects) {
        const category = meta[p.fullPath]?.category ?? UNCATEGORIZED;
        if (!grouped.has(category)) {
          grouped.set(category, []);
        }
        grouped.get(category)!.push(p);
      }

      const usedCategories = new Set(
        projects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
      );
      const orderedIds = getOrderedCategoryIds(usedCategories).filter((id) => grouped.has(id));

      for (const id of orderedIds) {
        items.push({
          label: id === UNCATEGORIZED ? vscode.l10n.t('Uncategorized') : id,
          kind: vscode.QuickPickItemKind.Separator,
        });
        items.push(
          ...grouped.get(id)!.map((p) => ({ label: p.label, description: p.fullPath, fullPath: p.fullPath }))
        );
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No projects added yet.'));
        return;
      }

      const picked = await vscode.window.showQuickPick(items, { placeHolder: vscode.l10n.t('Search project...') });
      if (!picked) {
        return;
      }
      if (picked.addCurrent) {
        vscode.commands.executeCommand('folderize.addCurrentFolder');
        return;
      }
      if (picked.fullPath) {
        vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(picked.fullPath),
          { forceNewWindow: false }
        );
      }
    }),

    vscode.commands.registerCommand('folderize.refresh', async () => {
      invalidateSubfolderCache();
      await pruneRecents(new Set(listProjects().map((p) => p.fullPath)));
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.openProject', async (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('Folder not found on disk: {0}', item.fullPath));
        return;
      }
      await recordRecentOpen(item.fullPath);
      refreshAll();
      vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(item.fullPath),
        { forceNewWindow: false }
      );
    }),

    vscode.commands.registerCommand('folderize.openProjectInNewWindow', async (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('Folder not found on disk: {0}', item.fullPath));
        return;
      }
      await recordRecentOpen(item.fullPath);
      refreshAll();
      vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(item.fullPath),
        { forceNewWindow: true }
      );
    }),

    vscode.commands.registerCommand('folderize.openInTerminal', (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('Folder not found on disk: {0}', item.fullPath));
        return;
      }
      const terminal = vscode.window.createTerminal({ name: item.label, cwd: item.fullPath });
      terminal.show();
    }),

    vscode.commands.registerCommand('folderize.revealInFileManager', (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('Folder not found on disk: {0}', item.fullPath));
        return;
      }
      vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.fullPath));
    }),

    vscode.commands.registerCommand('folderize.copyPath', async (item: ProjectTreeItem) => {
      await vscode.env.clipboard.writeText(item.fullPath);
      vscode.window.showInformationMessage(vscode.l10n.t('Path copied.'));
    }),

    vscode.commands.registerCommand('folderize.openProjectGithub', async (item: ProjectTreeItem) => {
      const configPath = path.join(item.fullPath, '.git', 'config');
      if (!fs.existsSync(configPath)) {
        vscode.window.showInformationMessage(vscode.l10n.t('"{0}" is not a Git repository.', item.label));
        return;
      }
      const gitConfig = fs.readFileSync(configPath, 'utf8');
      const match = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
      if (!match) {
        vscode.window.showInformationMessage(
          vscode.l10n.t('"{0}" does not have an "origin" remote configured.', item.label)
        );
        return;
      }
      let url = match[1].trim();
      if (url.startsWith('git@')) {
        url = url.replace(':', '/').replace('git@', 'https://');
      }
      url = url.replace(/\.git$/, '');
      vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('folderize.renameProject', async (item: ProjectTreeItem) => {
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New display name for the project'),
        value: item.label,
      });
      if (!newName || newName === item.label) {
        return;
      }
      await updateProjectMeta(item.fullPath, { displayName: newName });
      refreshAll();
    }),

    vscode.commands.registerCommand(
      'folderize.removeProject',
      async (item: ProjectTreeItem, selected?: ProjectTreeItem[]) => {
        const targets = selected && selected.length > 0 ? selected : [item];
        const fromRootFolder = targets.filter((t) => isFromScannedRootFolder(t.fullPath));

        if (fromRootFolder.length > 0) {
          const names = fromRootFolder.map((t) => t.label).join(', ');
          const confirm = await vscode.window.showWarningMessage(
            fromRootFolder.length === 1
              ? vscode.l10n.t(
                  'Remove "{0}" from the listing? The folder stays on disk, but is hidden until you add it again.',
                  names
                )
              : vscode.l10n.t(
                  'Remove {0} folders ({1}) from the listing? They stay on disk, but are hidden until you add them again.',
                  fromRootFolder.length,
                  names
                ),
            { modal: true },
            vscode.l10n.t('Remove')
          );
          if (confirm !== vscode.l10n.t('Remove')) {
            return;
          }
        }

        for (const target of targets) {
          await removeProjectEverywhere(target.fullPath);
        }
        refreshAll();
      }
    ),

    vscode.commands.registerCommand(
      'folderize.toggleFavorite',
      async (item: ProjectTreeItem, selected?: ProjectTreeItem[]) => {
        const targets = selected && selected.length > 0 ? selected : [item];
        const isFavorite = item.contextValue === 'projectFavorite';
        for (const target of targets) {
          await updateProjectMeta(target.fullPath, { favorite: !isFavorite });
        }
        refreshAll();
      }
    ),

    vscode.commands.registerCommand('folderize.addCategory', async () => {
      const raw = await vscode.window.showInputBox({ prompt: vscode.l10n.t('New category name') });
      const name = raw?.trim();
      if (!name) {
        return;
      }
      const categories = getCategories();
      const exists = categories.some((c) => c.trim().toLowerCase() === name.toLowerCase());
      if (exists) {
        vscode.window.showErrorMessage(vscode.l10n.t('A category named "{0}" already exists.', name));
        return;
      }
      await saveCategories([...categories, name]);
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.renameCategory', async (item: CategoryTreeItem) => {
      const newName = await vscode.window.showInputBox({
        prompt: vscode.l10n.t('New category name'),
        value: item.categoryId,
      });
      if (!newName || newName === item.categoryId) {
        return;
      }
      const ok = await renameCategoryEverywhere(item.categoryId, newName);
      if (!ok) {
        vscode.window.showErrorMessage(vscode.l10n.t('A category named "{0}" already exists.', newName));
        return;
      }
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.removeCategory', async (item: CategoryTreeItem) => {
      const meta = getProjectMeta();
      const count = listProjects().filter((p) => meta[p.fullPath]?.category === item.categoryId).length;

      if (count > 0) {
        const confirm = await vscode.window.showWarningMessage(
          count === 1
            ? vscode.l10n.t('Remove category "{0}"? 1 project moves back to "Uncategorized".', item.categoryId)
            : vscode.l10n.t(
                'Remove category "{0}"? {1} projects move back to "Uncategorized".',
                item.categoryId,
                count
              ),
          { modal: true },
          vscode.l10n.t('Remove')
        );
        if (confirm !== vscode.l10n.t('Remove')) {
          return;
        }
      }

      await removeCategoryEverywhere(item.categoryId);
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.clearRecents', async () => {
      await clearRecents();
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.addCurrentFolder', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No folder is open in this window.'));
        return;
      }

      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({
              placeHolder: vscode.l10n.t('Which open folder do you want to add?'),
            });
      if (!folder) {
        return;
      }
      await addProjectPath(folder.uri.fsPath);
    }),

    vscode.commands.registerCommand('folderize.add', async () => {
      const hasOpenFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;

      const options: { label: string; description: string; command: string }[] = [];
      if (hasOpenFolder) {
        options.push({
          label: `$(save) ${vscode.l10n.t('Add current folder')}`,
          description: vscode.l10n.t('Adds the folder already open in this window'),
          command: 'folderize.addCurrentFolder',
        });
      }
      options.push(
        {
          label: `$(folder) ${vscode.l10n.t('Add project')}`,
          description: vscode.l10n.t('Choose a specific folder to add as a single project'),
          command: 'folderize.addProject',
        },
        {
          label: `$(root-folder) ${vscode.l10n.t('Add root folder')}`,
          description: vscode.l10n.t('Choose a folder and list its subfolders as projects'),
          command: 'folderize.addRootFolder',
        }
      );

      const choice = await vscode.window.showQuickPick(options, {
        placeHolder: vscode.l10n.t('What do you want to add?'),
      });
      if (choice) {
        vscode.commands.executeCommand(choice.command);
      }
    }),

    vscode.commands.registerCommand('folderize.addRootFolder', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Add as root folder'),
      });
      if (!picked || picked.length === 0) {
        return;
      }

      const newPath = picked[0].fsPath;

      if (looksLikeProject(newPath)) {
        const addAsProject = vscode.l10n.t('Add as project');
        const continueAsRoot = vscode.l10n.t('Continue as root folder');
        const choice = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            '"{0}" looks like a project (has .git/package.json/etc.), not a folder with multiple projects inside.',
            path.basename(newPath)
          ),
          addAsProject,
          continueAsRoot
        );
        if (choice === addAsProject) {
          await addProjectPath(newPath);
          return;
        }
        if (choice !== continueAsRoot) {
          return;
        }
      }

      await addRootFolderPath(newPath);
    }),

    vscode.commands.registerCommand('folderize.addProject', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Add as project'),
      });
      if (!picked || picked.length === 0) {
        return;
      }

      const newPath = picked[0].fsPath;

      if (!looksLikeProject(newPath)) {
        const subfolderCount = countSubfolders(newPath);
        const subprojectCount = countSubfoldersLookingLikeProjects(newPath);
        if (subfolderCount >= 2 && subprojectCount >= 2) {
          const addAsRoot = vscode.l10n.t('Add as root folder');
          const continueAsProject = vscode.l10n.t('Continue as project');
          const choice = await vscode.window.showWarningMessage(
            vscode.l10n.t(
              '"{0}" looks like it contains multiple projects ({1} found), not a single project.',
              path.basename(newPath),
              subprojectCount
            ),
            addAsRoot,
            continueAsProject
          );
          if (choice === addAsRoot) {
            await addRootFolderPath(newPath);
            return;
          }
          if (choice !== continueAsProject) {
            return;
          }
        }
      }

      await addProjectPath(newPath);
    }),

    vscode.commands.registerCommand('folderize.adjustOrder', async () => {
      const meta = getProjectMeta();
      const allProjects = listProjects();

      if (allProjects.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No projects added yet.'));
        return;
      }

      const usedCategories = new Set(
        allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
      );
      const orderedIds = getOrderedCategoryIds(usedCategories);

      const reorderCategories: ReorderCategory[] = orderedIds
        .map((id) => ({
          id,
          title: id === UNCATEGORIZED ? vscode.l10n.t('Uncategorized') : id,
          items: allProjects
            .filter((p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === id)
            .sort((a, b) => (meta[a.fullPath]?.order ?? 0) - (meta[b.fullPath]?.order ?? 0))
            .map((p) => ({ id: p.fullPath, label: p.label })),
        }))
        .filter((c) => c.items.length > 0);

      const emptyCategoryIds = orderedIds.filter(
        (id) => id !== UNCATEGORIZED && !reorderCategories.some((c) => c.id === id)
      );

      openReorderPanel(reorderCategories, async (result) => {
        await saveCategories([...result.categoryOrder, ...emptyCategoryIds], UNCATEGORIZED);

        for (const [categoryId, fullPaths] of Object.entries(result.itemsByCategory)) {
          const category = categoryId === UNCATEGORIZED ? undefined : categoryId;
          fullPaths.forEach((fullPath, idx) => {
            meta[fullPath] = { ...meta[fullPath], category, order: idx };
          });
        }
        await saveProjectMeta(meta);
        refreshAll();
      });
    }),

    vscode.commands.registerCommand('folderize.manage', async () => {
      const meta = getProjectMeta();
      const allProjects = listProjects();

      if (allProjects.length === 0) {
        vscode.window.showInformationMessage(vscode.l10n.t('No projects added yet.'));
        return;
      }

      const usedCategories = new Set(
        allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
      );
      const orderedIds = getOrderedCategoryIds(usedCategories);

      // Entries use the full path (not the display name) as identifier, so two
      // projects with the same name never collide. These JSON keys ("Root Folders",
      // "Pinned", "Uncategorized") are a stable data format, not UI text — they are
      // intentionally not localized so the file always round-trips correctly.
      const data: Record<string, string[]> = {};

      data['Root Folders'] = vscode.workspace.getConfiguration('folderize').get<string[]>('rootFolders', []);

      const pinned = allProjects
        .filter((p) => meta[p.fullPath]?.favorite)
        .sort((a, b) => (meta[a.fullPath]?.order ?? 0) - (meta[b.fullPath]?.order ?? 0))
        .map((p) => p.fullPath);
      if (pinned.length > 0) {
        data['Pinned'] = pinned;
      }

      for (const id of orderedIds) {
        const label = id === UNCATEGORIZED ? 'Uncategorized' : id;
        data[label] = allProjects
          .filter((p) => (meta[p.fullPath]?.category ?? UNCATEGORIZED) === id)
          .sort((a, b) => (meta[a.fullPath]?.order ?? 0) - (meta[b.fullPath]?.order ?? 0))
          .map((p) => p.fullPath);
      }

      const knownPaths = new Set(allProjects.map((p) => p.fullPath));

      // Unique name per window/run, so two VS Code windows never collide on the same file.
      const filePath = path.join(
        os.tmpdir(),
        `folderize-listagem-${process.pid}-${Date.now()}.json`
      );
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Copy/move/reorder the paths between categories and save (Cmd+S) to apply. "Uncategorized", "Pinned" and "Root Folders" are special.'
        )
      );

      manageSaveListener?.dispose();
      manageSaveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.uri.fsPath !== filePath) {
          return;
        }
        try {
          const rawText = savedDoc.getText();

          // Detects duplicate category keys in the raw text (JSON.parse would silently
          // keep only the last one, hiding the user's mistake).
          const topLevelKeys = [...rawText.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
          const seenKeys = new Set<string>();
          for (const key of topLevelKeys) {
            if (seenKeys.has(key)) {
              throw new Error(vscode.l10n.t('Duplicate category in the file: "{0}".', key));
            }
            seenKeys.add(key);
          }

          const parsed = JSON.parse(rawText);

          let newRootFolders: string[] | undefined;
          const placements: { categoryLabel: string; categoryId: string | undefined; paths: string[] }[] = [];
          let pinnedPaths: string[] = [];

          for (const [categoryLabel, entries] of Object.entries(parsed)) {
            if (!Array.isArray(entries)) {
              throw new Error(vscode.l10n.t('"{0}" must be a list of paths.', categoryLabel));
            }
            entries.forEach((entry) => {
              if (typeof entry !== 'string') {
                throw new Error(vscode.l10n.t('"{0}" has an item that is not text.', categoryLabel));
              }
            });

            if (categoryLabel === 'Root Folders') {
              newRootFolders = entries as string[];
              continue;
            }
            if (categoryLabel === 'Pinned') {
              pinnedPaths = entries as string[];
              continue;
            }

            const isUncategorized = categoryLabel === 'Uncategorized';
            placements.push({
              categoryLabel,
              categoryId: isUncategorized ? undefined : categoryLabel,
              paths: entries as string[],
            });
          }

          // Validate the whole document before applying any change.
          for (const p of pinnedPaths) {
            if (!knownPaths.has(p)) {
              throw new Error(vscode.l10n.t('Path not found in "Pinned": "{0}".', p));
            }
          }

          const pathToCategory = new Map<string, string>();
          for (const { categoryLabel, paths } of placements) {
            for (const p of paths) {
              if (!knownPaths.has(p)) {
                throw new Error(vscode.l10n.t('Path not found in "{0}": "{1}".', categoryLabel, p));
              }
              if (pathToCategory.has(p)) {
                throw new Error(
                  vscode.l10n.t(
                    '"{0}" appears in more than one category ("{1}" and "{2}").',
                    path.basename(p),
                    pathToCategory.get(p)!,
                    categoryLabel
                  )
                );
              }
              pathToCategory.set(p, categoryLabel);
            }
          }

          const missing = [...knownPaths].filter((p) => !pathToCategory.has(p));
          if (missing.length > 0) {
            throw new Error(
              vscode.l10n.t(
                '{0} project(s) do not appear in any category (add them to a section, even "Uncategorized"): {1}{2}',
                missing.length,
                missing.slice(0, 3).map((p) => path.basename(p)).join(', '),
                missing.length > 3 ? '...' : ''
              )
            );
          }

          // Everything validated — now apply.
          const freshMeta = getProjectMeta();
          const pinnedSet = new Set(pinnedPaths);
          for (const p of knownPaths) {
            // Unfavorite whoever left "Pinned" before marking the ones that stay/join.
            if (freshMeta[p]?.favorite && !pinnedSet.has(p)) {
              freshMeta[p] = { ...freshMeta[p], favorite: false };
            }
          }
          pinnedPaths.forEach((p, idx) => {
            freshMeta[p] = { ...freshMeta[p], favorite: true, order: idx };
          });

          const newCategoryOrder: string[] = [];
          for (const { categoryLabel, categoryId, paths } of placements) {
            newCategoryOrder.push(categoryLabel === 'Uncategorized' ? UNCATEGORIZED : categoryLabel);
            paths.forEach((p, idx) => {
              freshMeta[p] = { ...freshMeta[p], category: categoryId, order: idx };
            });
          }

          if (newRootFolders) {
            await vscode.workspace
              .getConfiguration('folderize')
              .update('rootFolders', newRootFolders, vscode.ConfigurationTarget.Global);
          }
          await saveCategories(newCategoryOrder, UNCATEGORIZED);
          await saveProjectMeta(freshMeta);
          refreshAll();
          vscode.window.showInformationMessage(vscode.l10n.t('Folderize listing updated.'));
        } catch (err) {
          vscode.window.showErrorMessage(
            vscode.l10n.t('Invalid JSON: {0}', err instanceof Error ? err.message : String(err))
          );
        }
      });
      context.subscriptions.push(manageSaveListener);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('folderize.rootFolders')) {
        setupFolderWatchers();
      }
      if (
        e.affectsConfiguration('folderize.rootFolders') ||
        e.affectsConfiguration('folderize.projects') ||
        e.affectsConfiguration('folderize.categories') ||
        e.affectsConfiguration('folderize.projectMeta') ||
        e.affectsConfiguration('folderize.excludedPaths')
      ) {
        refreshAll();
      }
    }),

    vscode.workspace.onDidChangeWorkspaceFolders(() => treeProvider.refresh())
  );

  detectSiblingProjects();
}

function countSubfolders(root: string): number {
  return getSubfolderPaths(root).length;
}

function getSubfolderPaths(root: string): string[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

const PROJECT_MARKERS = [
  '.git',
  'package.json',
  'pubspec.yaml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'requirements.txt',
  'composer.json',
  '.csproj',
];

function looksLikeProject(dirPath: string): boolean {
  try {
    const entries = fs.readdirSync(dirPath);
    return entries.some(
      (name) => PROJECT_MARKERS.includes(name) || name.endsWith('.csproj') || name.endsWith('.sln')
    );
  } catch {
    return false;
  }
}

function countSubfoldersLookingLikeProjects(root: string): number {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .filter((entry) => looksLikeProject(path.join(root, entry.name)))
      .length;
  } catch {
    return 0;
  }
}

export function deactivate() {}
