# BorshevikWorkspaceManager

This project is built with the [Duckspec](https://github.com/komorebinator/duckspec) framework — its structure, guidelines, and conventions live in `@Term` files, not just this document. DuckTools reads them, available both as an MCP server and as the `ducktools` CLI; both expose the same operations.

Before any work, load this project's spec:

- MCP: `load_project(project_path="/var/home/komorebi/Projects/uBlue/borshevik-workspace-manager/spec/BorshevikWorkspaceManager.yaml")`
- CLI: `ducktools load-project spec/BorshevikWorkspaceManager.yaml`

To see every project registered across all your workspaces, not just this one:

- MCP: `list_projects()`
- CLI: `ducktools list-projects`
