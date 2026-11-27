# C Atlas for VS Code

Explore a C project in an editor tab. The graph runs locally against your open workspace and updates as you type, including unsaved edits to existing files.

## Install and open

1. [Download c-atlas-0.2.0.vsix](https://raw.githubusercontent.com/Pconst167/c-atlas/main/vscode/releases/c-atlas-0.2.0.vsix).
2. In VS Code, open **Extensions**, select **…** at the top of the view, then choose **Install from VSIX…** and select the downloaded file.
3. Open your project's folder. Press **Ctrl+Shift+P** and run **C Atlas: Explore Workspace**. In a multi-root workspace, choose the folder to index.

For a local workspace, C Atlas reads the source on your machine. With a remote VS Code workspace the extension runs against the remote files. Opening a graph requires no account, upload, or compilation.

## Follow files from Explorer

With C Atlas open, single-click a C source or header in VS Code’s Explorer. A source file opens its function graph, a header opens its include graph, and a source file with no indexed functions opens in **Dependencies**. If you are already browsing **Dependencies**, the graph stays in that view and selects the file. Files are matched by their full workspace-relative paths.

VS Code briefly opens a text preview first. C Atlas brings the graph forward, then closes the new preview after locating the file. VS Code uses the same preview mechanism for some other navigation, including Quick Open. For a file already open in a regular tab, or if editor previews are disabled, right-click the file in Explorer and choose **Show in C Atlas**. This command also opens the graph if needed.

To keep normal preview behavior while the graph is open, switch off **C Atlas: Follow File Previews** in Settings. Source jumps made from the graph still open the actual editor.

## Explore

- **Structure** groups files and folders. **Call graph** shows relationships between functions. A file view includes its direct callers and callees in other project files. The arrows point from caller to callee.
- **Dependencies** includes file references such as shaders. **Header includes** follows directives with arrows pointing from the included header into the file that includes it.
- Hover to preview relationships or click to select a block. Use the chevron to drill down. Enable **Source on click** to open the corresponding definition in a VS Code editor next to the graph.
- Drag blocks to arrange them. C Atlas remembers the positions for that workspace and graph view.

C Atlas rebuilds the index after a short pause in typing and when files are created, renamed, saved or removed. Edits to a function call appear as soon as C Atlas can parse the edited code. It indexes direct calls with resolvable project definitions. Indirect calls through function pointers, runtime callback dispatch, and build-dependent macros can require inspecting the source.

## Run from source

Open this repository's `vscode` directory in VS Code. Run `npm run build` there to generate the extension assets from the same analyzer and graph used on the website. Press **F5** to launch an Extension Development Host, open a C project folder in that window, then run **C Atlas: Explore Workspace**.

[Website](https://pconst167.github.io/c-atlas/) · [Source repository](https://github.com/Pconst167/c-atlas)
