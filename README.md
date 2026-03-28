# [Obsidian Zettelkasten Navigation](https://github.com/terrychenzw/obsidian-zettelkasten-navigation)

A powerful Obsidian plugin for navigating Zettelkasten using Luhmann-style IDs and keyword indexes with hierarchical graph visualization.

[中文说明](https://pkmer.cn/show/20240506222202)

![Demo](https://github.com/terrychenzw/obsidian-zettelkasten-navigation/blob/35981ab539718b3248afd5d7c9e844d987dfa209/attachments/Demo.gif)

## Features

### 🎯 Multiple View Types

1. **zk-index-graph-view** - Hierarchical index graph for Luhmann-style navigation
2. **zk-local-graph-view** - Local neighborhood graphs
3. **zk-table-view** - Table-based note display
4. **zk-outline-view** - Outline representation
5. **zk-recent-view** - Recently accessed notes

### 🌟 Key Functionalities

#### Index Graph View
- **Hierarchical Navigation**: Visualize your Zettelkasten as a tree structure based on Luhmann IDs
- **MOC (Map of Content) Support**: Parse and display tree structures from MOC files
- **Multiple Layout Engines**:
  - Dagre (hierarchical layouts)
  - COSE-Bilkent (force-directed with constraints)
  - ELK (layered layouts)
- **Interactive Graph**:
  - Zoom and pan with view state memory (remembers your position per MOC file)
  - Double-click nodes to open files
  - Right-click for context menu (delete, rename, etc.)
  - Drag nodes to reposition
  - Select multiple nodes with Ctrl+Click
  - Batch delete multiple nodes
  - Arrow relation labels with inline editing

#### Node Operations
- **Free Node Creation**: Double-click on empty space to create free nodes
- **Node Repositioning**: Drag nodes to customize layout
- **Batch Operations**: Select and delete multiple nodes at once
- **Cross-Domain Nodes**: Visual distinction and special handling
- **Node Grouping**: Group related nodes together (Command + drag)

#### Edge Operations
- **Edge Label Editing**: Double-click edges to edit relationship labels
- **Edge Curvature Control**: Drag middle control point to adjust edge curvature
- **Edge Context Menu**: Right-click to delete edges
- **Arrow Relations**: Create and modify arrow relations between nodes

#### MOC File Features
- **Automatic Parsing**: Parse tree structures from MOC files
- **Position Persistence**: Node positions saved per MOC file
- **View State Memory**: Zoom and pan positions remembered per MOC file
- **Real-time Updates**: Auto-refresh on file changes with debouncing
- **Canvas Export**: Export graphs to Obsidian canvas format

#### Performance Optimizations
- **Lazy Loading**: On-demand branch rendering
- **Debouncing**: Prevents excessive redraws during file operations
- **Content Hashing**: Efficient MOC file change detection
- **Cache Management**: Smart caching with deep copy to prevent pollution

## Why I Created This Plugin

> [!important]
> **What kind of graph view can be generated based on Luhmann-style IDs and his keyword index?**

Many note-taking apps like Obsidian provide graph view functionality to visualize note relationships. However, these graph views only base on linkages/references between notes. It's hard to recognize a specific long COT (chain of thoughts) - the starting point, the path, and the end. Different COTs crossing in the graph view makes it more chaotic.

Luhmann's zettelkasten is a:

> "combination of disorder and order, of clustering and unpredictable combinations emerging from ad hoc selection."
>
> Johannes F.K. Schmidt, [Niklas Luhmann's Card Index: The Fabrication of Serendipity](https://sociologica.unibo.it/article/view/8350/8270)

The graph view, based on linkages/references between notes, in some ways can represent the aspect of disorder of a zettelkasten. But what is the aspect of order?

> "The absence of a fixed system of order and, in consequence, a table of contents turned the index into the key tool for using the file – how else should one be able to find certain notes again and thus gain access to the system of references? Not wanting to rely on pure chance requires being able to identify at least one point from which the respective web of references can be accessed. This is the purpose of the keyword index."
>
> Johannes F.K. Schmidt, [Niklas Luhmann's Card Index: The Fabrication of Serendipity](https://sociologica.unibo.it/article/view/8350/8270)

Based on my understanding, the aspect of order in Luhmann's zettelkasten is composed of his note IDs (folgezettel) and keyword index (register).

As so far, I don't find any note-taking apps or plugins provide the graph view functionality based on Luhmann-style IDs and his keyword index - And this is the reason why I created this plugin.

This plugin provides a different graph view to visualize and navigate a zettelkasten with Luhmann-style IDs and his keyword index. I think this is the real Luhmann way to retrieve thoughts and navigate notes in a digital zettelkasten.

## Why Mermaid?

Because Obsidian supports Mermaid.js natively.

This plugin uses [Obsidian API: loadMermaid()](https://docs.obsidian.md/Reference/TypeScript+API/loadMermaid) to generate graphs and uses [svg-pan-zoom](https://github.com/bumbu/svg-pan-zoom) for panning and zooming mermaid graphs.

## Prerequisites

### 1. Luhmann-style IDs

The following ID styles are supported:

- **100% Luhmann IDs**: Such as `21/3a1p5c4aA11`, `12.5.1` (more details please refer to [Niklas Luhmann-Archiv](https://niklas-luhmann-archiv.de/bestand/zettelkasten/inhaltsuebersicht#ZK_1_editor_I_1))
- **Folgezettel**: Such as `13.8c1c1b3` (more details please refer to [How to Use Folgezettel in Your Zettelkasten](https://writing.bobdoto.computer/how-to-use-folgezettel-in-your-zettelkasten-everything-you-need-to-know-to-get-started/))
- **Antinet**: Such as `3306/2A/12` (more details please refer to [Introducing the Antinet Zettelkasten](https://zettelkasten.de/posts/introduction-antinet-zettelkasten/))

⚠️ **Note**: As `/` is not allowed in filenames on computers, it must be changed to `-`, `.` or `,` if the filename is the note ID of your main notes.

### 2. Luhmann-style Keyword Indexes

- Each keyword index contains a few notes (branch entrance). (More details please refer to [Niklas Luhmann-Archiv](https://niklas-luhmann-archiv.de/bestand/zettelkasten/schlagwortregister))
- In this plugin, a valid keyword index is a single file that contains a few linkages of main notes.

### 3. MOC (Map of Content) Files (Optional)

MOC files support hierarchical tree structure visualization:
- Uses customizable heading patterns (string or regex matching)
- Supports Mermaid format for tree structures
- Persistent node positions and view states per MOC file
- Automatic parsing with change detection

## ID Field Options

Choose one of the following ID field options in the plugin settings:

1. **Option 1**: Filename as note ID
2. **Option 2**: Metadata as note ID
3. **Option 3**: Prefix of filename as note ID

## Plugin Settings

### Required Settings

1. **Main Note Location**:
   - Specify a folder location and/or a tag for main note files

2. **Index File Location**:
   - Specify a folder location for keyword index files

3. **ID Field Option**:
   - Choose 1 option for your note's ID field

### Optional Settings

#### Index Graph Styles
- **Structure Mode**: Traditional hierarchical tree layout
- **Roadmap Mode**: Compact layout with shortened node distances
- **Branch Uncrossing**: Prevent visual overlap of branches

#### Toolbar Options
- Customize which commands appear in the branch graph toolbar
- Settings, export to canvas, and other tools

#### Layout Options
- Direction of branch graph (top-to-bottom, left-to-right, etc.)
- Direction of family graph
- Node spacing and layout parameters

#### MOC Settings
- MOC heading title pattern
- Enable/disable MOC mode
- Canvas export settings

#### Display Options
- Node badges and labels
- Edge colors and styles
- Theme customization (dark/light mode colors)

## Installation

1. Open Obsidian
2. Go to `Settings > Community plugins > Community Plugins > Browse`
3. Search for `Zettelkasten Navigation`
4. Click **Install** and then **Enable**

## Usage

### Creating an Index Graph

1. Create a MOC file with Mermaid syntax:
   ```mermaid
   graph TD
   A[A] --> B[A.1]
   A --> C[A.2]
   B --> D[A.1a]
   ```

2. Open the plugin and select "zk-index-graph-view"
3. The graph will automatically render with your tree structure

### Interacting with the Graph

- **Navigate**: Scroll to zoom, drag empty space to pan (position is remembered)
- **Open Notes**: Double-click a node to open the note
- **Edit Labels**: Double-click an edge to edit the relationship label
- **Adjust Curvature**: Drag the middle control point on edges to adjust curvature
- **Reposition Nodes**: Drag nodes to customize the layout (positions are saved)
- **Create Free Nodes**: Double-click on empty space
- **Delete Elements**: Select and press Delete, or right-click for context menu
- **Batch Operations**: Ctrl+Click to select multiple nodes, then Delete to batch delete
- **Group Nodes**: Hold Command and drag to create groups

### Keyboard Shortcuts

- **Space + Drag**: Pan the canvas
- **Delete/Backspace**: Delete selected elements
- **Double-click**: Open node or edit edge label
- **Ctrl+Click**: Multi-select nodes
- **Command+Drag**: Create node groups

## Recent Updates

### View State Memory
- Each MOC file now remembers its zoom level and pan position
- When you reopen a MOC file, it restores your last view position
- First-time opens still auto-center to show the full graph

### Batch Operations
- Select multiple nodes using Ctrl+Click
- Delete multiple nodes in one operation
- Confirmation dialog before batch deletion

### Arrow Relations
- Create arrow relations between any nodes
- Edit arrow labels inline
- Arrow label persistence in MOC files

### Edge Curvature Control
- Visual drag handle on selected edges
- Adjust edge curvature for better visual clarity
- Curvature settings persisted per edge

### Performance Improvements
- Cache pollution fixes with deep copy strategy
- Efficient change detection with content hashing
- Debounced file operations for smooth performance

## Support

> 如果您觉得这个插件有用，并希望支持其开发，您可以通过以下方式赞助我：微信，支付宝。感谢您的任何支持！
>
> If you find this plugin useful and wish to support its development, you can do so through the following methods: WeChat, Alipay. Any amount of support is appreciated. Thank you!
>
> ![](attachments/payQRcode.png)

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License

## Acknowledgments

- Inspired by Niklas Luhmann's Zettelkasten system
- Built with [Obsidian API](https://docs.obsidian.md/)
- Graph rendering powered by [Cytoscape.js](https://js.cytoscape.org/)
- Layout algorithms: [dagre](https://github.com/dagrejs/dagre), [cose-bilkent](https://github.com/iVis-at-Bilkent/cose-bilkent), [cytoscape-elk](https://github.com/cytoscape/cytoscape.js-elk)
- Mermaid parsing with [Obsidian's built-in Mermaid.js](https://mermaid.js.org/)