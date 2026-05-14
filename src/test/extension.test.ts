import * as assert from 'assert';
import * as path from 'path';
import {
    addCompileInclude,
    countCompileIncludes,
    decodeXmlAttribute,
    escapeXmlAttribute,
    hasCompileInclude,
    isEditorScriptPath,
    removeCompileInclude,
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
});
