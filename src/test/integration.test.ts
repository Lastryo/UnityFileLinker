import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
const mainProject = 'Assembly-CSharp.csproj';

const projectContent = (includes: string[] = []) => [
    '<Project>',
    '  <ItemGroup>',
    ...includes.map(include => `    <Compile Include="${include}" />`),
    '  </ItemGroup>',
    '</Project>',
    '',
].join('\n');

const resolve = (relativePath: string) => path.join(root, relativePath);
const read = (project: string) => fs.readFileSync(resolve(project), 'utf8');
const hasInclude = (project: string, include: string) => read(project).includes(`Include="${include}"`);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function writeFile(relativePath: string, content = '// test\n'): void {
    fs.mkdirSync(path.dirname(resolve(relativePath)), { recursive: true });
    fs.writeFileSync(resolve(relativePath), content);
}

async function waitFor(condition: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 15000;

    while (Date.now() < deadline) {
        if (condition()) {
            return;
        }
        await sleep(50);
    }

    assert.fail(`Timed out waiting for: ${description}\n${read(mainProject)}`);
}

function removeSources(): void {
    for (const folder of fs.readdirSync(resolve('Assets'))) {
        fs.rmSync(resolve(path.join('Assets', folder)), { recursive: true, force: true });
    }
    fs.rmSync(resolve('Packages'), { recursive: true, force: true });
}

/** The file watcher starts some time after activation, so keep creating probes until one is noticed. */
async function waitForWatcher(): Promise<void> {
    const deadline = Date.now() + 45000;

    for (let attempt = 0; Date.now() < deadline; attempt++) {
        writeFile(`Assets/Probe${attempt}.cs`);
        await sleep(1000);

        if (hasInclude(mainProject, `Assets\\Probe${attempt}.cs`)) {
            return;
        }
    }

    assert.fail('File watcher did not start');
}

suite('Extension in a Unity workspace', () => {
    suiteSetup(async function () {
        this.timeout(60000);
        await vscode.extensions.getExtension('lastryo.unityfilelinker')!.activate();
        fs.writeFileSync(resolve(mainProject), projectContent());
        await waitForWatcher();
    });

    setup(async () => {
        removeSources();
        await sleep(600);
        fs.writeFileSync(resolve(mainProject), projectContent());
    });

    test('adds a created script and removes it after deletion', async () => {
        writeFile('Assets/Game/Player.cs');
        await waitFor(() => hasInclude(mainProject, 'Assets\\Game\\Player.cs'), 'script to be added');

        fs.rmSync(resolve('Assets/Game/Player.cs'));
        await waitFor(() => !hasInclude(mainProject, 'Assets\\Game\\Player.cs'), 'script to be removed');
    });

    test('handles a large batch of scripts', async () => {
        const scripts = Array.from({ length: 100 }, (_, index) => `Bulk${index}.cs`);
        const countIncludes = () => (read(mainProject).match(/Assets\\Bulk\\/g) ?? []).length;

        scripts.forEach(script => writeFile(`Assets/Bulk/${script}`));
        await waitFor(() => countIncludes() === 100, 'all scripts to be added');

        fs.rmSync(resolve('Assets/Bulk'), { recursive: true });
        await waitFor(() => countIncludes() === 0, 'all scripts to be removed');
    });

    test('updates includes when a folder is renamed', async () => {
        writeFile('Assets/Old/Sub/Script.cs');
        await waitFor(() => hasInclude(mainProject, 'Assets\\Old\\Sub\\Script.cs'), 'script to be added');

        const edit = new vscode.WorkspaceEdit();
        edit.renameFile(vscode.Uri.file(resolve('Assets/Old')), vscode.Uri.file(resolve('Assets/New')));
        assert.ok(await vscode.workspace.applyEdit(edit));

        await waitFor(
            () => hasInclude(mainProject, 'Assets\\New\\Sub\\Script.cs') && !read(mainProject).includes('Assets\\Old'),
            'includes to follow the rename',
        );
    });

    test('routes scripts by asmdef and skips folders Unity ignores', async () => {
        fs.writeFileSync(resolve('Gameplay.csproj'), projectContent());
        writeFile('Assets/Gameplay/Gameplay.asmdef', '{"name":"Gameplay"}');
        writeFile('Assets/Gameplay/Hidden~/Ignored.cs');
        writeFile('Assets/Gameplay/Player.cs');

        await waitFor(() => hasInclude('Gameplay.csproj', 'Assets\\Gameplay\\Player.cs'), 'script to reach its assembly');

        assert.ok(!read('Gameplay.csproj').includes('Ignored.cs'));
        assert.ok(!read(mainProject).includes('Player.cs'));
    });

    test('tracks embedded packages and leaves scripts without an asmdef alone', async () => {
        fs.writeFileSync(resolve('Emb.csproj'), projectContent());
        writeFile('Packages/com.test/Runtime/Emb.asmdef', '{"name":"Emb"}');
        writeFile('Packages/com.test/NoAssembly/Loose.cs');
        writeFile('Packages/com.test/Runtime/Script.cs');

        await waitFor(() => hasInclude('Emb.csproj', 'Packages\\com.test\\Runtime\\Script.cs'), 'package script to be added');

        assert.ok(!read(mainProject).includes('Loose.cs'));
        assert.ok(!read('Emb.csproj').includes('Loose.cs'));
    });

    test('resync adds missing scripts and removes stale ones only', async () => {
        writeFile('Assets/Present.cs');
        await waitFor(() => hasInclude(mainProject, 'Assets\\Present.cs'), 'script to be added');
        await sleep(600);

        const packageCacheInclude = 'Library/PackageCache/com.x/Lib.cs';
        fs.writeFileSync(resolve(mainProject), projectContent(['Assets/Stale.cs', packageCacheInclude]));

        await vscode.commands.executeCommand('unityFileLinker.resyncProject');

        await waitFor(() => hasInclude(mainProject, 'Assets\\Present.cs') && !hasInclude(mainProject, 'Assets/Stale.cs'), 'resync to finish');
        assert.ok(hasInclude(mainProject, packageCacheInclude));
    });
});
