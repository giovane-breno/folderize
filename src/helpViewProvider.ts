import * as vscode from 'vscode';

class HeaderTreeItem extends vscode.TreeItem {
  constructor() {
    super('Folderize', vscode.TreeItemCollapsibleState.None);
    this.description = vscode.l10n.t('Organize your projects');
    this.contextValue = 'aboutHeader';
    this.iconPath = new vscode.ThemeIcon('folder-library');
  }
}

class AboutItemTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string, iconId: string, commandId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'aboutItem';
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = { command: commandId, title: label };
  }
}

export class HelpViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  constructor(private readonly version: string) {}

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [
      new HeaderTreeItem(),
      new AboutItemTreeItem(`v${this.version}`, '', 'info', 'folderize.showVersion'),
      new AboutItemTreeItem('GitHub', '', 'github', 'folderize.openGithub'),
      new AboutItemTreeItem(vscode.l10n.t('Report a Problem'), '', 'warning', 'folderize.reportIssue'),
    ];
  }
}
