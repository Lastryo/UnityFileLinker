import { defineConfig } from '@vscode/test-cli';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Windows runners report a short 8.3 temp path, which file watcher events do not match.
const workspaceFolder = mkdtempSync(join(realpathSync.native(tmpdir()), 'unityfilelinker-test-'));
mkdirSync(join(workspaceFolder, 'ProjectSettings'));
mkdirSync(join(workspaceFolder, 'Assets'));
writeFileSync(join(workspaceFolder, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.12f1\n');

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder,
	mocha: { timeout: 30000 },
});
