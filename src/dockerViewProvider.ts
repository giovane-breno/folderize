import * as vscode from 'vscode';
import { ContainerInfo, listContainersForComposeFile } from './docker';

export interface DockerComposeFile {
  label: string;
  projectPath: string;
  path: string;
}

export class DockerComposeTreeItem extends vscode.TreeItem {
  constructor(public readonly composeFile: DockerComposeFile, public readonly containers: ContainerInfo[]) {
    super(composeFile.label, vscode.TreeItemCollapsibleState.Expanded);
    this.description = vscode.l10n.t('{0} containers', containers.length);
    this.contextValue = 'docker-compose-file';
    this.iconPath = new vscode.ThemeIcon('server-environment');
    this.tooltip = composeFile.path;
  }
}

export class DockerContainerTreeItem extends vscode.TreeItem {
  constructor(public readonly container: ContainerInfo, composeProject?: string) {
    super(container.service, vscode.TreeItemCollapsibleState.None);

    const normalizedState = container.state.toLowerCase();
    this.description = composeProject ? `${container.status} · ${composeProject}` : container.status;
    this.tooltip = `${container.name}\n${container.image}\n${container.status}${
      normalizedState === 'running' ? `\n${vscode.l10n.t('Click to open a shell in the container')}` : ''
    }`;
    if (normalizedState === 'running') {
      this.command = {
        command: 'folderize.dockerContainerExec',
        title: vscode.l10n.t('Open shell in container'),
        arguments: [this],
      };
    }
    this.contextValue = `container-${normalizedState}${container.ports ? '-ports' : ''}`;

    if (normalizedState === 'running') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else if (normalizedState === 'paused') {
      this.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    }
  }
}

type DockerTreeItem = DockerComposeTreeItem | DockerContainerTreeItem;

export class DockerContainersProvider implements vscode.TreeDataProvider<DockerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly getComposeFiles: () => DockerComposeFile[]) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: DockerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: DockerTreeItem): Promise<DockerTreeItem[]> {
    if (element instanceof DockerComposeTreeItem) {
      return element.containers
        .sort((a, b) => a.service.localeCompare(b.service))
        .map((container) => new DockerContainerTreeItem(container));
    }

    const composeFiles = this.getComposeFiles();
    if (composeFiles.length === 0) {
      return [];
    }
    const groups = await Promise.all(
      composeFiles.map(async (composeFile) => ({
        composeFile,
        containers: await listContainersForComposeFile(composeFile.projectPath, composeFile.path),
      }))
    );
    return groups
      .sort((a, b) => a.composeFile.label.localeCompare(b.composeFile.label))
      .map(({ composeFile, containers }) => new DockerComposeTreeItem(composeFile, containers));
  }
}
