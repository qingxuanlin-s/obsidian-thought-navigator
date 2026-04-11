# Repository Guidelines

## Project Structure & Module Organization
This is an Obsidian plugin written in TypeScript.
- `main.ts`: plugin entrypoint, command/view registration, and settings defaults.
- `src/view/`: UI views (`indexView.ts`, `graphView.ts`, `recentView.ts`).
- `src/renderer/`: graph rendering and layout logic (Cytoscape integration).
- `src/modal/`, `src/suggester/`, `src/settings/`, `src/utils/`, `src/lang/`, `src/embed/`: feature modules by responsibility.
- `styles.css`: plugin styles.
- Build artifacts: `main.js`, `manifest.json`, `styles.css` (release payload).
- `attachments/` and `docs/`: demo assets and user-facing docs.

## Build, Test, and Development Commands
- `npm install`: install dependencies.
- `npm run dev`: start esbuild watch flow for local development.
- `npm run build`: type-check (`tsc`) and produce production bundle.
- `npm run version`: bump plugin version metadata (`manifest.json`, `versions.json`).

There is no dedicated `npm test` script in this repo.

## Coding Style & Naming Conventions
- Follow `.editorconfig`: tabs, width 4, UTF-8, LF, final newline.
- Language: TypeScript (`strictNullChecks` enabled; `noImplicitAny` enabled).
- Use module-based file naming in `camelCase` (example: `mocReverseIndex.ts`).
- Keep types/classes/interfaces in `PascalCase`; variables/functions in `camelCase`.
- Linting config exists in `.eslintrc`; run manually when needed:
  - `npx eslint main.ts "src/**/*.ts"`

## Testing Guidelines
Because automated tests are not configured, validate changes with:
- `npm run build` (required before PR).
- Manual verification in Obsidian (open affected views/modals, test command flows, confirm graph behavior).
- For UI changes, capture before/after screenshots or GIFs.

## Commit & Pull Request Guidelines
Recent history uses short, action-oriented commit messages (often Chinese), e.g. `优化`, `修复bug`, `优化性能`.
- Keep commits focused and imperative; one logical change per commit.
- PRs should include: purpose, key files changed, manual test steps/results, and linked issue (if any).
- Include screenshots/GIFs for view or style changes.
- Ensure release-critical files remain consistent: `main.js`, `manifest.json`, `styles.css`, `versions.json` when applicable.
