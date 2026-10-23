# Versões

Esta pasta centraliza os pacotes instaláveis e as notas de cada versão do Folderize.

Cada versão deve ficar em uma subpasta própria:

```text
versions/
└── 0.2.5/
    ├── folderize-projects-0.2.5.vsix
    └── RELEASE_NOTES.md
```

Para gerar uma nova versão:

```bash
npm run package
mv folderize-projects-<versão>.vsix versions/<versão>/
```
