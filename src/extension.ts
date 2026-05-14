import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    addCompileInclude,
    countCompileIncludes,
    CsprojContentCacheEntry,
    CsprojInfo,
    CsprojMutationResult,
    encoding,
    isEditorScriptPath,
    isSameFileSystemPath,
    normalizeFileSystemPath,
    removeCompileInclude,
    toCsprojIncludePath,
} from './csproj';
import { getLocalizedMessage } from './localization';

let csprojUpdateQueue = Promise.resolve();

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
        event.files.forEach((file) => {
            const oldFilePath = file.oldUri.fsPath;
            const newFilePath = file.newUri.fsPath;
            const oldRootPath = getWorkspaceRootForPath(oldFilePath);
            const newRootPath = getWorkspaceRootForPath(newFilePath);

            const oldIsAssetScript = oldRootPath ? isAssetScriptFile(oldFilePath, oldRootPath) : false;
            const newIsAssetScript = newRootPath ? isAssetScriptFile(newFilePath, newRootPath) : false;
            const oldIsAssetAsmdef = oldRootPath ? isAssetAsmdefFile(oldFilePath, oldRootPath) : false;
            const newIsAssetAsmdef = newRootPath ? isAssetAsmdefFile(newFilePath, newRootPath) : false;

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

function enqueueCsprojUpdate(operation: () => Promise<unknown>): void {
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

function getWorkspaceRootForPath(filePath: string): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    return workspaceFolder?.uri.fsPath;
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
    const rootPath = getWorkspaceRootForPath(asmdefPath);
    if (!rootPath) {
        return;
    }

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

function findNearestAsmdef(filePath: string, rootPath: string): string | null {
    let dir = path.dirname(filePath);

    while (isInsideWorkspacePath(dir, rootPath)) {
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
    const csprojName = isEditorScriptPath(filePath) ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    return { csprojName, csprojPath: path.join(rootPath, csprojName) };
}

function getCsprojInfoForFile(rootPath: string, filePath: string): CsprojInfo {
    const asmdefPath = findNearestAsmdef(filePath, rootPath);

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
        candidates.set(normalizeFileSystemPath(candidate.csprojPath), candidate);
    };

    addCandidate(getCsprojInfoForFile(rootPath, filePath));

    for (const candidate of getAllCsprojInfos(rootPath)) {
        addCandidate(candidate);
    }

    return Array.from(candidates.values());
}

async function addToCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const rootPath = getWorkspaceRootForPath(filePath);
    if (!rootPath) {
        return 'unchanged';
    }

    const { csprojName, csprojPath } = getCsprojInfoForFile(rootPath, filePath);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
        return 'unchanged';
    }

    const csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const updatedCsprojContent = addCompileInclude(csprojContent, relativePath);

    if (!updatedCsprojContent) {
        return 'unchanged';
    }

    fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
    if (notify) {
        vscode.window.showInformationMessage(getLocalizedMessage(`Added ${path.basename(filePath)} to ${csprojName}`));
    }

    return 'changed';
}

async function removeFromCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const rootPath = getWorkspaceRootForPath(filePath);
    if (!rootPath) {
        return 'unchanged';
    }

    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const csprojCandidates = getRemovalCsprojCandidates(rootPath, filePath);
    const changedProjects: string[] = [];

    for (const { csprojName, csprojPath } of csprojCandidates) {
        if (!fs.existsSync(csprojPath)) {
            continue;
        }

        const csprojContent = fs.readFileSync(csprojPath, encoding);
        const updatedCsprojContent = removeCompileInclude(csprojContent, relativePath);

        if (!updatedCsprojContent) {
            continue;
        }

        fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
        changedProjects.push(csprojName);
    }

    if (notify && changedProjects.length > 0) {
        vscode.window.showInformationMessage(getLocalizedMessage(`Removed ${path.basename(filePath)} from ${changedProjects.join(', ')}`));
    }

    return changedProjects.length > 0 ? 'changed' : 'unchanged';
}

async function renameInCsproj(oldFilePath: string, newFilePath: string) {
    await removeFromCsproj(oldFilePath);
    await addToCsproj(newFilePath);
}

export function deactivate() { }
