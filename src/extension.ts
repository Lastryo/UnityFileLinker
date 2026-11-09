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
    isUnitySourcePath,
    normalizeFileSystemPath,
    parseAsmdefName,
    parseAsmrefReference,
    parseMetaGuid,
    reassignCompileInclude,
    removeCompileIncludes,
    removeCompileIncludesUnderFolder,
    removeStaleCompileIncludes,
    setCsprojEntryContent,
    toCsprojIncludePath,
} from './csproj';
import { getLocalizedMessage } from './localization';
import { initializeNotifications, logInfo, notifyError, notifyInfo, notifyWarning } from './notifications';

type SyncBatch = {
    scripts: string[];
    assemblyDefinitions: string[];
    removedFolders: string[];
    addedFolders: string[];
};

const syncDebounceMs = 250;
const sourceRootFolders = ['Assets', 'Packages'];
const nonFolderDeleteExtensions = new Set(['.cs', '.asmdef', '.asmref', '.meta']);
let csprojUpdateQueue = Promise.resolve();
const pendingScripts = new Set<string>();
const pendingAssemblyDefinitions = new Set<string>();
const pendingRemovedFolders = new Set<string>();
const pendingAddedFolders = new Set<string>();
let syncTimer: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    initializeNotifications(context);

    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/{Assets,Packages}/**/*.{cs,asmdef,asmref}');
    const assetWatcher = vscode.workspace.createFileSystemWatcher('**/{Assets,Packages}/**', false, true, false);
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

    const resyncCommand = vscode.commands.registerCommand('unityFileLinker.resyncProject', () => {
        enqueueCsprojUpdate(resyncUnityProjects);
    });

    context.subscriptions.push(fileWatcher, assetWatcher, renameDisposable, pendingSyncDisposable, resyncCommand);
}

function enqueueCsprojUpdate(operation: () => Promise<unknown>): void {
    csprojUpdateQueue = csprojUpdateQueue
        .catch(() => undefined)
        .then(async () => {
            try {
                await operation();
            } catch (err: any) {
                notifyError(getLocalizedMessage('csprojUpdateFailed', { error: err.message }));
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
    if (!isSourcePath(changedPath)) {
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

function isSourcePath(filePath: string): boolean {
    const rootPath = getWorkspaceRootForPath(filePath);
    return rootPath !== undefined && isInsideWorkspacePath(filePath, rootPath) && isUnitySourcePath(path.relative(rootPath, filePath));
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
        notifyWarning(getLocalizedMessage('scanFailed', { directoryName: path.basename(directoryPath), error: err.message }));
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

    reportMissingCsprojs(missingCsprojNames);

    if (changedCsprojNames.length > 0) {
        notifyInfo(getSyncSummary(batch, existingScripts, changedCsprojNames));
        logInfo(`Changed: ${changedCsprojNames.join(', ')}`);
    }
}

function reportMissingCsprojs(missingCsprojNames: Set<string>): void {
    for (const csprojName of missingCsprojNames) {
        notifyError(getLocalizedMessage('csprojNotFound', { csprojName }));
    }
}

async function resyncUnityProjects() {
    const rootPaths = (vscode.workspace.workspaceFolders ?? [])
        .map(folder => folder.uri.fsPath)
        .filter(rootPath => fs.existsSync(path.join(rootPath, 'ProjectSettings', 'ProjectVersion.txt')));

    if (rootPaths.length === 0) {
        notifyWarning(getLocalizedMessage('noUnityProject'));
        return;
    }

    for (const rootPath of rootPaths) {
        resyncWorkspaceRoot(rootPath);
    }
}

function resyncWorkspaceRoot(rootPath: string): void {
    const entries = readCsprojEntries(rootPath);
    const scriptFiles = sourceRootFolders.flatMap(folder => findFilesInDirectory(path.join(rootPath, folder), '.cs'));
    const existingIncludes = scriptFiles.map(scriptFile => toCsprojIncludePath(rootPath, scriptFile));

    applyToEntries(entries, content => removeStaleCompileIncludes(content, existingIncludes));

    const missingCsprojNames = reassignScripts(rootPath, scriptFiles, entries);
    const changedCsprojNames = writeChangedCsprojEntries(entries);

    reportMissingCsprojs(missingCsprojNames);

    const summary = changedCsprojNames.length > 0
        ? getLocalizedMessage('projectsSynced', { csprojCount: changedCsprojNames.length })
        : getLocalizedMessage('projectsUpToDate');

    notifyInfo(summary, { alwaysShow: true });

    if (changedCsprojNames.length > 0) {
        logInfo(`Changed: ${changedCsprojNames.join(', ')}`);
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
            notifyWarning(getLocalizedMessage('asmdefReadFailed', { asmdefName: definitionName, error: err.message }));
            return null;
        }
    }

    private readAsmdefAssemblyName(content: string, asmdefName: string): string | null {
        const assemblyName = parseAsmdefName(content);
        if (!assemblyName) {
            notifyWarning(getLocalizedMessage('asmdefInvalidAssemblyName', { asmdefName }));
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
            notifyWarning(getLocalizedMessage('asmrefUnresolved', { asmrefName }));
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

/** Returns null when the script's project is unknown: its definition cannot be read, or Unity does not compile it. */
function getCsprojInfoForFile(rootPath: string, filePath: string, resolver = new AssemblyNameResolver(rootPath)): CsprojInfo | null {
    const definitionPath = findNearestAssemblyDefinition(filePath, rootPath);
    const assemblyName = definitionPath ? resolver.getAssemblyName(definitionPath) : undefined;

    if (assemblyName === null) {
        return null;
    }

    const csprojName = assemblyName ? `${assemblyName}.csproj` : getDefaultCsprojName(toCsprojIncludePath(rootPath, filePath));
    return csprojName ? { csprojName, csprojPath: path.join(rootPath, csprojName) } : null;
}

export function deactivate() { }
