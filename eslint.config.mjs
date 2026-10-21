import tseslint from 'typescript-eslint';
import obsidianmd from 'eslint-plugin-obsidianmd';

// 对齐 Obsidian 社区插件审核机器人使用的规则集(eslint-plugin-obsidianmd recommended),
// 本地 `npm run lint` 即可复现审核报告。
export default tseslint.config(
	{
		ignores: [
			'node_modules/**',
			'build/**',
			'main.js',
			'tests/**',
			'tools/**',
			'*.mjs',
		],
	},
	...obsidianmd.configs.recommended,
	{
		files: ['**/*.ts'],
		languageOptions: {
			parserOptions: {
				sourceType: 'module',
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none', ignoreRestSiblings: true }],
			'obsidianmd/no-static-styles-assignment': 'error',
			// TS 编译器已负责未定义标识符检查,no-undef 对类型/命名空间会误报
			'no-undef': 'off',
		},
	},
);
