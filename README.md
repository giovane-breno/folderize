# Folderize

[![Visual Studio Marketplace](https://img.shields.io/badge/Available%20on-Visual%20Studio%20Marketplace-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://marketplace.visualstudio.com/items?itemName=giovane-breno.folderize-projects)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90%2B-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com/)
[![License](https://img.shields.io/badge/License-MIT-2EA44F?style=flat-square)](LICENSE)

Keep development projects from different folders in one VS Code sidebar. Organize them into categories, favorite the ones you use most, and switch projects without leaving the editor.

Folderize is local-first: project paths and preferences stay in VS Code settings, with no external service or data upload.

## What you can do

- Add individual projects, the current workspace folder, or a root folder whose immediate subfolders become projects.
- Organize projects into categories, reorder them with drag and drop, rename their display name, and mark favorites.
- Open projects in the current or a new VS Code window; use the terminal, reveal the folder, copy its path, or open its `origin` remote.
- Search all projects from the Command Palette or the Folderize status-bar action.
- Keep track of recent projects, duplicate registrations, and paths missing from disk.
- Export or import a JSON backup of your organization.

## Docker Compose

Folderize recognizes projects containing `docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, or `compose.yaml`.

For those projects, it shows the Docker state and lets you start, stop, restart, or pause containers. The Docker view also lists each container and its current state. Docker is optional: projects without Compose files work normally.

## Getting started

1. Open **Folderize** from the Activity Bar.
2. Select **Add** (`+`).
3. Choose **Add project**, **Add root folder**, **Add current folder**, or **Add folder**.
4. Select a project in the list to open it.

To search without opening the sidebar, run **Folderize: Search and open project** from the Command Palette.

## Configuration

Most workflows can be managed from the Folderize views. These settings are available if you prefer editing VS Code settings directly:

| Setting | Description |
| --- | --- |
| `folderize.rootFolders` | Root folders whose immediate subfolders are listed as projects. |
| `folderize.projects` | Individually registered project folders. |
| `folderize.categories` | Custom categories and their order. |
| `folderize.projectMeta` | Display names, favorites, categories, and project order. |
| `folderize.excludedPaths` | Projects hidden from scanned root folders. |
| `folderize.uncategorizedPosition` | Position of the uncategorized section. |

## Requirements

- VS Code 1.90 or newer.
- Docker Desktop or Docker Engine only for Docker Compose actions.

## Development

```bash
npm install
npm run compile
npm run build
```

## Support

Found a problem or have an idea? [Open an issue](https://github.com/giovane-breno/folderize/issues).

## License

[MIT](LICENSE)
