import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Project {
  label: string;
  fullPath: string;
}

export interface ProjectMetaEntry {
  category?: string;
  order?: number;
  favorite?: boolean;
  favoriteOrder?: number;
  displayName?: string;
}
export type ProjectMeta = Record<string, ProjectMetaEntry>;

export function listProjects(): Project[] {
  const config = vscode.workspace.getConfiguration('folderize');
  const rootFolders = config.get<string[]>('rootFolders', []);
  const explicitProjects = config.get<string[]>('projects', []);
  const excludedPaths = new Set(config.get<string[]>('excludedPaths', []));
  const meta = getProjectMeta();

  const projects = new Map<string, Project>();
  for (const root of rootFolders) {
    const subfolders = listSubfolders(root);
    for (const project of subfolders) {
      projects.set(project.fullPath, project);
    }
  }
  for (const projectPath of explicitProjects) {
    projects.set(projectPath, { label: path.basename(projectPath), fullPath: projectPath });
  }

  const result = [...projects.values()]
    .filter((p) => !excludedPaths.has(p.fullPath))
    .map((p) => ({
      label: meta[p.fullPath]?.displayName ?? p.label,
      fullPath: p.fullPath,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return result;
}

let subfolderCache = new Map<string, Project[]>();

/** Limpa o cache de subpastas escaneadas. Chame quando o conteúdo de uma pasta raiz mudar no disco. */
export function invalidateSubfolderCache(root?: string): void {
  if (root) {
    subfolderCache.delete(root);
  } else {
    subfolderCache.clear();
  }
}

function listSubfolders(root: string): Project[] {
  const cached = subfolderCache.get(root);
  if (cached) {
    return cached;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    subfolderCache.set(root, []);
    return [];
  }

  const result = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => ({ label: entry.name, fullPath: path.join(root, entry.name) }));
  subfolderCache.set(root, result);
  return result;
}

export function getProjectMeta(): ProjectMeta {
  const raw = vscode.workspace.getConfiguration('folderize').get<ProjectMeta>('projectMeta', {});
  // O VS Code retorna um objeto congelado (proxy); clonamos pra poder mutar livremente.
  return JSON.parse(JSON.stringify(raw));
}

export async function saveProjectMeta(meta: ProjectMeta): Promise<void> {
  await vscode.workspace
    .getConfiguration('folderize')
    .update('projectMeta', meta, vscode.ConfigurationTarget.Global);
}

export async function updateProjectMeta(
  fullPath: string,
  patch: Partial<ProjectMetaEntry>
): Promise<void> {
  const meta = getProjectMeta();
  meta[fullPath] = { ...meta[fullPath], ...patch };
  await saveProjectMeta(meta);
}

export function getCategories(): string[] {
  return vscode.workspace.getConfiguration('folderize').get<string[]>('categories', []);
}

/**
 * Salva a ordem das categorias. Aceita opcionalmente o marcador especial de "sem categoria"
 * (ex: vindo do painel de reordenar) mas nunca o persiste em `folderize.categories` —
 * a posição dele é guardada separadamente em `folderize.uncategorizedPosition`,
 * pra não misturar um valor interno com nomes reais de categoria.
 */
export async function saveCategories(categoryOrder: string[], uncategorizedSentinel?: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('folderize');

  if (uncategorizedSentinel) {
    const idx = categoryOrder.indexOf(uncategorizedSentinel);
    // Só atualiza se o marcador realmente veio na lista — do contrário preserva a
    // posição já salva (ex: a seção "sem categoria" estava vazia e foi omitida).
    if (idx !== -1) {
      await config.update('uncategorizedPosition', idx, vscode.ConfigurationTarget.Global);
    }
  }

  const realCategories = uncategorizedSentinel
    ? categoryOrder.filter((id) => id !== uncategorizedSentinel)
    : categoryOrder;
  await config.update('categories', realCategories, vscode.ConfigurationTarget.Global);
}

export function getUncategorizedPosition(): number {
  return vscode.workspace.getConfiguration('folderize').get<number>('uncategorizedPosition', -1);
}

function sameCategoryName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export async function renameCategoryEverywhere(oldName: string, newName: string): Promise<boolean> {
  const trimmedNewName = newName.trim();
  const categories = getCategories();
  const conflicts = categories.some(
    (c) => !sameCategoryName(c, oldName) && sameCategoryName(c, trimmedNewName)
  );
  if (conflicts) {
    return false;
  }

  await saveCategories(categories.map((c) => (c === oldName ? trimmedNewName : c)));

  const meta = getProjectMeta();
  for (const key of Object.keys(meta)) {
    if (meta[key].category === oldName) {
      meta[key].category = trimmedNewName;
    }
  }
  await saveProjectMeta(meta);
  return true;
}

export async function removeCategoryEverywhere(name: string): Promise<void> {
  const categories = getCategories().filter((c) => c !== name);
  await saveCategories(categories);

  const meta = getProjectMeta();
  for (const key of Object.keys(meta)) {
    if (meta[key].category === name) {
      delete meta[key].category;
    }
  }
  await saveProjectMeta(meta);
}

export async function removeProjectEverywhere(fullPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('folderize');
  const rootFolders = config.get<string[]>('rootFolders', []);
  const explicitProjects = config.get<string[]>('projects', []);

  if (explicitProjects.includes(fullPath)) {
    await config.update(
      'projects',
      explicitProjects.filter((p) => p !== fullPath),
      vscode.ConfigurationTarget.Global
    );
  } else if (rootFolders.some((root) => path.resolve(path.dirname(fullPath)) === path.resolve(root))) {
    // Veio de uma pasta raiz escaneada: não dá pra remover o diretório em si,
    // então adicionamos numa lista de exclusão dedicada (fácil de "apagar a linha" depois).
    const excludedPaths = config.get<string[]>('excludedPaths', []);
    if (!excludedPaths.includes(fullPath)) {
      await config.update('excludedPaths', [...excludedPaths, fullPath], vscode.ConfigurationTarget.Global);
    }
  }

  const meta = getProjectMeta();
  if (meta[fullPath]) {
    delete meta[fullPath];
    await saveProjectMeta(meta);
  }
}

export function isFromScannedRootFolder(fullPath: string): boolean {
  const rootFolders = vscode.workspace.getConfiguration('folderize').get<string[]>('rootFolders', []);
  return rootFolders.some((root) => path.resolve(path.dirname(fullPath)) === path.resolve(root));
}

export async function unexcludePath(fullPath: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('folderize');
  const excludedPaths = config.get<string[]>('excludedPaths', []);
  if (excludedPaths.includes(fullPath)) {
    await config.update(
      'excludedPaths',
      excludedPaths.filter((p) => p !== fullPath),
      vscode.ConfigurationTarget.Global
    );
  }
}
