import * as vscode from 'vscode';

class AboutItemTreeItem extends vscode.TreeItem {
  constructor(label: string, description: string, iconId: string, commandId: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = 'aboutItem';
    this.iconPath = new vscode.ThemeIcon(iconId);
    this.command = { command: commandId, title: label };
  }
}

export class HelpViewProvider implements vscode.TreeDataProvider<AboutItemTreeItem> {
  constructor(private readonly version: string) {}

  getTreeItem(element: AboutItemTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): AboutItemTreeItem[] {
    return [
      new AboutItemTreeItem('Version', this.version, 'info', 'folderize.showVersion'),
      new AboutItemTreeItem('GitHub', '', 'github', 'folderize.openGithub'),
      new AboutItemTreeItem('Problema', 'Reportar um problema', 'bug', 'folderize.reportIssue'),
      new AboutItemTreeItem('Estrela', 'Dar uma estrela no GitHub', 'star-full', 'folderize.starRepo'),
    ];
  }
}
