# Thought Navigator

中文说明: [README.zh-CN.md](README.zh-CN.md)

Thought Navigator is an Obsidian plugin for building visual, navigable thought trees from your notes. It is designed for Zettelkasten-style writing, MOC (Map of Content) workflows, and long-term knowledge navigation.

![Views](attachments/Views.png)

## Features

- Visual thought trees based on `.moc` files.
- Create, edit, drag, connect, group, and color nodes directly on the graph.
- Free layout and auto layout modes for different thinking styles.
- Local graph view for parent, sibling, child, inlink, and outlink context.
- Cross-domain links between different MOC files.
- Scratchpad for copying, cutting, and moving nodes across MOCs.
- Project Space drawer for organizing MOCs with virtual folders.
- Search inside the tree and reveal the current note in the graph.
- Paste images directly into the graph as embedded nodes.
- MOC embed preview images in Markdown reading mode.
- Theme mode, theme style, edge style, node text, and layout settings.
- Obsidian URI support for opening graph views from links.

## Demo

![Demo](attachments/Demo.gif)

## Core Concepts

Thought Navigator works best with MOC files. A MOC file is a `.moc` file that stores a visual thought tree: nodes, relations, groups, layout state, and display metadata.

The plugin has two main views:

- **Thought Tree View**: the main canvas for editing and navigating a MOC.
- **Local Graph View**: a contextual graph for the current note, including nearby tree relations and backlinks/outlinks.

## Quick Start

1. Install and enable Thought Navigator in Obsidian.
2. Run the command `New MOC file`, or right-click a folder and choose `New MOC file`.
3. Open the generated `.moc` file.
4. Use the Thought Tree View to add nodes, connect notes, drag nodes, create groups, and organize your knowledge map.
5. Use `open thought-local-graph` when you want to inspect the current note's local context.

## Commands

| Command | Description |
| --- | --- |
| `open thought-tree-graph` | Open the main thought tree view. |
| `open thought-local-graph` | Open the local graph view. |
| `reveal current file in thought-tree-graph` | Locate the active file in the thought tree. |
| `New MOC file` | Create a new `.moc` thought tree file. |
| `添加当前 MOC 到项目文件夹` | Mount the current MOC into a Project Space folder. |

## Typical Workflow

1. Create one MOC for a topic, project, or research area.
2. Build the first-level and second-level structure before adding details.
3. Add new notes as nodes and connect each note to at least one existing idea.
4. Use groups and colors to mark clusters, stages, or themes.
5. Use cross-domain links when a node belongs to another MOC.
6. Use the local graph view to review a note's surrounding context.

## Node Editing

In the thought tree view, you can:

- Add child, sibling, parent, and free nodes.
- Edit node IDs and labels.
- Drag nodes and persist their positions.
- Connect nodes with directed relations.
- Edit relation labels and edge style.
- Group selected nodes.
- Rename, resize, recolor, or delete groups.
- Batch delete nodes or batch change colors.
- Copy or cut nodes to the scratchpad.
- Paste scratchpad nodes into another MOC.
- Paste images from the clipboard into the tree.

## Local Graph

The local graph view can show:

- Parent, sibling, and child notes.
- Inlinks.
- Outlinks.
- Combined inlink/outlink graph.

You can configure file extension filtering, graph direction, and display behavior in the plugin settings.

## Project Spaces

Project Spaces are virtual folders stored by the plugin. They let you organize MOC files without changing your vault's real folder structure.

You can:

- Create Spaces and folders.
- Mount or unmount MOCs.
- Move MOCs between virtual folders.
- Keep MOC references updated when files are renamed or deleted.

## Settings

Recommended starting settings:

| Setting | Recommended value |
| --- | --- |
| Theme mode | `auto` |
| Theme style | `modern` |
| Edge style | `bezier` |
| Node layout style | `free` for manual maps, `auto` for structured maps |
| Show note ID in branch view | enabled |
| Text display mode | `id-title` |

## Privacy and Data Access

Thought Navigator runs locally inside Obsidian.

- It does not collect telemetry.
- It does not send your notes or graph data to a remote server.
- It does not require an account.
- It does not display ads.
- It reads notes, links, metadata, and `.moc` files from your vault to build graph views.
- It writes `.moc` files, plugin settings, Project Space data, and generated preview or attachment files when you use the related features.
- It may create, modify, or remove vault files when you explicitly use commands such as creating MOC files, editing graph nodes, pasting images, or deleting embedded files from the graph.

## Installation

### From Obsidian Community Plugins

After the plugin is accepted into the community plugin marketplace:

1. Open Obsidian Settings.
2. Go to Community plugins.
3. Search for `Thought Navigator`.
4. Install and enable the plugin.

### Manual Installation

1. Download the release assets:
   - `main.js`
   - `manifest.json`
   - `styles.css`
2. Create this folder in your vault:

```text
.obsidian/plugins/thought-navigator/
```

3. Put the downloaded files into that folder.
4. Restart Obsidian and enable Thought Navigator.

## Development

Install dependencies:

```bash
npm install
```

Start the development build:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

There is no dedicated automated test script in this repository. Before publishing, run `npm run build` and manually verify the main views, MOC creation, node editing, graph navigation, settings, and embed preview behavior in Obsidian.

## Release Notes

For an Obsidian community plugin release, the GitHub release tag must match the version in `manifest.json`.

Required release assets:

- `main.js`
- `manifest.json`
- `styles.css`

Current plugin metadata:

- Plugin ID: `thought-navigator`
- Display name: `Thought Navigator`
- Minimum Obsidian version: `1.8.5`

## License

PolyForm Noncommercial License 1.0.0. See [LICENSE](LICENSE).

Commercial use is not permitted without a separate commercial license from the copyright holder.
