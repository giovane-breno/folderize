import * as vscode from 'vscode';
import { OPEN_FOLDER_COLOR_ID } from './theme';

export class OpenFolderDecorationProvider implements vscode.FileDecorationProvider {
  private readonly onDidChangeFileDecorationsEmitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.onDidChangeFileDecorationsEmitter.event;

  refresh(uris: vscode.Uri[]): void {
    this.onDidChangeFileDecorationsEmitter.fire(uris);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'folderize') {
      return undefined;
    }
    if (uri.authority === 'missing') {
      return {
        color: new vscode.ThemeColor('disabledForeground'),
        tooltip: vscode.l10n.t('Not found on disk'),
      };
    }
    return {
      color: new vscode.ThemeColor(OPEN_FOLDER_COLOR_ID),
    };
  }
}
