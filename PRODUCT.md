# Product

## Register

product

## Users

Thought Navigator is for Obsidian users who build long-lived knowledge systems: Zettelkasten writers, MOC practitioners, researchers, project thinkers, and people who need to move between individual notes and larger conceptual structures. They work inside a local vault, often over many sessions, and need the interface to preserve context while they create, connect, revise, and revisit ideas.

The primary user context is focused knowledge work inside Obsidian. Users are editing notes, building `.moc` maps, following links, comparing local context, and organizing multiple knowledge domains without leaving the vault or changing the real folder structure.

## Product Purpose

Thought Navigator turns Obsidian notes into editable visual thought trees. It lets users create MOC files, add and connect nodes, arrange freeform or automatic layouts, inspect local note relationships, paste images into maps, organize MOCs with Project Spaces, and reopen graph views through Obsidian commands or URIs.

Success means a user can understand where a note belongs, how ideas connect, and what structure exists around a topic without losing the speed and privacy of local-first Obsidian work. The graph should feel like a working surface, not a separate diagramming app.

## Brand Personality

Precise, local-first, knowledge-native.

The product voice should feel calm, capable, and technical enough for serious note workers. It should avoid hype and explain actions in direct workflow language: create a MOC, reveal the current file, open local graph, mount to Project Space, paste nodes, approve drafts.

## Anti-references

This should not look or behave like a generic file-tree plugin with graph decoration added on top. The product model is MOC, node, relation, space, scratchpad, and local context, not folders as the only organizing idea.

Avoid marketing-site aesthetics inside the plugin surface: oversized hero type, decorative card grids, ornamental gradients, and animated introductions. Users are already inside a task.

Avoid a graph toy that prioritizes spectacle over legibility. Glows, nebula styling, and color should support reading structure, current selection, relation meaning, and focus, not compete with node labels.

Avoid cloud-dashboard assumptions: accounts, telemetry language, remote sync cues, and collaboration metaphors that conflict with the local-first Obsidian model.

Avoid settings-first complexity. Advanced controls are useful, but the core flow should start from opening or creating a MOC, editing nodes, navigating context, and recovering previous work.

## Design Principles

Keep the graph as the workspace. The canvas is where users edit, navigate, organize, and understand structure; surrounding panels should support the graph without taking over the task.

Make relationships explicit. Parent, child, sibling, backlink, outlink, cross-domain relation, scratchpad item, and Project Space mount should each have a clear visual and interaction meaning.

Preserve local trust. The interface should make file-writing behavior predictable, keep destructive actions confirmable, and respect that notes and MOC data belong to the user's vault.

Support both structured and exploratory thinking. Free layout, automatic layout, groups, colors, scratchpads, and local graph modes should coexist without forcing one knowledge method.

Recover context quickly. Reopening the plugin, switching MOCs, resizing Obsidian, or navigating from a note should return users to a useful state with minimal reorientation.

## Accessibility & Inclusion

Target WCAG AA contrast for plugin-owned text and controls within the constraints of Obsidian themes. Body text, node labels, toolbar controls, drawer rows, empty states, and setting labels should remain readable in both light and dark modes.

Keyboard and command-palette workflows matter because Obsidian users often rely on commands. Critical actions should remain available through commands, clear focus states, and predictable tab order where practical.

Motion should communicate state changes only: drawer open or close, selection feedback, graph refresh, loading, and panel transitions. Respect reduced-motion preferences and avoid page-load choreography.

Color must not be the only carrier of meaning. Node state, relation type, selection, draft status, warnings, and destructive actions need labels, icons, shape, or placement in addition to color.

The product should work for dense, multilingual vaults. Labels and controls must tolerate Chinese and English text, long note names, narrow side panes, and mobile-capable Obsidian layouts without clipping important actions.
