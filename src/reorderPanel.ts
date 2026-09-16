import * as vscode from 'vscode';

export interface ReorderItem {
  id: string;
  label: string;
}

export interface ReorderCategory {
  id: string;
  title: string;
  items: ReorderItem[];
}

export interface ReorderResult {
  categoryOrder: string[];
  itemsByCategory: Record<string, string[]>; // valores são o `id` (fullPath) de cada item, não o label
}

export function openReorderPanel(
  categories: ReorderCategory[],
  onSave: (result: ReorderResult) => void | Promise<void>
): void {
  const panel = vscode.window.createWebviewPanel(
    'folderize.reorderPanel',
    'Folderize: Ajustar ordenação',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: false }
  );

  panel.webview.html = getHtml(categories);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.command === 'save') {
      await onSave(message.result);
      panel.dispose();
    }
    if (message.command === 'cancel') {
      panel.dispose();
    }
  });
}

function getHtml(categories: ReorderCategory[]): string {
  const nonce = getNonce();
  // Escapa '<' pra um nome de pasta com "</script>" não conseguir quebrar o HTML do webview.
  const dataJson = JSON.stringify(categories).replace(/</g, '\\u003c');
  return /* html */ `<!DOCTYPE html>
<html lang="pt-br">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 16px;
      max-width: 560px;
      margin: 0 auto;
    }
    h2 { margin-top: 0; }
    p.hint { color: var(--vscode-descriptionForeground); margin-top: -8px; }
    .category-block {
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 4px;
      margin-bottom: 10px;
      background: var(--vscode-editorWidget-background);
    }
    .category-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      font-weight: 600;
      cursor: grab;
      user-select: none;
      border-bottom: 1px solid var(--vscode-widget-border, transparent);
    }
    .category-header.drag-over {
      outline: 2px solid var(--vscode-focusBorder);
    }
    .project-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px;
      min-height: 12px;
    }
    .row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      margin-left: 16px;
      background: var(--vscode-list-hoverBackground);
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 4px;
      cursor: grab;
      user-select: none;
    }
    .row.dragging { opacity: 0.4; }
    .row.drag-over { border-top: 2px solid var(--vscode-focusBorder); }
    .project-list.drag-over-empty { outline: 2px dashed var(--vscode-focusBorder); }
    .drop-zone {
      height: 10px;
      border-radius: 4px;
      margin: 2px 0;
    }
    .drop-zone.drag-over {
      height: 24px;
      background: var(--vscode-list-dropBackground);
      border: 1px dashed var(--vscode-focusBorder);
    }
    .handle { opacity: 0.6; }
    .label { flex: 1; }
    #actions {
      position: sticky;
      bottom: 0;
      display: flex;
      gap: 8px;
      justify-content: flex-end;
      padding-top: 16px;
      background: var(--vscode-editor-background);
    }
    button {
      padding: 6px 14px;
      border: none;
      border-radius: 2px;
      cursor: pointer;
    }
    #saveBtn {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    #saveBtn:hover { background: var(--vscode-button-hoverBackground); }
    #cancelBtn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    #cancelBtn:hover { background: var(--vscode-button-secondaryHoverBackground); }
  </style>
</head>
<body>
  <h2>Ajustar ordenação</h2>
  <p class="hint">Arraste o título pra reordenar categorias. Arraste um projeto pra reordenar ou mover pra outra categoria.</p>
  <div id="content"></div>
  <div id="actions">
    <button id="cancelBtn">Cancelar</button>
    <button id="saveBtn">Salvar ordem</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const categories = ${dataJson};

    let dragType = null; // 'category' | 'project'
    let dragFromCat = null;
    let dragFromItem = null;

    const content = document.getElementById('content');

    function makeCategoryDropZone(targetIndex) {
      const zone = document.createElement('div');
      zone.className = 'drop-zone';
      zone.addEventListener('dragover', (e) => {
        if (dragType === 'category') {
          e.preventDefault();
          zone.classList.add('drag-over');
        }
      });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        if (dragType !== 'category' || dragFromCat === null) return;
        const [moved] = categories.splice(dragFromCat, 1);
        const insertAt = dragFromCat < targetIndex ? targetIndex - 1 : targetIndex;
        categories.splice(insertAt, 0, moved);
        resetDrag();
        render();
      });
      return zone;
    }

    function render() {
      content.innerHTML = '';
      content.appendChild(makeCategoryDropZone(0));
      categories.forEach((cat, catIndex) => {
        const block = document.createElement('div');
        block.className = 'category-block';

        const header = document.createElement('div');
        header.className = 'category-header';
        header.draggable = true;
        header.innerHTML = '<span class="handle">☰</span><span class="label"></span>';
        header.querySelector('.label').textContent = cat.title;
        block.appendChild(header);

        header.addEventListener('dragstart', (e) => {
          dragType = 'category';
          dragFromCat = catIndex;
          e.stopPropagation();
        });
        header.addEventListener('dragover', (e) => {
          if (dragType === 'category') {
            e.preventDefault();
            header.classList.add('drag-over');
          } else if (dragType === 'project') {
            e.preventDefault();
          }
        });
        header.addEventListener('dragleave', () => header.classList.remove('drag-over'));
        header.addEventListener('drop', (e) => {
          e.preventDefault();
          header.classList.remove('drag-over');
          if (dragType === 'category' && dragFromCat !== null && dragFromCat !== catIndex) {
            const rect = header.getBoundingClientRect();
            const dropAfter = (e.clientY - rect.top) > rect.height / 2;
            const [moved] = categories.splice(dragFromCat, 1);
            let targetIndex = catIndex + (dropAfter ? 1 : 0);
            if (dragFromCat < targetIndex) targetIndex -= 1;
            categories.splice(targetIndex, 0, moved);
          } else if (dragType === 'project' && dragFromCat !== null && dragFromItem !== null) {
            const label = categories[dragFromCat].items.splice(dragFromItem, 1)[0];
            categories[catIndex].items.push(label);
          }
          resetDrag();
          render();
        });

        const list = document.createElement('div');
        list.className = 'project-list';
        cat.items.forEach((item, itemIndex) => {
          const row = document.createElement('div');
          row.className = 'row';
          row.draggable = true;
          row.innerHTML = '<span class="handle">⠿</span><span class="label"></span>';
          row.querySelector('.label').textContent = item.label;
          list.appendChild(row);

          row.addEventListener('dragstart', (e) => {
            dragType = 'project';
            dragFromCat = catIndex;
            dragFromItem = itemIndex;
            row.classList.add('dragging');
            e.stopPropagation();
          });
          row.addEventListener('dragend', () => row.classList.remove('dragging'));
          row.addEventListener('dragover', (e) => {
            if (dragType === 'project') {
              e.preventDefault();
              e.stopPropagation();
              row.classList.add('drag-over');
            }
          });
          row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
          row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('drag-over');
            if (dragType !== 'project' || dragFromCat === null || dragFromItem === null) return;
            const rect = row.getBoundingClientRect();
            const dropAfter = (e.clientY - rect.top) > rect.height / 2;
            const label = categories[dragFromCat].items.splice(dragFromItem, 1)[0];
            let targetIndex = itemIndex + (dropAfter ? 1 : 0);
            if (dragFromCat === catIndex && dragFromItem < targetIndex) targetIndex -= 1;
            categories[catIndex].items.splice(targetIndex, 0, label);
            resetDrag();
            render();
          });
        });
        block.appendChild(list);

        list.addEventListener('dragover', (e) => {
          if (dragType === 'project') {
            e.preventDefault();
            list.classList.add('drag-over-empty');
          }
        });
        list.addEventListener('dragleave', () => list.classList.remove('drag-over-empty'));
        list.addEventListener('drop', (e) => {
          if (e.target !== list) return;
          e.preventDefault();
          list.classList.remove('drag-over-empty');
          if (dragType !== 'project' || dragFromCat === null || dragFromItem === null) return;
          const label = categories[dragFromCat].items.splice(dragFromItem, 1)[0];
          categories[catIndex].items.push(label);
          resetDrag();
          render();
        });

        content.appendChild(block);
        content.appendChild(makeCategoryDropZone(catIndex + 1));
      });
    }

    function resetDrag() {
      dragType = null;
      dragFromCat = null;
      dragFromItem = null;
    }

    document.getElementById('saveBtn').addEventListener('click', () => {
      const itemsByCategory = {};
      for (const cat of categories) {
        itemsByCategory[cat.id] = cat.items.map((item) => item.id);
      }
      vscode.postMessage({
        command: 'save',
        result: { categoryOrder: categories.map((c) => c.id), itemsByCategory },
      });
    });
    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });

    render();
  </script>
</body>
</html>`;
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
