import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    addCompileInclude,
    CsprojContentCacheEntry,
    CsprojInfo,
    CsprojMutationResult,
    encoding,
    getDefaultCsprojName,
    getPlayerCsprojPath,
    isUnityIgnoredName,
    isUnityIgnoredPath,
    normalizeFileSystemPath,
    parseAsmdefName,
    parseAsmrefReference,
    parseMetaGuid,
    reassignCompileInclude,
    removeCompileInclude,
    removeCompileIncludesUnderFolder,
    toCsprojIncludePath,
} from './csproj';
import { getLocalizedMessage } from './localization';

const syncDebounceMs = 250;
const nonFolderDeleteExtensions = new Set(['.cs', '.asmdef', '.asmref', '.meta']);
let csprojUpdateQueue = Promise.resolve();
const pendingAsmdefSyncs = new Map<string, NodeJS.Timeout>();
const pendingRemovedFolders = new Set<string>();
const pendingAddedFolders = new Set<string>();
let folderSyncTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    const scriptWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.cs');
    const assemblyDefinitionWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.{asmdef,asmref}');
    const assetWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**', false, true, false);

    scriptWatcher.onDidCreate((uri: vscode.Uri) => {
        if (isAssetScriptFile(uri.fsPath)) {
            enqueueCsprojUpdate(() => addToCsproj(uri.fsPath));
        }
    });

    scriptWatcher.onDidDelete((uri: vscode.Uri) => {
        if (isAssetScriptFile(uri.fsPath)) {
            enqueueCsprojUpdate(() => removeFromCsproj(uri.fsPath));
        }
    });

    const onAssemblyDefinitionEvent = (uri: vscode.Uri) => {
        if (isAssetAssemblyDefinitionFile(uri.fsPath)) {
            scheduleAsmdefSync(uri.fsPath);
        }
    };

    assemblyDefinitionWatcher.onDidCreate(onAssemblyDefinitionEvent);
    assemblyDefinitionWatcher.onDidChange(onAssemblyDefinitionEvent);
    assemblyDefinitionWatcher.onDidDelete(onAssemblyDefinitionEvent);

    assetWatcher.onDidCreate((uri: vscode.Uri) => {
        if (isDirectory(uri.fsPath)) {
            scheduleFolderSync(pendingAddedFolders, uri.fsPath);
        }
    });

    assetWatcher.onDidDelete((uri: vscode.Uri) => {
        if (!nonFolderDeleteExtensions.has(path.extname(uri.fsPath).toLowerCase())) {
            scheduleFolderSync(pendingRemovedFolders, uri.fsPath);
        }
    });

    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            const oldFilePath = file.oldUri.fsPath;
            const newFilePath = file.newUri.fsPath;

            if (isDirectory(newFilePath)) {
                scheduleFolderSync(pendingRemovedFolders, oldFilePath);
                scheduleFolderSync(pendingAddedFolders, newFilePath);
                return;
            }

            const oldIsAssetScript = isAssetScriptFile(oldFilePath);
            const newIsAssetScript = isAssetScriptFile(newFilePath);

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

            if (isAssetAssemblyDefinitionFile(oldFilePath)) {
                scheduleAsmdefSync(oldFilePath);
            }

            if (isAssetAssemblyDefinitionFile(newFilePath)) {
                scheduleAsmdefSync(newFilePath);
            }
        });
    });

    const pendingSyncsDisposable = new vscode.Disposable(() => {
        for (const timer of pendingAsmdefSyncs.values()) {
            clearTimeout(timer);
        }
        pendingAsmdefSyncs.clear();

        clearTimeout(folderSyncTimer);
        pendingRemovedFolders.clear();
        pendingAddedFolders.clear();
    });

    context.subscriptions.push(scriptWatcher, assemblyDefinitionWatcher, assetWatcher, renameDisposable, pendingSyncsDisposable);
}

function enqueueCsprojUpdate(operation: () => Promise<unknown>): void {
    csprojUpdateQueue = csprojUpdateQueue
        .catch(() => undefined)
        .then(async () => {
            try {
                await operation();
            } catch (err: any) {
                vscode.window.showErrorMessage(getLocalizedMessage('csprojUpdateFailed', { error: err.message }));
            }
        });
}

function scheduleAsmdefSync(asmdefPath: string): void {
    const key = normalizeFileSystemPath(asmdefPath);
    const existingTimer = pendingAsmdefSyncs.get(key);

    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
        pendingAsmdefSyncs.delete(key);
        enqueueCsprojUpdate(() => syncCsprojForAsmdefScope(asmdefPath));
    }, syncDebounceMs);

    pendingAsmdefSyncs.set(key, timer);
}

