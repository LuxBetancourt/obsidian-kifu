import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores(['node_modules', '.test-build', 'release', 'tests', 'esbuild.config.mjs', 'run-tests.mjs', 'pack.mjs', 'main.js', 'package.json', 'package-lock.json', 'tsconfig.json', 'versions.json']),
	{
		languageOptions: {
			globals: { ...globals.browser },
			parserOptions: {
				projectService: { allowDefaultProject: ['eslint.config.mts', 'manifest.json'] },
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// (SGF is the name of a file format, not a word to put in lower case)
		rules: { 'obsidianmd/ui/sentence-case': ['warn', { enforceCamelCaseLower: true, acronyms: ['SGF'] }] },
	},
);
