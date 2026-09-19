import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  getCategories,
  getDuplicateProjectPaths,
  getProjectMeta,
  invalidateProjectMetaCache,
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
import {
  clearRecents,
  getRecentEntries,
  initRecents,
  pruneRecents,
  recordRecentOpen,
  restoreRecentEntries,
  restoreRecents,
} from './recents';
import { RecentsViewProvider } from './recentsViewProvider';
import { RootChildItem, RootFolderTreeItem, RootsTreeProvider } from './rootsTreeProvider';
import {
  COMPOSE_FILENAMES,
  getRunningWorkingDirs,
  hasDockerCompose,
  invalidateDockerComposeCache,
  isDockerRunning,
  normalizeProjectPath,
  pauseCompose,
  pauseContainer,
  refreshDockerState,
  restartCompose,
  startCompose,
  startContainer,
  stopCompose,
  stopContainer,
  unpauseContainer,
} from './docker';
import { DockerContainerTreeItem, DockerContainersProvider } from './dockerViewProvider';

const BACKUP_VERSION = 1;

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

  const rootsProvider = new RootsTreeProvider();
  const rootsView = vscode.window.createTreeView('folderize.rootsView', {
    treeDataProvider: rootsProvider,
  });

  // Docker view only ever shows the single project open in this window, matching
  // the rest of the extension's "one active project per window" assumption (see
  // stagePendingDockerSwitch below).
  function currentProjectPath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  const dockerProvider = new DockerContainersProvider(currentProjectPath);
  const dockerView = vscode.window.createTreeView('folderize.dockerView', {
    treeDataProvider: dockerProvider,
  });
  context.subscriptions.push(dockerView);

  function updateDockerViewContext(): void {
    const projectPath = currentProjectPath();
    vscode.commands.executeCommand(
      'setContext',
      'folderize.hasDockerCompose',
      !!projectPath && hasDockerCompose(projectPath)
    );
  }
  updateDockerViewContext();
  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    updateDockerViewContext();
    dockerProvider.refresh();
  }));

  function refreshAllNow(): void {
    treeProvider.refresh();
    favoritesProvider.refresh();
    recentsProvider.refresh();
    rootsProvider.refresh();
    dockerProvider.refresh();
  }

  // refreshAll() is called from many places (folder watchers, the docker poll,
  // config changes, most commands) and bursts of these can fire within
  // milliseconds of each other — e.g. a folder watcher's create+delete pair, or
  // several config keys changing from one settings write. Debouncing collapses
  // a burst into a single tree rebuild instead of rebuilding once per event.
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  function refreshAll(): void {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      refreshAllNow();
    }, 150);
  }
  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) {
        clearTimeout(refreshTimer);
      }
    },
  });

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

  function updateRootsDescription(): void {
    const count = rootsProvider.getRootFolders().length;
    rootsView.description = count > 0 ? String(count) : undefined;
  }
  updateRootsDescription();
  context.subscriptions.push(rootsProvider.onDidChangeTreeData(() => updateRootsDescription()));

  // Container filenames are matched a level below each root (root/<project>/<file>),
  // since projects live one level under a root folder — see listSubfolders() in
  // projects.ts. A plain (non-`**`) RelativePattern stays non-recursive, so this
  // doesn't turn into a full recursive watch of the whole root tree.
  const composeGlob = `*/{${COMPOSE_FILENAMES.join(',')}}`;

  let folderWatchers: vscode.Disposable[] = [];
  function setupFolderWatchers(): void {
    folderWatchers.forEach((w) => w.dispose());
    folderWatchers = [];

    const roots = vscode.workspace.getConfiguration('folderize').get<string[]>('rootFolders', []);
    for (const root of roots) {
      const composeWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, composeGlob));
      const invalidateComposeForFile = (uri: vscode.Uri) => {
        invalidateDockerComposeCache(path.dirname(uri.fsPath));
        refreshAll();
      };
      composeWatcher.onDidCreate(invalidateComposeForFile);
      composeWatcher.onDidDelete(invalidateComposeForFile);
      folderWatchers.push(composeWatcher);
      context.subscriptions.push(composeWatcher);

      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*'));
      watcher.onDidCreate(async (uri) => {
        invalidateSubfolderCache(root);
        invalidateDockerComposeCache(uri.fsPath);
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
      watcher.onDidDelete((uri) => {
        invalidateSubfolderCache(root);
        invalidateDockerComposeCache(uri.fsPath);
        refreshAll();
      });
      folderWatchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }
  setupFolderWatchers();

  // Projects added individually (folderize.projects) rather than discovered under
  // a root folder need their own watcher, since they aren't covered by any
  // root's composeGlob watcher above.
  let projectComposeWatchers: vscode.Disposable[] = [];
  function setupProjectComposeWatchers(): void {
    projectComposeWatchers.forEach((w) => w.dispose());
    projectComposeWatchers = [];

    const explicitProjects = vscode.workspace.getConfiguration('folderize').get<string[]>('projects', []);
    for (const projectPath of explicitProjects) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(projectPath, `{${COMPOSE_FILENAMES.join(',')}}`)
      );
      const invalidateAndRefresh = () => {
        invalidateDockerComposeCache(projectPath);
        refreshAll();
      };
      watcher.onDidCreate(invalidateAndRefresh);
      watcher.onDidDelete(invalidateAndRefresh);
      projectComposeWatchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }
  setupProjectComposeWatchers();

  async function pollDockerState(): Promise<void> {
    const changed = await refreshDockerState();
    if (changed) {
      refreshAll();
    }
    // Container-level state (paused/exited/restarting) can change without
    // flipping the running-working-dir set that refreshDockerState() tracks, so
    // the containers view refreshes independently of the `changed` flag above.
    dockerProvider.refresh();
  }
  pollDockerState();
  const dockerPollInterval = setInterval(pollDockerState, 7000);
  context.subscriptions.push({ dispose: () => clearInterval(dockerPollInterval) });

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

  // Decides whether a folder (picked manually or dropped from Explorer) should be
  // added as a single project or as a root folder (its subfolders listed as
  // projects), asking only when it's genuinely ambiguous — the same heuristic
  // "Add project" already used before drag-and-drop existed.
  async function smartAddPath(newPath: string): Promise<void> {
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

    const siblingCandidates = getSubfolderPaths(parentDir).filter(
      (p) => p !== currentPath && looksLikeProject(p) && !tracked.has(p) && !excludedPaths.has(p)
    );
    const currentIsUntracked = !tracked.has(currentPath) && !excludedPaths.has(currentPath);
    const candidates = currentIsUntracked ? [currentPath, ...siblingCandidates] : siblingCandidates;

    if (candidates.length === 0) {
      return;
    }

    const addAll = vscode.l10n.t('Add All');
    const review = vscode.l10n.t('Review');
    const ignore = vscode.l10n.t('Ignore');

    const choice = await vscode.window.showInformationMessage(
      currentIsUntracked
        ? vscode.l10n.t(
            'Folderize found {0} project(s) here, including "{1}" (the one you\'re in). Add them?',
            candidates.length,
            path.basename(currentPath)
          )
        : vscode.l10n.t(
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
    } else {
      return;
    }

    const monitorFolder = vscode.l10n.t('Monitor folder');
    const monitorChoice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Folderize can monitor "{0}" to automatically detect new projects added there in the future. Enable monitoring?',
        path.basename(parentDir)
      ),
      monitorFolder
    );
    if (monitorChoice === monitorFolder) {
      await addRootFolderPath(parentDir);
    }
  }

  async function detectDuplicateProjects(): Promise<void> {
    const ignoredDuplicates = new Set(context.globalState.get<string[]>('folderize.ignoredDuplicatePaths', []));
    const pending = getDuplicateProjectPaths().filter((p) => !ignoredDuplicates.has(p));
    if (pending.length === 0) {
      return;
    }

    const names = pending.map((p) => path.basename(p)).join(', ');
    const cleanUp = vscode.l10n.t('Clean up');
    const ignore = vscode.l10n.t('Ignore');
    const choice = await vscode.window.showWarningMessage(
      pending.length === 1
        ? vscode.l10n.t(
            '"{0}" is registered both in a root folder and as a manual project. Remove the manual entry? (it stays listed via the root folder)',
            names
          )
        : vscode.l10n.t(
            '{0} projects are registered both in a root folder and manually ({1}). Remove the manual entries? (they stay listed via the root folder)',
            pending.length,
            names
          ),
      cleanUp,
      ignore
    );

    if (choice === cleanUp) {
      const config = vscode.workspace.getConfiguration('folderize');
      const explicitProjects = config.get<string[]>('projects', []);
      await config.update(
        'projects',
        explicitProjects.filter((p) => !pending.includes(p)),
        vscode.ConfigurationTarget.Global
      );
      refreshAll();
    } else if (choice === ignore) {
      await context.globalState.update('folderize.ignoredDuplicatePaths', [...ignoredDuplicates, ...pending]);
    }
  }

  async function showOnboardingIfFirstRun(): Promise<void> {
    const alreadyShown = context.globalState.get<boolean>('folderize.onboardingShown', false);
    if (alreadyShown) {
      return;
    }
    await context.globalState.update('folderize.onboardingShown', true);

    // Someone reinstalling/updating the extension already has projects configured —
    // onboarding is only useful for a genuinely empty, first-time setup.
    if (listProjects().length > 0) {
      return;
    }

    const addProject = vscode.l10n.t('Add a project');
    const learnMore = vscode.l10n.t('Learn more');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Welcome to Folderize! Add your project folders to browse, organize into categories, favorite and quickly switch between them from the sidebar.'
      ),
      addProject,
      learnMore
    );
    if (choice === addProject) {
      vscode.commands.executeCommand('folderize.add');
    } else if (choice === learnMore) {
      vscode.commands.executeCommand('folderize.openGithub');
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

  // "Switch environment" — when opening a project in this window while the
  // currently open one still has Docker running, offer to hand off: stop the
  // old project's containers and start the new one's, so switching projects
  // doesn't leave a forgotten environment running in the background.
  //
  // Opening a folder in the same window fully reloads the extension host, so
  // this can't just show a prompt and await it before calling vscode.openFolder
  // — the process would be torn down mid-wait. Instead, the eligibility check
  // below runs synchronously and stashes the intent in globalState (which
  // survives the reload); the actual prompt is shown once the new window
  // activates, by checkPendingDockerSwitch() further down.
  // Wraps a docker compose action with a progress spinner while it runs and a
  // notification once it's done — so it's never ambiguous whether a start/stop
  // that can take a while (image pulls, builds) has actually finished.
  async function runDockerAction(
    progressTitle: string,
    action: () => Promise<void>,
    successMessage: string,
    errorMessage: (err: unknown) => string
  ): Promise<boolean> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: progressTitle },
        action
      );
      vscode.window.showInformationMessage(successMessage);
      return true;
    } catch (err) {
      vscode.window.showErrorMessage(errorMessage(err));
      return false;
    } finally {
      await refreshDockerState();
      refreshAll();
    }
  }

  const PENDING_DOCKER_SWITCH_KEY = 'folderize.pendingDockerSwitch';

  function stagePendingDockerSwitch(newPath: string): Thenable<void> | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1) {
      return undefined;
    }
    const oldPath = folders[0].uri.fsPath;
    if (oldPath === newPath || !hasDockerCompose(oldPath) || !isDockerRunning(oldPath) || !hasDockerCompose(newPath)) {
      return undefined;
    }
    return context.globalState.update(PENDING_DOCKER_SWITCH_KEY, { oldPath, newPath });
  }

  async function checkPendingDockerSwitch(): Promise<void> {
    const pending = context.globalState.get<{ oldPath: string; newPath: string }>(PENDING_DOCKER_SWITCH_KEY);
    if (!pending) {
      return;
    }
    await context.globalState.update(PENDING_DOCKER_SWITCH_KEY, undefined);

    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length !== 1 || folders[0].uri.fsPath !== pending.newPath) {
      return;
    }

    await refreshDockerState();
    if (!isDockerRunning(pending.oldPath)) {
      return;
    }

    const oldName = path.basename(pending.oldPath);
    const newName = path.basename(pending.newPath);
    const yes = vscode.l10n.t('Yes, switch');
    const ignore = vscode.l10n.t('Ignore');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        'The container for {0} is still running. Stop it and start the container for {1}?',
        oldName,
        newName
      ),
      yes,
      ignore
    );
    if (choice !== yes) {
      return;
    }

    const stopped = await runDockerAction(
      vscode.l10n.t('Stopping Docker containers for {0}…', oldName),
      () => stopCompose(pending.oldPath),
      vscode.l10n.t('Docker containers for {0} stopped.', oldName),
      (err) => vscode.l10n.t('Failed to stop Docker containers for "{0}": {1}', oldName, err instanceof Error ? err.message : String(err))
    );
    if (!stopped) {
      return;
    }

    // `docker compose stop` normally only returns once every container has
    // actually exited, but confirm against `docker ps` before starting the new
    // project anyway — starting while a port from the old project is still
    // bound is what causes only some of the new containers to come up.
    for (let attempt = 0; attempt < 5 && isDockerRunning(pending.oldPath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await refreshDockerState();
    }
    if (isDockerRunning(pending.oldPath)) {
      vscode.window.showErrorMessage(
        vscode.l10n.t('Docker containers for "{0}" are still running. Not starting "{1}" to avoid port conflicts.', oldName, newName)
      );
      refreshAll();
      return;
    }

    await runDockerAction(
      vscode.l10n.t('Starting Docker containers for {0}…', newName),
      () => startCompose(pending.newPath),
      vscode.l10n.t('Docker containers for {0} started.', newName),
      (err) => vscode.l10n.t('Failed to start Docker containers for "{0}": {1}', newName, err instanceof Error ? err.message : String(err))
    );
  }
  checkPendingDockerSwitch();

  context.subscriptions.push(
    treeView,
    rootsView,
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
        await stagePendingDockerSwitch(picked.fullPath);
        vscode.commands.executeCommand(
          'vscode.openFolder',
          vscode.Uri.file(picked.fullPath),
          { forceNewWindow: false }
        );
      }
    }),

    vscode.commands.registerCommand('folderize.refresh', async () => {
      invalidateSubfolderCache();
      invalidateDockerComposeCache();
      await pruneRecents(new Set(listProjects().map((p) => p.fullPath)));
      // A manual refresh should feel immediate, unlike the debounced refreshAll()
      // used for background events (watchers, polling, config changes).
      refreshAllNow();
      detectDuplicateProjects();
    }),

    vscode.commands.registerCommand('folderize.openProject', async (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(vscode.l10n.t('Folder not found on disk: {0}', item.fullPath));
        return;
      }
      await stagePendingDockerSwitch(item.fullPath);
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
        const isFavorite = item.isFavorite;
        for (const target of targets) {
          await updateProjectMeta(target.fullPath, { favorite: !isFavorite });
        }
        refreshAll();
      }
    ),

    vscode.commands.registerCommand('folderize.dockerStart', async (item: ProjectTreeItem) => {
      const normalizedItemPath = normalizeProjectPath(item.fullPath);
      const otherRunningDirs = getRunningWorkingDirs().filter((dir) => dir !== normalizedItemPath);
      if (otherRunningDirs.length > 0) {
        const projectsByPath = new Map(listProjects().map((p) => [normalizeProjectPath(p.fullPath), p.label]));
        const names = otherRunningDirs.map((dir) => projectsByPath.get(dir) ?? dir).join(', ');
        const stopAndStart = vscode.l10n.t('Stop and start');
        const startAnyway = vscode.l10n.t('Start anyway');
        const choice = await vscode.window.showWarningMessage(
          otherRunningDirs.length === 1
            ? vscode.l10n.t('"{0}" is already running. Stop it before starting "{1}"?', names, item.label)
            : vscode.l10n.t(
                '{0} other projects are already running ({1}). Stop them before starting "{2}"?',
                otherRunningDirs.length,
                names,
                item.label
              ),
          stopAndStart,
          startAnyway
        );
        if (choice === undefined) {
          return;
        }
        if (choice === stopAndStart) {
          for (const dir of otherRunningDirs) {
            const dirName = projectsByPath.get(dir) ?? dir;
            const stopped = await runDockerAction(
              vscode.l10n.t('Stopping Docker containers for {0}…', dirName),
              () => stopCompose(dir),
              vscode.l10n.t('Docker containers for {0} stopped.', dirName),
              (err) => vscode.l10n.t('Failed to stop Docker containers for "{0}": {1}', dirName, err instanceof Error ? err.message : String(err))
            );
            if (!stopped) {
              return;
            }
          }
        }
      }

      await runDockerAction(
        vscode.l10n.t('Starting Docker containers for {0}…', item.label),
        () => startCompose(item.fullPath),
        vscode.l10n.t('Docker containers for {0} started.', item.label),
        (err) => vscode.l10n.t('Failed to start Docker containers for "{0}": {1}', item.label, err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerStop', async (item: ProjectTreeItem) => {
      await runDockerAction(
        vscode.l10n.t('Stopping Docker containers for {0}…', item.label),
        () => stopCompose(item.fullPath),
        vscode.l10n.t('Docker containers for {0} stopped.', item.label),
        (err) => vscode.l10n.t('Failed to stop Docker containers for "{0}": {1}', item.label, err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerRestart', async (item: ProjectTreeItem) => {
      await runDockerAction(
        vscode.l10n.t('Restarting Docker containers for {0}…', item.label),
        () => restartCompose(item.fullPath),
        vscode.l10n.t('Docker containers for {0} restarted.', item.label),
        (err) => vscode.l10n.t('Failed to restart Docker containers for "{0}": {1}', item.label, err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerStartAll', async () => {
      const projectPath = currentProjectPath();
      if (!projectPath) {
        return;
      }
      await runDockerAction(
        vscode.l10n.t('Starting all containers…'),
        () => startCompose(projectPath),
        vscode.l10n.t('All containers started.'),
        (err) => vscode.l10n.t('Failed to start containers: {0}', err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerPauseAll', async () => {
      const projectPath = currentProjectPath();
      if (!projectPath) {
        return;
      }
      await runDockerAction(
        vscode.l10n.t('Pausing all containers…'),
        () => pauseCompose(projectPath),
        vscode.l10n.t('All containers paused.'),
        (err) => vscode.l10n.t('Failed to pause containers: {0}', err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerRestartAll', async () => {
      const projectPath = currentProjectPath();
      if (!projectPath) {
        return;
      }
      await runDockerAction(
        vscode.l10n.t('Restarting all containers…'),
        () => restartCompose(projectPath),
        vscode.l10n.t('All containers restarted.'),
        (err) => vscode.l10n.t('Failed to restart containers: {0}', err instanceof Error ? err.message : String(err))
      );
    }),

    vscode.commands.registerCommand('folderize.dockerContainerStart', async (item: DockerContainerTreeItem) => {
      try {
        await startContainer(item.container.id);
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to start "{0}": {1}', item.container.name, err instanceof Error ? err.message : String(err))
        );
      } finally {
        dockerProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('folderize.dockerContainerStop', async (item: DockerContainerTreeItem) => {
      try {
        await stopContainer(item.container.id);
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to stop "{0}": {1}', item.container.name, err instanceof Error ? err.message : String(err))
        );
      } finally {
        dockerProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('folderize.dockerContainerPause', async (item: DockerContainerTreeItem) => {
      try {
        await pauseContainer(item.container.id);
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to pause "{0}": {1}', item.container.name, err instanceof Error ? err.message : String(err))
        );
      } finally {
        dockerProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('folderize.dockerContainerUnpause', async (item: DockerContainerTreeItem) => {
      try {
        await unpauseContainer(item.container.id);
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to resume "{0}": {1}', item.container.name, err instanceof Error ? err.message : String(err))
        );
      } finally {
        dockerProvider.refresh();
      }
    }),

    vscode.commands.registerCommand('folderize.dockerContainerExec', (item: DockerContainerTreeItem) => {
      // Always a fresh terminal: reusing one by name risked typing `docker exec`
      // into a terminal that was already attached inside a previous container
      // shell (which has no `docker` binary of its own), silently failing.
      const terminal = vscode.window.createTerminal(`Docker: ${item.container.name}`);
      terminal.show();
      // Clears the screen and scrollback right after attaching, so the typed
      // `docker exec` line doesn't linger above the container's own prompt.
      // Falls back to a raw ANSI clear sequence when `clear` isn't installed
      // in the image (common on minimal/distroless containers).
      terminal.sendText(
        `docker exec -it '${item.container.id}' sh -c "clear 2>/dev/null || printf '\\033[2J\\033[3J\\033[H'; [ -x /bin/bash ] && exec bash || exec sh"`
      );
    }),

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

    vscode.commands.registerCommand('folderize.removeRootFolder', async (item: RootFolderTreeItem) => {
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Remove root folder "{0}" from Folderize? Projects found in it stop being listed, but nothing is deleted from disk.',
          item.fullPath
        ),
        { modal: true },
        vscode.l10n.t('Remove')
      );
      if (confirm !== vscode.l10n.t('Remove')) {
        return;
      }

      const config = vscode.workspace.getConfiguration('folderize');
      const rootFolders = config.get<string[]>('rootFolders', []);
      await config.update(
        'rootFolders',
        rootFolders.filter((r) => r !== item.fullPath),
        vscode.ConfigurationTarget.Global
      );
      invalidateSubfolderCache(item.fullPath);
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.includeExcludedPath', async (item: RootChildItem) => {
      await unexcludePath(item.fullPath);
      refreshAll();
    }),

    vscode.commands.registerCommand('folderize.ignoreFoundPath', async (item: RootChildItem) => {
      const config = vscode.workspace.getConfiguration('folderize');
      const excludedPaths = config.get<string[]>('excludedPaths', []);
      if (!excludedPaths.includes(item.fullPath)) {
        await config.update('excludedPaths', [...excludedPaths, item.fullPath], vscode.ConfigurationTarget.Global);
      }
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
      options.push({
        label: `$(folder) ${vscode.l10n.t('Add folder')}`,
        description: vscode.l10n.t('Choose a folder — Folderize figures out whether it\'s a single project or a folder full of projects'),
        command: 'folderize.addFolder',
      });

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

      await smartAddPath(picked[0].fsPath);
    }),

    vscode.commands.registerCommand('folderize.addDroppedPaths', async (paths: string[]) => {
      const tracked = new Set(listProjects().map((p) => p.fullPath));
      const newPaths = paths.filter((p) => !tracked.has(p));
      for (const p of newPaths) {
        await smartAddPath(p);
      }
    }),

    vscode.commands.registerCommand('folderize.addFolder', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: vscode.l10n.t('Add folder'),
      });
      if (!picked || picked.length === 0) {
        return;
      }

      await smartAddPath(picked[0].fsPath);
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

    vscode.commands.registerCommand('folderize.exportBackup', async () => {
      const config = vscode.workspace.getConfiguration('folderize');
      const backup = {
        folderizeBackup: true,
        version: BACKUP_VERSION,
        rootFolders: config.get<string[]>('rootFolders', []),
        projects: config.get<string[]>('projects', []),
        categories: config.get<string[]>('categories', []),
        projectMeta: getProjectMeta(),
        excludedPaths: config.get<string[]>('excludedPaths', []),
        uncategorizedPosition: config.get<number>('uncategorizedPosition', -1),
        recentEntries: getRecentEntries(),
      };

      const defaultName = `folderize-backup-${new Date().toISOString().slice(0, 10)}.json`;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), defaultName)),
        filters: { JSON: ['json'] },
        saveLabel: vscode.l10n.t('Export backup'),
      });
      if (!uri) {
        return;
      }

      try {
        fs.writeFileSync(uri.fsPath, JSON.stringify(backup, null, 2), 'utf8');
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Failed to export backup to "{0}": {1}', uri.fsPath, err instanceof Error ? err.message : String(err))
        );
        return;
      }
      vscode.window.showInformationMessage(vscode.l10n.t('Backup exported to {0}.', uri.fsPath));
    }),

    vscode.commands.registerCommand('folderize.importBackup', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
        openLabel: vscode.l10n.t('Import backup'),
      });
      if (!picked || picked.length === 0) {
        return;
      }

      let data: {
        folderizeBackup?: unknown;
        version?: unknown;
        rootFolders?: unknown;
        projects?: unknown;
        categories?: unknown;
        projectMeta?: unknown;
        excludedPaths?: unknown;
        uncategorizedPosition?: unknown;
        recentEntries?: unknown;
        recentPaths?: unknown;
      };
      try {
        const raw = fs.readFileSync(picked[0].fsPath, 'utf8');
        data = JSON.parse(raw);
      } catch (err) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Invalid JSON: {0}', err instanceof Error ? err.message : String(err))
        );
        return;
      }

      const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
      const isRecentEntryArray = (v: unknown): v is { fullPath: string; openedAt: number }[] =>
        Array.isArray(v) &&
        v.every((x) => x && typeof x === 'object' && typeof x.fullPath === 'string' && typeof x.openedAt === 'number');
      // A permissive shape check: only validates the fields Folderize actually
      // reads (see ProjectMetaEntry in projects.ts), so a backup edited by hand
      // or with a stray extra field doesn't get rejected outright.
      const isValidProjectMeta = (v: unknown): boolean => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) {
          return false;
        }
        return Object.values(v as Record<string, unknown>).every((entry) => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            return false;
          }
          const e = entry as Record<string, unknown>;
          return (
            (e.category === undefined || typeof e.category === 'string') &&
            (e.order === undefined || typeof e.order === 'number') &&
            (e.favorite === undefined || typeof e.favorite === 'boolean') &&
            (e.favoriteOrder === undefined || typeof e.favoriteOrder === 'number') &&
            (e.displayName === undefined || typeof e.displayName === 'string')
          );
        });
      };

      if (data.folderizeBackup !== true || typeof data.version !== 'number') {
        vscode.window.showErrorMessage(vscode.l10n.t('This file is not a valid Folderize backup.'));
        return;
      }
      if (data.version > BACKUP_VERSION) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('This backup was created with a newer version of Folderize. Update the extension and try again.')
        );
        return;
      }
      if (
        !isStringArray(data.rootFolders ?? []) ||
        !isStringArray(data.projects ?? []) ||
        !isStringArray(data.categories ?? []) ||
        !isStringArray(data.excludedPaths ?? []) ||
        !isRecentEntryArray(data.recentEntries ?? []) ||
        !isStringArray(data.recentPaths ?? []) ||
        !isValidProjectMeta(data.projectMeta ?? {}) ||
        typeof (data.uncategorizedPosition ?? -1) !== 'number'
      ) {
        vscode.window.showErrorMessage(vscode.l10n.t('This file is not a valid Folderize backup.'));
        return;
      }

      const replace = vscode.l10n.t('Replace');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'This will replace your current Folderize configuration (root folders, projects, categories, favorites) with the contents of this backup. Continue?'
        ),
        { modal: true },
        replace
      );
      if (confirm !== replace) {
        return;
      }

      // De-duplicates and drops anything that isn't a real absolute filesystem
      // path — a hand-edited or corrupted backup could otherwise seed the
      // config with blank/relative entries that break path comparisons later.
      const sanitizePaths = (values: string[]): string[] => [
        ...new Set(values.map((v) => v.trim()).filter((v) => v.length > 0 && path.isAbsolute(v))),
      ];
      const sanitizedRootFolders = sanitizePaths((data.rootFolders as string[]) ?? []);
      const sanitizedProjects = sanitizePaths((data.projects as string[]) ?? []);
      const sanitizedExcludedPaths = sanitizePaths((data.excludedPaths as string[]) ?? []);
      const sanitizedCategories = [
        ...new Set(((data.categories as string[]) ?? []).map((c) => c.trim()).filter((c) => c.length > 0)),
      ];

      const config = vscode.workspace.getConfiguration('folderize');
      await config.update('rootFolders', sanitizedRootFolders, vscode.ConfigurationTarget.Global);
      await config.update('projects', sanitizedProjects, vscode.ConfigurationTarget.Global);
      await config.update('categories', sanitizedCategories, vscode.ConfigurationTarget.Global);
      await config.update('projectMeta', data.projectMeta ?? {}, vscode.ConfigurationTarget.Global);
      await config.update('excludedPaths', sanitizedExcludedPaths, vscode.ConfigurationTarget.Global);
      await config.update(
        'uncategorizedPosition',
        data.uncategorizedPosition ?? -1,
        vscode.ConfigurationTarget.Global
      );
      if (data.recentEntries) {
        await restoreRecentEntries(data.recentEntries as { fullPath: string; openedAt: number }[]);
      } else if (data.recentPaths) {
        await restoreRecents(data.recentPaths as string[]);
      }

      invalidateSubfolderCache();
      refreshAll();
      vscode.window.showInformationMessage(vscode.l10n.t('Folderize backup imported.'));
    }),

    vscode.commands.registerCommand('folderize.resetAll', async () => {
      const config = vscode.workspace.getConfiguration('folderize');
      const hasAnyData =
        config.get<string[]>('rootFolders', []).length > 0 ||
        config.get<string[]>('projects', []).length > 0 ||
        config.get<string[]>('categories', []).length > 0 ||
        Object.keys(getProjectMeta()).length > 0 ||
        config.get<string[]>('excludedPaths', []).length > 0;
      if (!hasAnyData) {
        vscode.window.showInformationMessage(vscode.l10n.t('There is nothing to reset — Folderize is already empty.'));
        return;
      }

      const reset = vscode.l10n.t('Reset everything');
      const confirm = await vscode.window.showWarningMessage(
        vscode.l10n.t(
          'This erases ALL Folderize data — root folders, projects, categories, favorites, hidden/excluded paths and recent history — as if it were freshly installed. This cannot be undone unless you exported a backup. Continue?'
        ),
        { modal: true },
        reset
      );
      if (confirm !== reset) {
        return;
      }

      await config.update('rootFolders', [], vscode.ConfigurationTarget.Global);
      await config.update('projects', [], vscode.ConfigurationTarget.Global);
      await config.update('categories', [], vscode.ConfigurationTarget.Global);
      await config.update('projectMeta', {}, vscode.ConfigurationTarget.Global);
      await config.update('excludedPaths', [], vscode.ConfigurationTarget.Global);
      await config.update('uncategorizedPosition', -1, vscode.ConfigurationTarget.Global);
      await clearRecents();
      await context.globalState.update('folderize.ignoredScanParents', undefined);
      await context.globalState.update('folderize.ignoredDuplicatePaths', undefined);

      invalidateSubfolderCache();
      refreshAll();
      vscode.window.showInformationMessage(vscode.l10n.t('Folderize was reset.'));
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('folderize.rootFolders')) {
        setupFolderWatchers();
      }
      if (e.affectsConfiguration('folderize.projects')) {
        setupProjectComposeWatchers();
      }
      if (e.affectsConfiguration('folderize.projectMeta')) {
        // Safety net for changes that didn't go through saveProjectMeta (e.g. the
        // user editing settings.json directly, or another window's write syncing in).
        invalidateProjectMetaCache();
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

  showOnboardingIfFirstRun();
  detectSiblingProjects();
  detectDuplicateProjects();
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
