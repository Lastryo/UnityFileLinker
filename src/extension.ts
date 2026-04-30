import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getLocalizedMessage } from './localization';

const encoding = 'utf-8';
let csprojUpdateQueue = Promise.resolve();
type CsprojMutationResult = 'changed' | 'unchanged';

type CsprojInfo = {
    csprojName: string;
    csprojPath: string;
};

type CsprojContentCacheEntry = CsprojInfo & {
    originalContent: string;
    content: string;
};

export function activate(context: vscode.ExtensionContext) {
    const scriptWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.cs');
    const asmdefWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.asmdef');

    scriptWatcher.onDidCreate((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => addToCsproj(uri.fsPath));
    });

    scriptWatcher.onDidDelete((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => removeFromCsproj(uri.fsPath));
    });

    asmdefWatcher.onDidCreate((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(uri.fsPath));
    });

    asmdefWatcher.onDidChange((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(uri.fsPath));
    });

    asmdefWatcher.onDidDelete((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(uri.fsPath));
    });

    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return;
        }

        const rootPath = workspaceFolders[0].uri.fsPath;

        event.files.forEach((file) => {
            const oldFilePath = file.oldUri.fsPath;
            const newFilePath = file.newUri.fsPath;
            const oldIsAssetScript = isAssetScriptFile(oldFilePath, rootPath);
            const newIsAssetScript = isAssetScriptFile(newFilePath, rootPath);
            const oldIsAssetAsmdef = isAssetAsmdefFile(oldFilePath, rootPath);
            const newIsAssetAsmdef = isAssetAsmdefFile(newFilePath, rootPath);

            if (oldIsAssetScript && newIsAssetScript) {
                enqueueCsprojUpdate(() => renameInCsproj(oldFilePath, newFilePath));
                return;
            }

            if (oldIsAssetScript) {
                enqueueCsprojUpdate(() => removeFromCsproj(oldFilePath));
                return;
            }

            if (newIsAssetScript) {
                enqueueCsprojUpdate(() => addToCsproj(newFilePath));
                return;
            }

            if (oldIsAssetAsmdef && newIsAssetAsmdef) {
                enqueueCsprojUpdate(async () => {
                    await syncCsprojForAsmdefScope(oldFilePath);
                    await syncCsprojForAsmdefScope(newFilePath);
                });
                return;
            }

            if (oldIsAssetAsmdef) {
                enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(oldFilePath));
                return;
            }

            if (newIsAssetAsmdef) {
                enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(newFilePath));
            }
        });
    });

    context.subscriptions.push(scriptWatcher, asmdefWatcher, renameDisposable);
}

function enqueueCsprojUpdate(operation: () => Promise<void>): void {
    csprojUpdateQueue = csprojUpdateQueue
        .catch(() => undefined)
        .then(async () => {
            try {
                await operation();
            } catch (err: any) {
                vscode.window.showErrorMessage(getLocalizedMessage(`Failed to update csproj: ${err.message}`));
            }
        });
}

