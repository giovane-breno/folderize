import * as vscode from 'vscode';
import { ContainerInfo, listContainersForProject } from './docker';

export class DockerContainerTreeItem extends vscode.TreeItem {
  constructor(public readonly container: ContainerInfo) {
    super(container.service, vscode.TreeItemCollapsibleState.None);

    const normalizedState = container.state.toLowerCase();
    this.description = container.status;
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
    this.contextValue = `container-${normalizedState}`;

    if (normalizedState === 'running') {
      this.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'));
    } else if (normalizedState === 'paused') {
      this.iconPath = new vscode.ThemeIcon('debug-pause', new vscode.ThemeColor('charts.yellow'));
    } else {
      this.iconPath = new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('disabledForeground'));
    }
  }
}

export class DockerContainersProvider implements vscode.TreeDataProvider<DockerContainerTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly getProjectPath: () => string | undefined) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire();
  }

  getTreeItem(element: DockerContainerTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<DockerContainerTreeItem[]> {
    const projectPath = this.getProjectPath();
    if (!projectPath) {
      return [];
    }
    const containers = await listContainersForProject(projectPath);
    return containers
      .sort((a, b) => a.service.localeCompare(b.service))
      .map((container) => new DockerContainerTreeItem(container));
  }
}
