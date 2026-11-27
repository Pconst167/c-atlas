# C Atlas for VS Code

Explore a C project in an editor tab. The graph runs locally against your open workspace and updates as you type, including unsaved edits to existing files.

## Install and open

1. [Download c-atlas-0.3.0.vsix](https://raw.githubusercontent.com/Pconst167/c-atlas/main/vscode/releases/c-atlas-0.3.0.vsix).
2. In VS Code, open **Extensions**, select **…** at the top of the view, then choose **Install from VSIX…** and select the downloaded file.
3. Open your project's folder. Press **Ctrl+Shift+P** and run **C Atlas: Explore Workspace**. In a multi-root workspace, choose the folder to index.

For a local workspace, C Atlas reads the source on your machine. With a remote VS Code workspace the extension runs against the remote files. Opening a graph requires no account, upload, or compilation.

## Open files from VS Code’s Explorer

1. Press **Ctrl+Shift+P** and run **C Atlas: Enable Graph Opens in This Workspace** once for the project.
2. Open **C Atlas: Explore Workspace**. In the built-in Explorer on the left, open a `.c` file to see its call graph or a header to see its include graph. VS Code’s usual single-click or double-click preference applies.
3. Close the workspace graph when you want file opens to go straight to the text editor again. You can also open a definition in the editor alongside the graph with **Source on click**.

With this option enabled, VS Code sends file opens to C Atlas directly. This includes opens from Quick Open. The command sets workspace file associations for C sources and supported headers. Run **C Atlas: Disable Graph Opens in This Workspace** to restore their previous settings. Other file types and more specific filename rules keep their own editors.

Data-only C files open in **Dependencies**. If you are already in that view, opening another indexed file selects it there. C Atlas falls back to source for files outside the graph index.

You can always right-click a source or header and choose **Show in C Atlas**, even when the graph is closed. Without the workspace associations, **C Atlas: Follow File Previews** can follow editor changes after VS Code opens a file. Switch it off in Settings to keep ordinary source previews while the graph is open.

## Explore

- **Structure** groups files and folders. **Call graph** shows relationships between functions. A file view includes its direct callers and callees in other project files. The arrows point from caller to callee.
- **Dependencies** includes file references such as shaders. **Header includes** follows directives with arrows pointing from the included header into the file that includes it.
- Hover to preview relationships or click to select a block. Use the chevron to drill down. Enable **Source on click** to open the corresponding definition in a VS Code editor next to the graph.
- Drag blocks to arrange them. C Atlas remembers the positions for that workspace and graph view.

C Atlas rebuilds the index after a short pause in typing and when files are created, renamed, saved or removed. Edits to a function call appear as soon as C Atlas can parse the edited code. It indexes direct calls with resolvable project definitions. Indirect calls through function pointers, runtime callback dispatch, and build-dependent macros can require inspecting the source.

## Run from source

Open this repository's `vscode` directory in VS Code. Run `npm run build` there to generate the extension assets from the same analyzer and graph used on the website. Press **F5** to launch an Extension Development Host, open a C project folder in that window, then run **C Atlas: Explore Workspace**.

[Website](https://pconst167.github.io/c-atlas/) · [Source repository](https://github.com/Pconst167/c-atlas)