function isInsideWorkspacePath(filePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, filePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isAssetFileWithExtension(filePath: string, rootPath: string, extension: string): boolean {
    if (!isInsideWorkspacePath(filePath, rootPath)) {
        return false;
    }

    const relativePath = path.relative(rootPath, filePath);
    const firstPathSegment = relativePath.split(path.sep)[0];
    return firstPathSegment === 'Assets' && path.extname(filePath).toLowerCase() === extension;
}

function isAssetScriptFile(filePath: string, rootPath: string): boolean {
    return isAssetFileWithExtension(filePath, rootPath, '.cs');
}

function isAssetAsmdefFile(filePath: string, rootPath: string): boolean {
    return isAssetFileWithExtension(filePath, rootPath, '.asmdef');
}

function toCsprojIncludePath(rootPath: string, filePath: string): string {
    return path.relative(rootPath, filePath).replace(/\//g, '\\');
}

function normalizeCsprojIncludePath(includePath: string): string {
    return decodeXmlAttribute(includePath).replace(/[\\/]+/g, '\\').toLowerCase();
}

function isSameCsprojIncludePath(firstPath: string, secondPath: string): boolean {
    return normalizeCsprojIncludePath(firstPath) === normalizeCsprojIncludePath(secondPath);
}

function normalizeFileSystemPath(filePath: string): string {
    return path.resolve(filePath).toLowerCase();
}

function isSameFileSystemPath(firstPath: string, secondPath: string): boolean {
    return normalizeFileSystemPath(firstPath) === normalizeFileSystemPath(secondPath);
}

function decodeXmlAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function getCompileIncludeMatches(csprojContent: string): RegExpMatchArray[] {
    return Array.from(csprojContent.matchAll(/<Compile\b[^>]*\bInclude=(['"])(.*?)\1[^>]*(?:\/>|>[\s\S]*?<\/Compile>)/g));
}

function countCompileIncludes(csprojContent: string, relativePath: string): number {
    return getCompileIncludeMatches(csprojContent).filter(match => isSameCsprojIncludePath(match[2], relativePath)).length;
}

function hasCompileInclude(csprojContent: string, relativePath: string): boolean {
    return countCompileIncludes(csprojContent, relativePath) > 0;
}

function inferCompileIndent(itemGroupContent: string, itemGroupIndent: string): string {
    const compileLineMatch = itemGroupContent.match(/\r?\n([ \t]*)<Compile\b/);
    if (compileLineMatch) {
        return compileLineMatch[1];
    }

    const childLineMatch = itemGroupContent.match(/\r?\n([ \t]*)<[^/!][^>]*>/);
    if (childLineMatch) {
        return childLineMatch[1];
    }

    return `${itemGroupIndent}  `;
}

function addCompileInclude(csprojContent: string, relativePath: string): string | null {
    if (hasCompileInclude(csprojContent, relativePath)) {
        return null;
    }

    const lineEnding = getLineEnding(csprojContent);
    const escapedRelativePath = escapeXmlAttribute(relativePath);
    const itemGroupRegex = /(^[ \t]*)<ItemGroup\b[^>]*>[\s\S]*?<\/ItemGroup>/gm;
    const itemGroups = Array.from(csprojContent.matchAll(itemGroupRegex));

    let targetItemGroup: RegExpMatchArray | undefined;
    const analyzerIndex = itemGroups.findIndex(match => /<Analyzer\b/.test(match[0]));
    if (analyzerIndex !== -1 && analyzerIndex + 1 < itemGroups.length) {
        targetItemGroup = itemGroups[analyzerIndex + 1];
    } else {
        targetItemGroup = itemGroups.find(match => /<Compile\b/.test(match[0])) ?? itemGroups[0];
    }

    if (targetItemGroup && targetItemGroup.index !== undefined) {
        const itemGroupContent = targetItemGroup[0];
        const itemGroupIndent = targetItemGroup[1];
        const compileIndent = inferCompileIndent(itemGroupContent, itemGroupIndent);
        const closingTagIndex = itemGroupContent.lastIndexOf('</ItemGroup>');
        const compileLine = `${compileIndent}<Compile Include="${escapedRelativePath}" />${lineEnding}`;
        const updatedItemGroup = `${itemGroupContent.slice(0, closingTagIndex)}${compileLine}${itemGroupContent.slice(closingTagIndex)}`;

        return `${csprojContent.slice(0, targetItemGroup.index)}${updatedItemGroup}${csprojContent.slice(targetItemGroup.index + itemGroupContent.length)}`;
    }

    const projectCloseMatch = csprojContent.match(/(^[ \t]*)<\/Project>/m);
    if (!projectCloseMatch || projectCloseMatch.index === undefined) {
        throw new Error('Project closing tag not found');
    }

    const projectIndent = projectCloseMatch[1];
    const itemGroupIndent = `${projectIndent}  `;
    const compileIndent = `${itemGroupIndent}  `;
    const newItemGroup = `${itemGroupIndent}<ItemGroup>${lineEnding}${compileIndent}<Compile Include="${escapedRelativePath}" />${lineEnding}${itemGroupIndent}</ItemGroup>${lineEnding}`;

    return `${csprojContent.slice(0, projectCloseMatch.index)}${newItemGroup}${csprojContent.slice(projectCloseMatch.index)}`;
}

function removeCompileInclude(csprojContent: string, relativePath: string): string | null {
    let removed = false;
    const updatedContent = csprojContent.replace(/(^[ \t]*<Compile\b[^>]*\bInclude=(['"])(.*?)\2[^>]*(?:\/>|>[\s\S]*?<\/Compile>)[ \t]*(?:\r?\n|$))/gm, (match, _line, _quote, includePath) => {
        if (isSameCsprojIncludePath(includePath, relativePath)) {
            removed = true;
            return '';
        }

        return match;
    });

    return removed ? updatedContent : null;
}

function isDirectory(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function findCsFilesInDirectory(directoryPath: string): string[] {
    if (!isDirectory(directoryPath)) {
        return [];
    }

    const csFiles: string[] = [];

    try {
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            const entryPath = path.join(directoryPath, entry.name);

            if (entry.isDirectory()) {
                csFiles.push(...findCsFilesInDirectory(entryPath));
                continue;
            }

            if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.cs') {
                csFiles.push(entryPath);
            }
        }
    } catch (err: any) {
        vscode.window.showWarningMessage(getLocalizedMessage(`Failed to scan ${path.basename(directoryPath)}: ${err.message}`));
    }

    return csFiles;
}

function getAllCsprojInfos(rootPath: string): CsprojInfo[] {
    return fs.readdirSync(rootPath)
        .filter(fileName => fileName.endsWith('.csproj'))
        .map(fileName => ({ csprojName: fileName, csprojPath: path.join(rootPath, fileName) }));
}

function createCsprojContentCache(csprojInfos: CsprojInfo[]): Map<string, CsprojContentCacheEntry> {
    const cache = new Map<string, CsprojContentCacheEntry>();

    for (const { csprojName, csprojPath } of csprojInfos) {
        if (!fs.existsSync(csprojPath)) {
            continue;
        }

        const content = fs.readFileSync(csprojPath, encoding);
        cache.set(normalizeFileSystemPath(csprojPath), {
            csprojName,
            csprojPath,
            originalContent: content,
            content,
        });
    }

    return cache;
}

function getCsprojCacheEntry(cache: Map<string, CsprojContentCacheEntry>, csprojPath: string): CsprojContentCacheEntry | undefined {
    return cache.get(normalizeFileSystemPath(csprojPath));
}

async function syncCsprojForAsmdefScope(asmdefPath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const scriptFiles = findCsFilesInDirectory(path.dirname(asmdefPath));

    if (scriptFiles.length === 0) {
        return;
    }

    const csprojCache = createCsprojContentCache(getAllCsprojInfos(rootPath));
    const missingCsprojNames = new Set<string>();
    let updatedScripts = 0;
    let unchangedScripts = 0;

    for (const scriptFile of scriptFiles) {
        const relativePath = toCsprojIncludePath(rootPath, scriptFile);
        const targetCsprojInfo = getCsprojInfoForFile(rootPath, scriptFile);
        const targetEntry = getCsprojCacheEntry(csprojCache, targetCsprojInfo.csprojPath);
        let removedEntries = 0;
        let addResult: CsprojMutationResult = 'unchanged';

        for (const entry of csprojCache.values()) {
            const includeCount = countCompileIncludes(entry.content, relativePath);

            if (includeCount === 0) {
                continue;
            }

            if (isSameFileSystemPath(entry.csprojPath, targetCsprojInfo.csprojPath) && includeCount === 1) {
                continue;
            }

            const updatedContent = removeCompileInclude(entry.content, relativePath);
            if (!updatedContent) {
                continue;
            }

            entry.content = updatedContent;
            removedEntries += includeCount;
        }

        if (targetEntry) {
            const updatedContent = addCompileInclude(targetEntry.content, relativePath);
            if (updatedContent) {
                targetEntry.content = updatedContent;
                addResult = 'changed';
            }
        } else {
            missingCsprojNames.add(targetCsprojInfo.csprojName);
        }

        if (removedEntries > 0 || addResult === 'changed') {
            updatedScripts++;
        } else {
            unchangedScripts++;
        }
    }

    for (const entry of csprojCache.values()) {
        if (entry.content !== entry.originalContent) {
            fs.writeFileSync(entry.csprojPath, entry.content, encoding);
        }
    }

    for (const csprojName of missingCsprojNames) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
    }

    vscode.window.showInformationMessage(getLocalizedMessage(`Resynced ${scriptFiles.length} scripts for ${path.basename(asmdefPath)}: ${updatedScripts} updated, ${unchangedScripts} unchanged`));
}

// Функция для поиска ближайшего .asmdef файла
function findNearestAsmdef(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

    while (isInsideWorkspacePath(dir, root)) {
        if (isDirectory(dir)) {
            const asmdefFiles = fs.readdirSync(dir).filter(file => file.endsWith('.asmdef'));
            if (asmdefFiles.length > 0) {
                return path.join(dir, asmdefFiles[0]);
            }
        }

        const parentDir = path.dirname(dir);
        if (parentDir === dir) {
            break;
        }
        dir = parentDir;
    }

    return null;
}

// Функция для получения имени сборки из .asmdef файла
function getAssemblyNameFromAsmdef(asmdefPath: string): string | null {
    try {
        const content = fs.readFileSync(asmdefPath, encoding);
        const asmdefJson = JSON.parse(content);

        if (typeof asmdefJson.name === 'string' && asmdefJson.name.trim().length > 0) {
            return asmdefJson.name;
        }

        vscode.window.showWarningMessage(getLocalizedMessage(`${path.basename(asmdefPath)} does not contain a valid assembly name`));
    } catch (err: any) {
        vscode.window.showWarningMessage(getLocalizedMessage(`Failed to read ${path.basename(asmdefPath)}: ${err.message}`));
    }

    return null;
}

function getDefaultCsprojInfo(rootPath: string, filePath: string): CsprojInfo {
    const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
    const csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    return { csprojName, csprojPath: path.join(rootPath, csprojName) };
}

function getCsprojInfoForFile(rootPath: string, filePath: string): CsprojInfo {
    const asmdefPath = findNearestAsmdef(filePath);

    if (asmdefPath) {
        const assemblyName = getAssemblyNameFromAsmdef(asmdefPath);
        if (assemblyName) {
            const csprojName = `${assemblyName}.csproj`;
            return { csprojName, csprojPath: path.join(rootPath, csprojName) };
        }
    }

    return getDefaultCsprojInfo(rootPath, filePath);
}

function getRemovalCsprojCandidates(rootPath: string, filePath: string): CsprojInfo[] {
    const candidates = new Map<string, CsprojInfo>();

    const addCandidate = (candidate: CsprojInfo) => {
        candidates.set(candidate.csprojPath, candidate);
    };

    addCandidate(getCsprojInfoForFile(rootPath, filePath));

    for (const candidate of getAllCsprojInfos(rootPath)) {
        addCandidate(candidate);
    }

    return Array.from(candidates.values());
}

async function addToCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return 'unchanged';
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const { csprojName, csprojPath } = getCsprojInfoForFile(rootPath, filePath);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
        return 'unchanged';
    }

    const csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const updatedCsprojContent = addCompileInclude(csprojContent, relativePath);

    if (!updatedCsprojContent) {
        // Файл уже добавлен
        return 'unchanged';
    }

    // Записываем изменения обратно в файл .csproj
    fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
    if (notify) {
        vscode.window.showInformationMessage(getLocalizedMessage(`Added ${path.basename(filePath)} to ${csprojName}`));
    }

    return 'changed';
}

async function removeFromCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return 'unchanged';
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const csprojCandidates = getRemovalCsprojCandidates(rootPath, filePath);

    for (const { csprojName, csprojPath } of csprojCandidates) {
        if (!fs.existsSync(csprojPath)) {
            continue;
        }

        const csprojContent = fs.readFileSync(csprojPath, encoding);
        const updatedCsprojContent = removeCompileInclude(csprojContent, relativePath);

        if (!updatedCsprojContent) {
            continue;
        }

        // Записываем изменения обратно в файл .csproj
        fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
        if (notify) {
            vscode.window.showInformationMessage(getLocalizedMessage(`Removed ${path.basename(filePath)} from ${csprojName}`));
        }
        return 'changed';
    }

    return 'unchanged';
}

async function renameInCsproj(oldFilePath: string, newFilePath: string) {
    // Удаляем старый файл из проекта
    await removeFromCsproj(oldFilePath);

    // Добавляем новый файл в проект
    await addToCsproj(newFilePath);
}

export function deactivate() { }
