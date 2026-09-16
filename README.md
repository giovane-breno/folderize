# Folderize

Organize and open your development projects faster, directly from the VS Code sidebar.

Folderize gives you a dedicated project launcher for VS Code. Register your project folders, group them by category, pin the ones you use most, and open any project in the current or a new window.

## Why Folderize?

When your projects are spread across different folders, switching between them can become repetitive. Folderize keeps your projects in one clean, searchable view without requiring a separate project management app.

## Features

- Add individual projects or scan a root folder automatically.
- Organize projects into custom categories.
- Pin your most frequently used projects.
- Reorder categories and projects with drag and drop.
- Search and open projects with Quick Open.
- Open projects in the current window or a new VS Code window.
- See which projects are currently open.
- Detect projects that were moved or deleted.
- Refresh automatically when projects are added or removed from a root folder.

## Getting started

1. Open the **Folderize** view from the Activity Bar.
2. Select **Add** (`+`).
3. Choose one of these options:
   - **Add project** — register one project folder.
   - **Add root folder** — list each immediate subfolder as a project.
   - **Add current folder** — register a folder already open in VS Code.
4. Select a project to open it.

Right-click a project to pin, rename, remove, or open it in a new window. Drag projects into categories to organize your workspace.

## Quick Open

Use the Command Palette and run:

```text
Folderize: Search and open project
```

You can also use the Folderize status bar action to search your projects quickly.

## Configuration

Folderize stores its configuration in VS Code user settings.

| Setting | Description |
| --- | --- |
| `folderize.rootFolders` | Root folders whose immediate subfolders are listed as projects. |
| `folderize.projects` | Individual project folders added manually. |
| `folderize.categories` | Custom categories and their order. |

For most workflows, you can manage everything through the Folderize view without editing settings manually.

## Privacy

Folderize works locally. It stores project paths and organization preferences in VS Code settings and does not upload project data to an external service.

## Requirements

- VS Code 1.90 or newer.

## Support

If you find a problem or have an idea for improvement, please open an issue in the project repository.

## License

[MIT](LICENSE)
