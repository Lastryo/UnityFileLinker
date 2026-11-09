import * as assert from 'assert';
import * as path from 'path';
import {
    addCompileInclude,
    countCompileIncludes,
    createCsprojContentEntry,
    decodeXmlAttribute,
    escapeXmlAttribute,
    getDefaultCsprojName,
    hasCompileInclude,
    isEditorScriptPath,
    isUnityIgnoredPath,
    parseAsmdefName,
    parseAsmrefReference,
    parseMetaGuid,
    reassignCompileInclude,
    removeCompileInclude,
    removeCompileIncludes,
    removeCompileIncludesUnderFolder,
    setCsprojEntryContent,
    toCsprojIncludePath,
} from '../csproj';

suite('Csproj helpers', () => {
    const basicProject = [
        '<Project>',
        '  <ItemGroup>',
        '    <Compile Include="Assets\\Existing.cs" />',
        '  </ItemGroup>',
        '</Project>',
        '',
    ].join('\n');

    test('adds a Compile include to an existing ItemGroup', () => {
        const updated = addCompileInclude(basicProject, 'Assets\\Player.cs');

        assert.ok(updated);
        assert.ok(updated.includes('    <Compile Include="Assets\\Player.cs" />'));
        assert.strictEqual(countCompileIncludes(updated, 'Assets\\Player.cs'), 1);
    });

    test('does not add duplicate Compile includes', () => {
        const updated = addCompileInclude(basicProject, 'Assets\\Existing.cs');

        assert.strictEqual(updated, null);
        assert.strictEqual(countCompileIncludes(basicProject, 'Assets\\Existing.cs'), 1);
    });

    test('removes a Compile include', () => {
        const updated = removeCompileInclude(basicProject, 'Assets\\Existing.cs');

        assert.ok(updated);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\Existing.cs'), false);
    });

    test('matches Compile includes regardless of slash direction', () => {
        assert.strictEqual(hasCompileInclude(basicProject, 'Assets/Existing.cs'), true);
    });

    test('escapes and decodes XML attribute values', () => {
        const raw = 'Assets\\A&B"<Test>.cs';
        const escaped = escapeXmlAttribute(raw);

        assert.strictEqual(escaped, 'Assets\\A&amp;B&quot;&lt;Test&gt;.cs');
        assert.strictEqual(decodeXmlAttribute(escaped), raw);
    });

    test('creates an ItemGroup when the project has none', () => {
        const project = '<Project>\n</Project>\n';
        const updated = addCompileInclude(project, 'Assets\\Player.cs');

        assert.ok(updated);
        assert.ok(updated.includes('<ItemGroup>'));
        assert.ok(updated.includes('<Compile Include="Assets\\Player.cs" />'));
    });

    test('converts filesystem paths to csproj include paths', () => {
        const rootPath = path.join('Users', 'dev', 'Game');
        const filePath = path.join(rootPath, 'Assets', 'Player.cs');

        assert.strictEqual(toCsprojIncludePath(rootPath, filePath), 'Assets\\Player.cs');
    });

    test('detects Editor folders using either slash style', () => {
        assert.strictEqual(isEditorScriptPath('Assets/Editor/Tool.cs'), true);
        assert.strictEqual(isEditorScriptPath('Assets\\Gameplay\\Editor\\Tool.cs'), true);
        assert.strictEqual(isEditorScriptPath('Assets/Gameplay/Player.cs'), false);
    });

    suite('with a multi-line Compile element after self-closing ones', () => {
        const mixedProject = [
            '<Project>',
            '  <ItemGroup>',
            '    <Compile Include="Assets\\A.cs" />',
            '    <Compile Include="Assets\\B.cs" />',
            '    <Compile Include="Assets\\Linked.cs">',
            '      <Link>Linked.cs</Link>',
            '    </Compile>',
            '  </ItemGroup>',
            '</Project>',
            '',
        ].join('\n');

        test('sees every Compile element', () => {
            assert.strictEqual(countCompileIncludes(mixedProject, 'Assets\\A.cs'), 1);
            assert.strictEqual(countCompileIncludes(mixedProject, 'Assets\\B.cs'), 1);
            assert.strictEqual(countCompileIncludes(mixedProject, 'Assets\\Linked.cs'), 1);
        });

        test('removes only the requested element', () => {
            const updated = removeCompileInclude(mixedProject, 'Assets\\A.cs');

            assert.ok(updated);
            assert.strictEqual(hasCompileInclude(updated, 'Assets\\A.cs'), false);
            assert.strictEqual(hasCompileInclude(updated, 'Assets\\B.cs'), true);
            assert.strictEqual(hasCompileInclude(updated, 'Assets\\Linked.cs'), true);
        });

        test('removes a multi-line element without touching its neighbours', () => {
            const updated = removeCompileInclude(mixedProject, 'Assets\\Linked.cs');

            assert.ok(updated);
            assert.strictEqual(hasCompileInclude(updated, 'Assets\\Linked.cs'), false);
            assert.strictEqual(hasCompileInclude(updated, 'Assets\\B.cs'), true);
            assert.ok(!updated.includes('<Link>'));
        });

        test('does not duplicate an existing element', () => {
            assert.strictEqual(addCompileInclude(mixedProject, 'Assets\\B.cs'), null);
        });
    });

    test('removes only includes under the given folder', () => {
        const project = [
            '<Project>',
            '  <ItemGroup>',
            '    <Compile Include="Assets\\Foo\\A.cs" />',
            '    <Compile Include="Assets\\Foo\\Sub\\B.cs" />',
            '    <Compile Include="Assets\\FooBar\\C.cs" />',
            '  </ItemGroup>',
            '</Project>',
            '',
        ].join('\n');
        const updated = removeCompileIncludesUnderFolder(project, 'Assets\\Foo');

        assert.ok(updated);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\Foo\\A.cs'), false);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\Foo\\Sub\\B.cs'), false);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\FooBar\\C.cs'), true);
        assert.strictEqual(removeCompileIncludesUnderFolder(project, 'Assets\\Missing'), null);
    });

    test('removes several includes in one pass regardless of slash direction', () => {
        const updated = removeCompileIncludes(basicProject + addCompileInclude(basicProject, 'Assets/Other.cs'), ['Assets/Existing.cs', 'Assets\\Other.cs']);

        assert.ok(updated);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\Existing.cs'), false);
        assert.strictEqual(hasCompileInclude(updated, 'Assets\\Other.cs'), false);
        assert.strictEqual(removeCompileIncludes(basicProject, ['Assets\\Missing.cs']), null);
    });

    test('chooses default projects from the project-relative path', () => {
        assert.strictEqual(getDefaultCsprojName('Assets\\Player.cs'), 'Assembly-CSharp.csproj');
        assert.strictEqual(getDefaultCsprojName('Assets\\Tools\\Editor\\Tool.cs'), 'Assembly-CSharp-Editor.csproj');
        assert.strictEqual(getDefaultCsprojName('Assets\\Plugins\\Lib.cs'), 'Assembly-CSharp-firstpass.csproj');
        assert.strictEqual(getDefaultCsprojName('Assets\\Standard Assets\\Lib.cs'), 'Assembly-CSharp-firstpass.csproj');
        assert.strictEqual(getDefaultCsprojName('Assets\\Plugins\\Foo\\Editor\\Tool.cs'), 'Assembly-CSharp-Editor-firstpass.csproj');
        assert.strictEqual(getDefaultCsprojName('Assets\\Game\\Plugins\\Lib.cs'), 'Assembly-CSharp.csproj');
    });

    test('recognizes paths Unity ignores', () => {
        assert.strictEqual(isUnityIgnoredPath('Assets\\Samples~\\Demo.cs'), true);
        assert.strictEqual(isUnityIgnoredPath('Assets\\.hidden\\Demo.cs'), true);
        assert.strictEqual(isUnityIgnoredPath('Assets\\Game\\Demo.cs'), false);
    });

    test('parses assembly definition files', () => {
        assert.strictEqual(parseAsmdefName('\uFEFF{"name":"Gameplay"}'), 'Gameplay');
        assert.strictEqual(parseAsmdefName('{"name":"  "}'), null);
        assert.strictEqual(parseAsmrefReference('{"reference":"GUID:abc"}'), 'GUID:abc');
        assert.strictEqual(parseMetaGuid('fileFormatVersion: 2\nguid: ABC123\n'), 'abc123');
    });

    suite('reassignCompileInclude', () => {
        const script = 'Assets\\Game\\Player.cs';
        const withScript = addCompileInclude(basicProject, script)!;
        const entry = (csprojName: string, content: string) => createCsprojContentEntry({ csprojName, csprojPath: path.resolve(csprojName) }, content);

        test('moves a script to its target project', () => {
            const oldProject = entry('Assembly-CSharp.csproj', withScript);
            const newProject = entry('Game.csproj', basicProject);

            assert.strictEqual(reassignCompileInclude([oldProject, newProject], newProject.csprojPath, script), 'changed');
            assert.strictEqual(hasCompileInclude(oldProject.content, script), false);
            assert.strictEqual(hasCompileInclude(newProject.content, script), true);
        });

        test('keeps existing includes when the target project does not exist yet', () => {
            const oldProject = entry('Assembly-CSharp.csproj', withScript);

            assert.strictEqual(reassignCompileInclude([oldProject], path.resolve('Game.csproj'), script), 'targetMissing');
            assert.strictEqual(oldProject.content, withScript);
        });

        test('treats the Player project of the target as a target too', () => {
            const project = entry('Game.csproj', withScript);
            const playerProject = entry('Game.Player.csproj', basicProject);

            assert.strictEqual(reassignCompileInclude([project, playerProject], project.csprojPath, script), 'changed');
            assert.strictEqual(hasCompileInclude(project.content, script), true);
            assert.strictEqual(hasCompileInclude(playerProject.content, script), true);
        });

        test('adds many scripts to one project without duplicates', () => {
            const project = entry('Game.csproj', basicProject);
            const scripts = ['Assets\\A.cs', 'Assets\\B.cs', 'Assets\\A.cs'];

            for (const scriptPath of scripts) {
                reassignCompileInclude([project], project.csprojPath, scriptPath);
            }

            assert.strictEqual(countCompileIncludes(project.content, 'Assets\\A.cs'), 1);
            assert.strictEqual(countCompileIncludes(project.content, 'Assets\\B.cs'), 1);
        });

        test('collapses duplicate includes in the target project', () => {
            const duplicated = withScript.replace('</ItemGroup>', `  <Compile Include="${script}" />\n  </ItemGroup>`);
            const project = entry('Game.csproj', duplicated);

            assert.strictEqual(reassignCompileInclude([project], project.csprojPath, script), 'changed');
            assert.strictEqual(countCompileIncludes(project.content, script), 1);
        });

        test('sees content replaced through setCsprojEntryContent', () => {
            const project = entry('Game.csproj', withScript);
            setCsprojEntryContent(project, removeCompileInclude(withScript, script)!);

            assert.strictEqual(reassignCompileInclude([project], project.csprojPath, script), 'changed');
            assert.strictEqual(countCompileIncludes(project.content, script), 1);
        });

        test('reports unchanged when the script is already in place', () => {
            const project = entry('Game.csproj', withScript);

            assert.strictEqual(reassignCompileInclude([project], project.csprojPath, script), 'unchanged');
            assert.strictEqual(project.content, withScript);
        });
    });
});
