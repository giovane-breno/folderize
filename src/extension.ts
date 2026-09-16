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
import { HelpViewProvider } from './helpViewProvider';
import { OpenFolderDecorationProvider } from './openFolderDecorationProvider';
import { openReorderPanel, ReorderCategory } from './reorderPanel';

export function activate(context: vscode.ExtensionContext) {
  let manageSaveListener: vscode.Disposable | undefined;

  const treeProvider = new ProjectsTreeProvider();
  const treeView = vscode.window.createTreeView('folderize.projectsView', {
    treeDataProvider: treeProvider,
    dragAndDropController: treeProvider,
    canSelectMany: true,
  });

  const decorationProvider = new OpenFolderDecorationProvider();
  context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(
      'folderize.helpView',
      new HelpViewProvider(context.extension.packageJSON.version)
    )
  );

  function updateDescription(): void {
    const count = listProjects().length;
    treeView.description = count === 1 ? '1 projeto' : `${count} projetos`;
  }
  updateDescription();
  context.subscriptions.push(treeProvider.onDidChangeTreeData(() => updateDescription()));

  async function assignToRootCategoryAtEnd(root: string, subPath: string): Promise<void> {
    const categoryName = path.basename(root);
    const categories = getCategories();
    if (!categories.includes(categoryName)) {
      await saveCategories([...categories, categoryName]);
    }

    const meta = getProjectMeta();
    if (meta[subPath]?.category) {
      return;
    }
    const maxOrder = Math.max(
      -1,
      ...Object.values(meta)
        .filter((entry) => entry.category === categoryName)
        .map((entry) => entry.order ?? 0)
    );
    meta[subPath] = { ...meta[subPath], category: categoryName, order: maxOrder + 1 };
    await saveProjectMeta(meta);
  }

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
          await unexcludePath(uri.fsPath);
          await assignToRootCategoryAtEnd(root, uri.fsPath);
        }
        treeProvider.refresh();
      });
      watcher.onDidDelete(() => {
        invalidateSubfolderCache(root);
        treeProvider.refresh();
      });
      folderWatchers.push(watcher);
      context.subscriptions.push(watcher);
    }
  }
  setupFolderWatchers();

  async function addRootFolderPath(newPath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('folderize');
    const current = config.get<string[]>('rootFolders', []);
    if (!current.includes(newPath)) {
      await config.update('rootFolders', [...current, newPath], vscode.ConfigurationTarget.Global);
    }
    await unexcludePath(newPath);
    await updateProjectMeta(newPath, { favorite: false });

    const categoryName = path.basename(newPath);
    const categories = getCategories();
    if (!categories.includes(categoryName)) {
      await saveCategories([...categories, categoryName]);
    }

    const subfolderPaths = getSubfolderPaths(newPath);
    const meta = getProjectMeta();
    for (const subPath of subfolderPaths) {
      await unexcludePath(subPath);
      if (!meta[subPath]?.category) {
        meta[subPath] = { ...meta[subPath], category: categoryName };
      }
    }
    await saveProjectMeta(meta);

    treeProvider.refresh();

    vscode.window.showInformationMessage(
      `Pasta raiz adicionada: ${categoryName}. ${subfolderPaths.length} subpasta(s) encontrada(s) e agrupada(s) na categoria "${categoryName}" (você pode mover à vontade).`
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
    treeProvider.refresh();
    vscode.window.showInformationMessage(`Projeto adicionado: ${path.basename(newPath)}.`);
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

    const choice = await vscode.window.showInformationMessage(
      `Folderize encontrou ${candidates.length} projeto(s) novo(s) perto de "${path.basename(currentPath)}". Adicionar?`,
      'Adicionar todos',
      'Revisar',
      'Ignorar'
    );

    if (choice === 'Adicionar todos') {
      for (const p of candidates) {
        await addProjectPath(p);
      }
    } else if (choice === 'Revisar') {
      const picked = await vscode.window.showQuickPick(
        candidates.map((p) => ({
          label: path.basename(p),
          description: p,
          picked: true,
          fullPath: p,
        })),
        { canPickMany: true, placeHolder: `Selecione os projetos pra adicionar (${candidates.length} encontrados)` }
      );
      for (const p of picked ?? []) {
        await addProjectPath(p.fullPath);
      }
    } else if (choice === 'Ignorar') {
      await context.globalState.update('folderize.ignoredScanParents', [...ignoredParents, parentDir]);
    }
  }

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.tooltip = 'Folderize: abrir busca rápida de projetos';
  statusBarItem.command = 'folderize.quickOpen';
  statusBarItem.show();

  function updateStatusBarItem(): void {
    const folders = vscode.workspace.workspaceFolders;
    const name = folders && folders.length > 0 ? path.basename(folders[0].uri.fsPath) : 'Projetos';
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
        vscode.window.showInformationMessage('Folderize ainda não tem um repositório público.');
      }
    }),

    vscode.commands.registerCommand('folderize.reportIssue', () => {
      const url = context.extension.packageJSON.bugs?.url as string | undefined;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
      } else {
        vscode.window.showInformationMessage('Folderize ainda não tem um repositório público pra reportar problemas.');
      }
    }),

    vscode.commands.registerCommand('folderize.starRepo', () => {
      const url = context.extension.packageJSON.repository?.url as string | undefined;
      if (url) {
        vscode.env.openExternal(vscode.Uri.parse(url));
        vscode.window.showInformationMessage('Obrigado! Deixa uma estrela lá no GitHub ⭐');
      } else {
        vscode.window.showInformationMessage('Folderize ainda não tem um repositório público.');
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
          label: '$(save) Adicionar pasta atual',
          description: currentFolderNotAdded.uri.fsPath,
          addCurrent: true,
        });
      }

      const pinned = projects.filter((p) => meta[p.fullPath]?.favorite);
      if (pinned.length > 0) {
        items.push({ label: 'Fixados', kind: vscode.QuickPickItemKind.Separator });
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
          label: id === UNCATEGORIZED ? 'Sem categoria' : id,
          kind: vscode.QuickPickItemKind.Separator,
        });
        items.push(
          ...grouped.get(id)!.map((p) => ({ label: p.label, description: p.fullPath, fullPath: p.fullPath }))
        );
      }

      if (items.length === 0) {
        vscode.window.showInformationMessage('Nenhum projeto cadastrado ainda.');
        return;
      }

      const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Buscar projeto...' });
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

    vscode.commands.registerCommand('folderize.refresh', () => {
      invalidateSubfolderCache();
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('folderize.openProject', (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(`Pasta não encontrada no disco: ${item.fullPath}`);
        return;
      }
      vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(item.fullPath),
        { forceNewWindow: false }
      );
    }),

    vscode.commands.registerCommand('folderize.openProjectInNewWindow', (item: ProjectTreeItem) => {
      if (!fs.existsSync(item.fullPath)) {
        vscode.window.showErrorMessage(`Pasta não encontrada no disco: ${item.fullPath}`);
        return;
      }
      vscode.commands.executeCommand(
        'vscode.openFolder',
        vscode.Uri.file(item.fullPath),
        { forceNewWindow: true }
      );
    }),

    vscode.commands.registerCommand('folderize.renameProject', async (item: ProjectTreeItem) => {
      const newName = await vscode.window.showInputBox({
        prompt: 'Novo nome de exibição para o projeto',
        value: item.label,
      });
      if (!newName || newName === item.label) {
        return;
      }
      await updateProjectMeta(item.fullPath, { displayName: newName });
      treeProvider.refresh();
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
              ? `Remover "${names}" da listagem? A pasta continua no disco, mas fica oculta até você adicioná-la de novo.`
              : `Remover ${fromRootFolder.length} pastas (${names}) da listagem? Elas continuam no disco, mas ficam ocultas até você adicioná-las de novo.`,
            { modal: true },
            'Remover'
          );
          if (confirm !== 'Remover') {
            return;
          }
        }

        for (const target of targets) {
          await removeProjectEverywhere(target.fullPath);
        }
        treeProvider.refresh();
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
        treeProvider.refresh();
      }
    ),

    vscode.commands.registerCommand('folderize.addCategory', async () => {
      const raw = await vscode.window.showInputBox({ prompt: 'Nome da nova categoria' });
      const name = raw?.trim();
      if (!name) {
        return;
      }
      const categories = getCategories();
      const exists = categories.some((c) => c.trim().toLowerCase() === name.toLowerCase());
      if (exists) {
        vscode.window.showErrorMessage(`Já existe uma categoria chamada "${name}".`);
        return;
      }
      await saveCategories([...categories, name]);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('folderize.renameCategory', async (item: CategoryTreeItem) => {
      const newName = await vscode.window.showInputBox({
        prompt: 'Novo nome da categoria',
        value: item.categoryId,
      });
      if (!newName || newName === item.categoryId) {
        return;
      }
      const ok = await renameCategoryEverywhere(item.categoryId, newName);
      if (!ok) {
        vscode.window.showErrorMessage(`Já existe uma categoria chamada "${newName}".`);
        return;
      }
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('folderize.removeCategory', async (item: CategoryTreeItem) => {
      const meta = getProjectMeta();
      const count = listProjects().filter((p) => meta[p.fullPath]?.category === item.categoryId).length;

      if (count > 0) {
        const confirm = await vscode.window.showWarningMessage(
          count === 1
            ? `Remover a categoria "${item.categoryId}"? 1 projeto volta para "Sem categoria".`
            : `Remover a categoria "${item.categoryId}"? ${count} projetos voltam para "Sem categoria".`,
          { modal: true },
          'Remover'
        );
        if (confirm !== 'Remover') {
          return;
        }
      }

      await removeCategoryEverywhere(item.categoryId);
      treeProvider.refresh();
    }),

    vscode.commands.registerCommand('folderize.addCurrentFolder', async () => {
      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length === 0) {
        vscode.window.showInformationMessage('Nenhuma pasta está aberta nesta janela.');
        return;
      }

      const folder =
        folders.length === 1
          ? folders[0]
          : await vscode.window.showWorkspaceFolderPick({
              placeHolder: 'Qual pasta aberta você quer adicionar?',
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
          label: '$(save) Adicionar pasta atual',
          description: 'Adiciona a pasta já aberta nesta janela',
          command: 'folderize.addCurrentFolder',
        });
      }
      options.push(
        {
          label: '$(folder) Adicionar projeto',
          description: 'Escolhe uma pasta específica pra adicionar como um único projeto',
          command: 'folderize.addProject',
        },
        {
          label: '$(root-folder) Adicionar pasta raiz',
          description: 'Escolhe uma pasta e lista as subpastas dela como projetos',
          command: 'folderize.addRootFolder',
        }
      );

      const choice = await vscode.window.showQuickPick(options, {
        placeHolder: 'O que você quer adicionar?',
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
        openLabel: 'Adicionar como pasta raiz',
      });
      if (!picked || picked.length === 0) {
        return;
      }

      const newPath = picked[0].fsPath;

      if (looksLikeProject(newPath)) {
        const choice = await vscode.window.showWarningMessage(
          `"${path.basename(newPath)}" parece ser um projeto (tem .git/package.json/etc.), não uma pasta com vários projetos dentro.`,
          'Adicionar como projeto',
          'Continuar como pasta raiz'
        );
        if (choice === 'Adicionar como projeto') {
          await addProjectPath(newPath);
          return;
        }
        if (choice !== 'Continuar como pasta raiz') {
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
        openLabel: 'Adicionar como projeto',
      });
      if (!picked || picked.length === 0) {
        return;
      }

      const newPath = picked[0].fsPath;

      if (!looksLikeProject(newPath)) {
        const subfolderCount = countSubfolders(newPath);
        const subprojectCount = countSubfoldersLookingLikeProjects(newPath);
        if (subfolderCount >= 2 && subprojectCount >= 2) {
          const choice = await vscode.window.showWarningMessage(
            `"${path.basename(newPath)}" parece conter vários projetos dentro (${subprojectCount} encontrados), não ser um projeto único.`,
            'Adicionar como pasta raiz',
            'Continuar como projeto'
          );
          if (choice === 'Adicionar como pasta raiz') {
            await addRootFolderPath(newPath);
            return;
          }
          if (choice !== 'Continuar como projeto') {
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
        vscode.window.showInformationMessage('Não há projetos cadastrados ainda.');
        return;
      }

      const usedCategories = new Set(
        allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
      );
      const orderedIds = getOrderedCategoryIds(usedCategories);

      const reorderCategories: ReorderCategory[] = orderedIds
        .map((id) => ({
          id,
          title: id === UNCATEGORIZED ? 'Sem categoria' : id,
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
        treeProvider.refresh();
      });
    }),

    vscode.commands.registerCommand('folderize.manage', async () => {
      const meta = getProjectMeta();
      const allProjects = listProjects();

      if (allProjects.length === 0) {
        vscode.window.showInformationMessage('Não há projetos cadastrados ainda.');
        return;
      }

      const usedCategories = new Set(
        allProjects.map((p) => meta[p.fullPath]?.category).filter((c): c is string => !!c)
      );
      const orderedIds = getOrderedCategoryIds(usedCategories);

      // As entradas usam o caminho completo (não o nome de exibição) como identificador,
      // pra dois projetos com o mesmo nome não colidirem.
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

      // Nome único por janela/execução, pra duas janelas do VS Code não colidirem no mesmo arquivo.
      const filePath = path.join(
        os.tmpdir(),
        `folderize-listagem-${process.pid}-${Date.now()}.json`
      );
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');

      const uri = vscode.Uri.file(filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        'Copie/mova/reordene os caminhos entre as categorias e salve (Cmd+S) pra aplicar. "Uncategorized", "Pinned" e "Root Folders" são especiais.'
      );

      manageSaveListener?.dispose();
      manageSaveListener = vscode.workspace.onDidSaveTextDocument(async (savedDoc) => {
        if (savedDoc.uri.fsPath !== filePath) {
          return;
        }
        try {
          const rawText = savedDoc.getText();

          // Detecta chaves de categoria duplicadas no texto bruto (JSON.parse silenciosamente
          // ficaria só com a última, escondendo o erro do usuário).
          const topLevelKeys = [...rawText.matchAll(/^ {2}"([^"]+)":/gm)].map((m) => m[1]);
          const seenKeys = new Set<string>();
          for (const key of topLevelKeys) {
            if (seenKeys.has(key)) {
              throw new Error(`Categoria duplicada no arquivo: "${key}".`);
            }
            seenKeys.add(key);
          }

          const parsed = JSON.parse(rawText);

          let newRootFolders: string[] | undefined;
          const placements: { categoryLabel: string; categoryId: string | undefined; paths: string[] }[] = [];
          let pinnedPaths: string[] = [];

          for (const [categoryLabel, entries] of Object.entries(parsed)) {
            if (!Array.isArray(entries)) {
              throw new Error(`"${categoryLabel}" deve ser uma lista de caminhos.`);
            }
            entries.forEach((entry) => {
              if (typeof entry !== 'string') {
                throw new Error(`"${categoryLabel}" tem um item que não é texto.`);
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

          // Valida o documento inteiro antes de aplicar qualquer mudança.
          for (const path of pinnedPaths) {
            if (!knownPaths.has(path)) {
              throw new Error(`Caminho não encontrado em "Pinned": "${path}".`);
            }
          }

          const pathToCategory = new Map<string, string>();
          for (const { categoryLabel, paths } of placements) {
            for (const p of paths) {
              if (!knownPaths.has(p)) {
                throw new Error(`Caminho não encontrado em "${categoryLabel}": "${p}".`);
              }
              if (pathToCategory.has(p)) {
                throw new Error(
                  `"${path.basename(p)}" aparece em mais de uma categoria ("${pathToCategory.get(p)}" e "${categoryLabel}").`
                );
              }
              pathToCategory.set(p, categoryLabel);
            }
          }

          const missing = [...knownPaths].filter((p) => !pathToCategory.has(p));
          if (missing.length > 0) {
            throw new Error(
              `${missing.length} projeto(s) não aparecem em nenhuma categoria (inclua-os em alguma seção, mesmo "Uncategorized"): ${missing
                .slice(0, 3)
                .map((p) => path.basename(p))
                .join(', ')}${missing.length > 3 ? '...' : ''}`
            );
          }

          // Tudo validado — agora aplica.
          const freshMeta = getProjectMeta();
          const pinnedSet = new Set(pinnedPaths);
          for (const p of knownPaths) {
            // Reseta o fixado de quem saiu de "Pinned" antes de marcar os que continuam/entraram.
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
          treeProvider.refresh();
          vscode.window.showInformationMessage('Listagem do Folderize atualizada.');
        } catch (err) {
          vscode.window.showErrorMessage(`JSON inválido: ${err instanceof Error ? err.message : err}`);
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
        treeProvider.refresh();
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
