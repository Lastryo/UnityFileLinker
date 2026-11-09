import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
    createCsprojContentEntry,
    CsprojContentCacheEntry,
    CsprojInfo,
    encoding,
    getDefaultCsprojName,
    isUnityIgnoredName,
    isUnityIgnoredPath,
    normalizeFileSystemPath,
    parseAsmdefName,
    parseAsmrefReference,
    parseMetaGuid,
    reassignCompileInclude,
    removeCompileIncludes,
    removeCompileIncludesUnderFolder,
    setCsprojEntryContent,
    toCsprojIncludePath,
} from './csproj';
import { getLocalizedMessage } from './localization';

type SyncBatch = {
    scripts: string[];
    assemblyDefinitions: string[];
    removedFolders: string[];
    addedFolders: string[];
};

const syncDebounceMs = 250;
const nonFolderDeleteExtensions = new Set(['.cs', '.asmdef', '.asmref', '.meta']);
let csprojUpdateQueue = Promise.resolve();
const pendingScripts = new Set<string>();
const pendingAssemblyDefinitions = new Set<string>();
const pendingRemovedFolders = new Set<string>();
const pendingAddedFolders = new Set<string>();
let syncTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.{cs,asmdef,asmref}');
    const assetWatcher = vscode.workspace.createFileSystemWatcher('**/Assets/**', false, true, false);
    const onFileEvent = (uri: vscode.Uri) => scheduleFileSync(uri.fsPath);

    fileWatcher.onDidCreate(onFileEvent);
    fileWatcher.onDidChange((uri: vscode.Uri) => {
        if (path.extname(uri.fsPath).toLowerCase() !== '.cs') {
            scheduleFileSync(uri.fsPath);
        }
    });
    fileWatcher.onDidDelete(onFileEvent);

    assetWatcher.onDidCreate((uri: vscode.Uri) => {
        if (isDirectory(uri.fsPath)) {
            scheduleSync(pendingAddedFolders, uri.fsPath);
        }
    });

    assetWatcher.onDidDelete((uri: vscode.Uri) => {
        if (!nonFolderDeleteExtensions.has(path.extname(uri.fsPath).toLowerCase())) {
            scheduleSync(pendingRemovedFolders, uri.fsPath);
        }
    });

    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        for (const file of event.files) {
            if (isDirectory(file.newUri.fsPath)) {
                scheduleSync(pendingRemovedFolders, file.oldUri.fsPath);
                scheduleSync(pendingAddedFolders, file.newUri.fsPath);
                continue;
            }

            scheduleFileSync(file.oldUri.fsPath);
            scheduleFileSync(file.newUri.fsPath);
        }
    });

    const pendingSyncDisposable = new vscode.Disposable(() => {
        clearTimeout(syncTimer);
        takePendingBatch();
    });

    context.subscriptions.push(fileWatcher, assetWatcher, renameDisposable, pendingSyncDisposable);
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

function scheduleFileSync(filePath: string): void {
    const extension = path.extname(filePath).toLowerCase();

    if (extension === '.cs') {
        scheduleSync(pendingScripts, filePath);
    } else if (extension === '.asmdef' || extension === '.asmref') {
        scheduleSync(pendingAssemblyDefinitions, filePath);
    }
}

function scheduleSync(pendingPaths: Set<string>, changedPath: string): void {
    if (!isAssetPath(changedPath)) {
        return;
    }

    pendingPaths.add(changedPath);
    clearTimeout(syncTimer);

    syncTimer = setTimeout(() => {
        const batch = takePendingBatch();
        enqueueCsprojUpdate(() => syncBatch(batch));
    }, syncDebounceMs);
}

