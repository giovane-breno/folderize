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

    const flags = new Set(uri.query.split('&').filter(Boolean));
    const isOpen = flags.has('open');
    const hasDocker = flags.has('docker');
    const dockerUnavailable = flags.has('docker-unavailable');
    if (!isOpen && !hasDocker && !dockerUnavailable) {
      return undefined;
    }

    return {
      color: isOpen
        ? new vscode.ThemeColor(OPEN_FOLDER_COLOR_ID)
        : dockerUnavailable
        ? new vscode.ThemeColor('disabledForeground')
        : undefined,
      badge: hasDocker || dockerUnavailable ? 'D' : undefined,
      tooltip: dockerUnavailable ? vscode.l10n.t('Docker (unavailable)') : hasDocker ? vscode.l10n.t('Docker') : undefined,
    };
  }
}
