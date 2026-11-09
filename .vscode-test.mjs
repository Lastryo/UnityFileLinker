import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workspaceFolder = mkdtempSync(join(tmpdir(), 'unityfilelinker-test-'));
mkdirSync(join(workspaceFolder, 'ProjectSettings'));
mkdirSync(join(workspaceFolder, 'Assets'));
writeFileSync(join(workspaceFolder, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.12f1\n');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	mocha: { timeout: 30000 },
});