function takePendingBatch(): SyncBatch {
    const batch = {
        scripts: Array.from(pendingScripts),
        assemblyDefinitions: Array.from(pendingAssemblyDefinitions),
        removedFolders: Array.from(pendingRemovedFolders),
        addedFolders: Array.from(pendingAddedFolders),
    };

    for (const pendingPaths of [pendingScripts, pendingAssemblyDefinitions, pendingRemovedFolders, pendingAddedFolders]) {
        pendingPaths.clear();
    }

    return batch;
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

function readCsprojEntries(rootPath: string): CsprojContentCacheEntry[] {
    return getAllCsprojInfos(rootPath).map(info => createCsprojContentEntry(info, fs.readFileSync(info.csprojPath, encoding)));
}

function writeChangedCsprojEntries(entries: CsprojContentCacheEntry[]): string[] {
    const changedEntries = entries.filter(entry => entry.content !== entry.originalContent);

    for (const entry of changedEntries) {
        fs.writeFileSync(entry.csprojPath, entry.content, encoding);
    }

    return changedEntries.map(entry => entry.csprojName);
}

function reassignScripts(rootPath: string, scriptFiles: Iterable<string>, entries: CsprojContentCacheEntry[]): Set<string> {
    const resolver = new AssemblyNameResolver(rootPath);
    const missingCsprojNames = new Set<string>();

    for (const scriptFile of scriptFiles) {
        const target = getCsprojInfoForFile(rootPath, scriptFile, resolver);

        if (target && reassignCompileInclude(entries, target.csprojPath, toCsprojIncludePath(rootPath, scriptFile)) === 'targetMissing') {
            missingCsprojNames.add(target.csprojName);
        }
    }

    return missingCsprojNames;
}

function applyToEntries(entries: CsprojContentCacheEntry[], update: (content: string) => string | null): void {
    for (const entry of entries) {
        const updatedContent = update(entry.content);
        if (updatedContent) {
            setCsprojEntryContent(entry, updatedContent);
        }
    }
}

async function syncBatch(batch: SyncBatch) {
    const allPaths = [...batch.scripts, ...batch.assemblyDefinitions, ...batch.removedFolders, ...batch.addedFolders];
    const rootPaths = new Set(allPaths.map(getWorkspaceRootForPath));

    for (const rootPath of rootPaths) {
        if (rootPath) {
            const isInRoot = (changedPath: string) => getWorkspaceRootForPath(changedPath) === rootPath;
            syncWorkspaceRoot(rootPath, {
                scripts: batch.scripts.filter(isInRoot),
                assemblyDefinitions: batch.assemblyDefinitions.filter(isInRoot),
                removedFolders: batch.removedFolders.filter(isInRoot),
                addedFolders: batch.addedFolders.filter(isInRoot),
            });
        }
    }
}

function syncWorkspaceRoot(rootPath: string, batch: SyncBatch): void {
    const entries = readCsprojEntries(rootPath);
    const existingScripts = batch.scripts.filter(scriptFile => fs.existsSync(scriptFile));
    const deletedIncludes = batch.scripts
        .filter(scriptFile => !fs.existsSync(scriptFile))
        .map(scriptFile => toCsprojIncludePath(rootPath, scriptFile));

    for (const folderPath of batch.removedFolders) {
        const relativeFolderPath = toCsprojIncludePath(rootPath, folderPath);
        applyToEntries(entries, content => removeCompileIncludesUnderFolder(content, relativeFolderPath));
    }

    if (deletedIncludes.length > 0) {
        applyToEntries(entries, content => removeCompileIncludes(content, deletedIncludes));
    }

    const scannedFolders = [...batch.addedFolders, ...batch.assemblyDefinitions.map(definitionPath => path.dirname(definitionPath))];
    const scriptsToAssign = new Set([...existingScripts, ...scannedFolders.flatMap(folderPath => findFilesInDirectory(folderPath, '.cs'))]);
    const missingCsprojNames = reassignScripts(rootPath, scriptsToAssign, entries);
    const changedCsprojNames = writeChangedCsprojEntries(entries);

    for (const csprojName of missingCsprojNames) {
        vscode.window.showErrorMessage(getLocalizedMessage('csprojNotFound', { csprojName }));
    }

    if (changedCsprojNames.length > 0) {
        vscode.window.showInformationMessage(getSyncSummary(batch, existingScripts, changedCsprojNames));
    }
}

function getSyncSummary(batch: SyncBatch, existingScripts: string[], changedCsprojNames: string[]): string {
    const isSingleScriptChange = batch.scripts.length === 1
        && batch.assemblyDefinitions.length === 0
        && batch.removedFolders.length === 0
        && batch.addedFolders.length === 0;

    if (!isSingleScriptChange) {
        return getLocalizedMessage('projectsSynced', { csprojCount: changedCsprojNames.length });
    }

    const fileName = path.basename(batch.scripts[0]);
    const csprojNames = changedCsprojNames.join(', ');

    return existingScripts.length > 0
        ? getLocalizedMessage('fileAddedToProject', { fileName, csprojName: csprojNames })
        : getLocalizedMessage('fileRemovedFromProjects', { fileName, csprojNames });
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

export function deactivate() { }