function scheduleFolderSync(pendingFolders: Set<string>, folderPath: string): void {
    if (!isAssetPath(folderPath)) {
        return;
    }

    pendingFolders.add(folderPath);
    clearTimeout(folderSyncTimer);

    folderSyncTimer = setTimeout(() => {
        const removedFolders = Array.from(pendingRemovedFolders);
        const addedFolders = Array.from(pendingAddedFolders);
        pendingRemovedFolders.clear();
        pendingAddedFolders.clear();
        enqueueCsprojUpdate(() => syncFolderChanges(removedFolders, addedFolders));
    }, syncDebounceMs);
}

function getWorkspaceRootForPath(filePath: string): string | undefined {
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    return workspaceFolder?.uri.fsPath;
}

function isInsideWorkspacePath(filePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, filePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function isAssetPath(filePath: string): boolean {
    const rootPath = getWorkspaceRootForPath(filePath);
    if (!rootPath || !isInsideWorkspacePath(filePath, rootPath)) {
        return false;
    }

    const relativePath = path.relative(rootPath, filePath);
    return relativePath.split(path.sep)[0] === 'Assets' && !isUnityIgnoredPath(relativePath);
}

function isAssetFileWithExtension(filePath: string, extension: string): boolean {
    return path.extname(filePath).toLowerCase() === extension && isAssetPath(filePath);
}

function isAssetScriptFile(filePath: string): boolean {
    return isAssetFileWithExtension(filePath, '.cs');
}

function isAssetAssemblyDefinitionFile(filePath: string): boolean {
    return isAssetFileWithExtension(filePath, '.asmdef') || isAssetFileWithExtension(filePath, '.asmref');
}

function isDirectory(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function findFilesInDirectory(directoryPath: string, suffix: string): string[] {
    if (!isDirectory(directoryPath)) {
        return [];
    }

    const files: string[] = [];

    try {
        for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
            if (isUnityIgnoredName(entry.name)) {
                continue;
            }

            const entryPath = path.join(directoryPath, entry.name);

            if (entry.isDirectory()) {
                files.push(...findFilesInDirectory(entryPath, suffix));
                continue;
            }

            if (entry.isFile() && entry.name.toLowerCase().endsWith(suffix)) {
                files.push(entryPath);
            }
        }
    } catch (err: any) {
        vscode.window.showWarningMessage(getLocalizedMessage('scanFailed', { directoryName: path.basename(directoryPath), error: err.message }));
    }

    return files;
}

function getAllCsprojInfos(rootPath: string): CsprojInfo[] {
    return fs.readdirSync(rootPath)
        .filter(fileName => fileName.endsWith('.csproj'))
        .map(fileName => ({ csprojName: fileName, csprojPath: path.join(rootPath, fileName) }));
}

function createCsprojContentCache(csprojInfos: CsprojInfo[]): CsprojContentCacheEntry[] {
    return csprojInfos
        .filter(({ csprojPath }) => fs.existsSync(csprojPath))
        .map(({ csprojName, csprojPath }) => {
            const content = fs.readFileSync(csprojPath, encoding);
            return { csprojName, csprojPath, originalContent: content, content };
        });
}

function writeChangedCsprojEntries(entries: CsprojContentCacheEntry[]): number {
    const changedEntries = entries.filter(entry => entry.content !== entry.originalContent);

    for (const entry of changedEntries) {
        fs.writeFileSync(entry.csprojPath, entry.content, encoding);
    }

    return changedEntries.length;
}

function reassignScripts(rootPath: string, scriptFiles: string[], entries: CsprojContentCacheEntry[]) {
    const resolver = new AssemblyNameResolver(rootPath);
    const missingCsprojNames = new Set<string>();
    let updatedScripts = 0;
    let unchangedScripts = 0;

    for (const scriptFile of scriptFiles) {
        const target = getCsprojInfoForFile(rootPath, scriptFile, resolver);
        const result = target
            ? reassignCompileInclude(entries, target.csprojPath, toCsprojIncludePath(rootPath, scriptFile))
            : 'unchanged';

        if (result === 'changed') {
            updatedScripts++;
            continue;
        }

        unchangedScripts++;

        if (target && result === 'targetMissing') {
            missingCsprojNames.add(target.csprojName);
        }
    }

    return { missingCsprojNames, updatedScripts, unchangedScripts };
}

function showMissingCsprojErrors(missingCsprojNames: Set<string>): void {
    for (const csprojName of missingCsprojNames) {
        vscode.window.showErrorMessage(getLocalizedMessage('csprojNotFound', { csprojName }));
    }
}

async function syncCsprojForAsmdefScope(asmdefPath: string) {
    const rootPath = getWorkspaceRootForPath(asmdefPath);
    if (!rootPath) {
        return;
    }

    const scriptFiles = findFilesInDirectory(path.dirname(asmdefPath), '.cs');

    if (scriptFiles.length === 0) {
        return;
    }

    const entries = createCsprojContentCache(getAllCsprojInfos(rootPath));
    const { missingCsprojNames, updatedScripts, unchangedScripts } = reassignScripts(rootPath, scriptFiles, entries);

    writeChangedCsprojEntries(entries);
    showMissingCsprojErrors(missingCsprojNames);

    vscode.window.showInformationMessage(getLocalizedMessage('asmdefScopeResynced', {
        scriptCount: scriptFiles.length,
        asmdefName: path.basename(asmdefPath),
        updatedCount: updatedScripts,
        unchangedCount: unchangedScripts,
    }));
}

async function syncFolderChanges(removedFolders: string[], addedFolders: string[]) {
    const rootPaths = new Set<string>();

    for (const folderPath of [...removedFolders, ...addedFolders]) {
        const rootPath = getWorkspaceRootForPath(folderPath);
        if (rootPath) {
            rootPaths.add(rootPath);
        }
    }

    for (const rootPath of rootPaths) {
        const isInRoot = (folderPath: string) => getWorkspaceRootForPath(folderPath) === rootPath;
        const entries = createCsprojContentCache(getAllCsprojInfos(rootPath));

        for (const folderPath of removedFolders.filter(isInRoot)) {
            const relativeFolderPath = toCsprojIncludePath(rootPath, folderPath);

            for (const entry of entries) {
                entry.content = removeCompileIncludesUnderFolder(entry.content, relativeFolderPath) ?? entry.content;
            }
        }

        const scriptFiles = addedFolders.filter(isInRoot).flatMap(folderPath => findFilesInDirectory(folderPath, '.cs'));
        const { missingCsprojNames } = reassignScripts(rootPath, scriptFiles, entries);
        const changedCsprojCount = writeChangedCsprojEntries(entries);

        showMissingCsprojErrors(missingCsprojNames);

        if (changedCsprojCount > 0) {
            vscode.window.showInformationMessage(getLocalizedMessage('foldersSynced', { csprojCount: changedCsprojCount }));
        }
    }
}

function findNearestAssemblyDefinition(filePath: string, rootPath: string): string | null {
    let dir = path.dirname(filePath);

    while (isInsideWorkspacePath(dir, rootPath)) {
        if (isDirectory(dir)) {
            const files = fs.readdirSync(dir);
            const definitionFile = files.find(file => file.endsWith('.asmdef')) ?? files.find(file => file.endsWith('.asmref'));
            if (definitionFile) {
                return path.join(dir, definitionFile);
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

/** Remembers resolved assemblies for one operation, so a broken definition warns once rather than per script. */
class AssemblyNameResolver {
    private readonly assemblyNames = new Map<string, string | null>();
    private asmdefPathsByGuid: Map<string, string> | undefined;

    constructor(private readonly rootPath: string) { }

    getAssemblyName(definitionPath: string): string | null {
        const key = normalizeFileSystemPath(definitionPath);
        const knownName = this.assemblyNames.get(key);
        if (knownName !== undefined) {
            return knownName;
        }

        const assemblyName = this.readAssemblyName(definitionPath);
        this.assemblyNames.set(key, assemblyName);
        return assemblyName;
    }

    private readAssemblyName(definitionPath: string): string | null {
        const definitionName = path.basename(definitionPath);

        try {
            const content = fs.readFileSync(definitionPath, encoding);
            return definitionPath.endsWith('.asmref')
                ? this.readAsmrefAssemblyName(content, definitionName)
                : this.readAsmdefAssemblyName(content, definitionName);
        } catch (err: any) {
            vscode.window.showWarningMessage(getLocalizedMessage('asmdefReadFailed', { asmdefName: definitionName, error: err.message }));
            return null;
        }
    }

    private readAsmdefAssemblyName(content: string, asmdefName: string): string | null {
        const assemblyName = parseAsmdefName(content);
        if (!assemblyName) {
            vscode.window.showWarningMessage(getLocalizedMessage('asmdefInvalidAssemblyName', { asmdefName }));
        }

        return assemblyName;
    }

    private readAsmrefAssemblyName(content: string, asmrefName: string): string | null {
        const reference = parseAsmrefReference(content);
        const guid = reference?.match(/^guid:(.+)$/i)?.[1];
        if (reference && !guid) {
            return reference;
        }

        const asmdefPath = guid ? this.findAsmdefByGuid(guid.toLowerCase()) : undefined;
        if (!asmdefPath) {
            vscode.window.showWarningMessage(getLocalizedMessage('asmrefUnresolved', { asmrefName }));
            return null;
        }

        return this.getAssemblyName(asmdefPath);
    }

    private findAsmdefByGuid(guid: string): string | undefined {
        if (!this.asmdefPathsByGuid) {
            this.asmdefPathsByGuid = new Map();

            for (const folderPath of ['Assets', 'Packages', path.join('Library', 'PackageCache')]) {
                for (const metaPath of findFilesInDirectory(path.join(this.rootPath, folderPath), '.asmdef.meta')) {
                    const metaGuid = parseMetaGuid(fs.readFileSync(metaPath, encoding));
                    if (metaGuid) {
                        this.asmdefPathsByGuid.set(metaGuid, metaPath.slice(0, -'.meta'.length));
                    }
                }
            }
        }

        return this.asmdefPathsByGuid.get(guid);
    }
}

/** Returns null when the script belongs to an assembly whose definition cannot be read, so its project is unknown. */
function getCsprojInfoForFile(rootPath: string, filePath: string, resolver = new AssemblyNameResolver(rootPath)): CsprojInfo | null {
    const definitionPath = findNearestAssemblyDefinition(filePath, rootPath);
    const assemblyName = definitionPath ? resolver.getAssemblyName(definitionPath) : undefined;

    if (assemblyName === null) {
        return null;
    }

    const csprojName = assemblyName ? `${assemblyName}.csproj` : getDefaultCsprojName(toCsprojIncludePath(rootPath, filePath));
    return { csprojName, csprojPath: path.join(rootPath, csprojName) };
}

function addIncludeToCsprojFile(csprojPath: string, relativePath: string): boolean {
    const updatedCsprojContent = addCompileInclude(fs.readFileSync(csprojPath, encoding), relativePath);

    if (!updatedCsprojContent) {
        return false;
    }

    fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
    return true;
}

async function addToCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const rootPath = getWorkspaceRootForPath(filePath);
    if (!rootPath) {
        return 'unchanged';
    }

    const target = getCsprojInfoForFile(rootPath, filePath);
    if (!target) {
        return 'unchanged';
    }

    const { csprojName, csprojPath } = target;

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage('csprojNotFound', { csprojName }));
        return 'unchanged';
    }

    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const playerCsprojPath = getPlayerCsprojPath(csprojPath);
    const addedToPlayerProject = fs.existsSync(playerCsprojPath) && addIncludeToCsprojFile(playerCsprojPath, relativePath);
    const addedToProject = addIncludeToCsprojFile(csprojPath, relativePath);

    if (notify && addedToProject) {
        vscode.window.showInformationMessage(getLocalizedMessage('fileAddedToProject', { fileName: path.basename(filePath), csprojName }));
    }

    return addedToProject || addedToPlayerProject ? 'changed' : 'unchanged';
}

async function removeFromCsproj(filePath: string, notify = true): Promise<CsprojMutationResult> {
    const rootPath = getWorkspaceRootForPath(filePath);
    if (!rootPath) {
        return 'unchanged';
    }

    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const changedProjects: string[] = [];

    for (const { csprojName, csprojPath } of getAllCsprojInfos(rootPath)) {
        const csprojContent = fs.readFileSync(csprojPath, encoding);
        const updatedCsprojContent = removeCompileInclude(csprojContent, relativePath);

        if (!updatedCsprojContent) {
            continue;
        }

        fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
        changedProjects.push(csprojName);
    }

    if (notify && changedProjects.length > 0) {
        vscode.window.showInformationMessage(getLocalizedMessage('fileRemovedFromProjects', {
            fileName: path.basename(filePath),
            csprojNames: changedProjects.join(', '),
        }));
    }

    return changedProjects.length > 0 ? 'changed' : 'unchanged';
}

async function renameInCsproj(oldFilePath: string, newFilePath: string) {
    await removeFromCsproj(oldFilePath);
    await addToCsproj(newFilePath);
}

export function deactivate() { }
