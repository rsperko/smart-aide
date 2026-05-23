import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.test.ts'],
		globals: false,
		coverage: {
			provider: 'v8',
			include: ['src/**/*.ts'],
			exclude: [
				// Test infra (mocks + tests themselves).
				'tests/**',
				// Pure UI / DOM modules with no testable pure logic. Pure helpers
				// from view.ts and settings.ts have been extracted into separate
				// files (view-helpers.ts, derived helpers exported in settings.ts)
				// so the remaining DOM/event surface can be safely excluded.
				'src/picker-*.ts',
				'src/modal-*.ts',
				'src/endpoint-editor.ts',
				'src/provider.ts',
				'src/main.ts',
				'src/view.ts',
				'src/settings-tab.ts',
				// Type-only module (compiles to nothing).
				'src/types.ts',
			],
			reporter: ['text', 'html', 'json-summary'],
		},
	},
	resolve: {
		alias: {
			obsidian: path.resolve(__dirname, 'tests/mocks/obsidian.ts'),
		},
	},
});
