import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import { getLocalizedMessage } from './localization';

const encoding = 'utf-8';
let csprojUpdateQueue = Promise.resolve();

export function activate(context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.cs');

    watcher.onDidCreate((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => addToCsproj(uri.fsPath));
    });

    watcher.onDidDelete((uri: vscode.Uri) => {
        enqueueCsprojUpdate(() => removeFromCsproj(uri.fsPath));
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
            }
        });
    });

    context.subscriptions.push(watcher, renameDisposable);
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

function isAssetScriptFile(filePath: string, rootPath: string): boolean {
    if (!isInsideWorkspacePath(filePath, rootPath)) {
        return false;
    }

    const relativePath = path.relative(rootPath, filePath);
    const firstPathSegment = relativePath.split(path.sep)[0];
    return firstPathSegment === 'Assets' && path.extname(filePath).toLowerCase() === '.cs';
}

function toCsprojIncludePath(rootPath: string, filePath: string): string {
    return path.relative(rootPath, filePath).replace(/\//g, '\\');
}

function normalizeCsprojIncludePath(includePath: string): string {
    return includePath.replace(/[\\/]+/g, '\\').toLowerCase();
}

function isSameCsprojIncludePath(firstPath: string, secondPath: string): boolean {
    return normalizeCsprojIncludePath(firstPath) === normalizeCsprojIncludePath(secondPath);
}

function isDirectory(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
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
function getAssemblyNameFromAsmdef(asmdefPath: string): string {
    const content = fs.readFileSync(asmdefPath, encoding);
    const asmdefJson = JSON.parse(content);
    return asmdefJson.name;
}

function getDefaultCsprojInfo(rootPath: string, filePath: string): { csprojName: string; csprojPath: string } {
    const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
    const csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    return { csprojName, csprojPath: path.join(rootPath, csprojName) };
}

function getCsprojInfoForFile(rootPath: string, filePath: string): { csprojName: string; csprojPath: string } {
    const asmdefPath = findNearestAsmdef(filePath);

    if (asmdefPath) {
        const assemblyName = getAssemblyNameFromAsmdef(asmdefPath);
        const csprojName = `${assemblyName}.csproj`;
        return { csprojName, csprojPath: path.join(rootPath, csprojName) };
    }

    return getDefaultCsprojInfo(rootPath, filePath);
}

function getRemovalCsprojCandidates(rootPath: string, filePath: string): { csprojName: string; csprojPath: string }[] {
    const candidates = new Map<string, { csprojName: string; csprojPath: string }>();

    const addCandidate = (candidate: { csprojName: string; csprojPath: string }) => {
        candidates.set(candidate.csprojPath, candidate);
    };

    addCandidate(getCsprojInfoForFile(rootPath, filePath));

    for (const fileName of fs.readdirSync(rootPath)) {
        if (fileName.endsWith('.csproj')) {
            addCandidate({ csprojName: fileName, csprojPath: path.join(rootPath, fileName) });
        }
    }

    return Array.from(candidates.values());
}

async function addToCsproj(filePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const { csprojName, csprojPath } = getCsprojInfoForFile(rootPath, filePath);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
        return;
    }

    const csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = toCsprojIncludePath(rootPath, filePath);

    // Парсинг XML-содержимого
    let xmlObj;
    try {
        xmlObj = await parseStringPromise(csprojContent);
    } catch (err: any) {
        vscode.window.showErrorMessage(getLocalizedMessage(`Failed to parse ${csprojName}: ${err.message}`));
        return;
    }

    // Поиск ItemGroup, который идёт сразу после Analyzers
    let itemGroups = xmlObj.Project.ItemGroup;
    if (!itemGroups) {
        itemGroups = [];
        xmlObj.Project.ItemGroup = itemGroups;
    }

    let insertIndex = -1;
    for (let i = 0; i < itemGroups.length; i++) {
        const itemGroup = itemGroups[i];

        // Проверяем, содержит ли этот ItemGroup Analyzers
        if (itemGroup.Analyzer) {
            // Следующий ItemGroup — это место для вставки
            insertIndex = i + 1;
            break;
        }
    }

    // Если Analyzers не найдены или нет следующего ItemGroup, создаём новый
    if (insertIndex === -1 || insertIndex >= itemGroups.length) {
        // Создаём новый ItemGroup в конце
        itemGroups.push({});
        insertIndex = itemGroups.length - 1;
    }

    // Подготавливаем элемент Compile
    const compileItem = { $: { Include: relativePath } };

    // Проверяем, есть ли файл уже в проекте
    for (const ig of itemGroups) {
        if (ig.Compile) {
            for (const compile of ig.Compile) {
                if (compile.$ && isSameCsprojIncludePath(compile.$.Include, relativePath)) {
                    // Файл уже добавлен
                    return;
                }
            }
        }
    }

    // Вставляем элемент Compile в нужный ItemGroup
    if (!itemGroups[insertIndex].Compile) {
        itemGroups[insertIndex].Compile = [];
    }
    itemGroups[insertIndex].Compile.push(compileItem);

    // Сборка XML обратно в строку
    const builder = new Builder({ headless: true });
    const updatedCsprojContent = builder.buildObject(xmlObj);

    // Записываем изменения обратно в файл .csproj
    fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
    vscode.window.showInformationMessage(getLocalizedMessage(`Added ${path.basename(filePath)} to ${csprojName}`));
}

async function removeFromCsproj(filePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    const relativePath = toCsprojIncludePath(rootPath, filePath);
    const csprojCandidates = getRemovalCsprojCandidates(rootPath, filePath);

    for (const { csprojName, csprojPath } of csprojCandidates) {
        if (!fs.existsSync(csprojPath)) {
            continue;
        }

        const csprojContent = fs.readFileSync(csprojPath, encoding);

        // Парсинг XML-содержимого
        let xmlObj;
        try {
            xmlObj = await parseStringPromise(csprojContent);
        } catch (err: any) {
            vscode.window.showErrorMessage(getLocalizedMessage(`Failed to parse ${csprojName}: ${err.message}`));
            continue;
        }

        let itemGroups = xmlObj.Project.ItemGroup;
        if (!itemGroups) {
            continue;
        }

        let found = false;

        // Ищем и удаляем элемент Compile с указанным файлом
        for (const itemGroup of itemGroups) {
            if (itemGroup.Compile) {
                const newCompileList = itemGroup.Compile.filter((compile: any) => {
                    return !compile.$ || !isSameCsprojIncludePath(compile.$.Include, relativePath);
                });

                if (newCompileList.length !== itemGroup.Compile.length) {
                    itemGroup.Compile = newCompileList;
                    found = true;
                    break;
                }
            }
        }

        if (!found) {
            continue;
        }

        // Сборка XML обратно в строку
        const builder = new Builder({ headless: true });
        const updatedCsprojContent = builder.buildObject(xmlObj);

        // Записываем изменения обратно в файл .csproj
        fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
        vscode.window.showInformationMessage(getLocalizedMessage(`Removed ${path.basename(filePath)} from ${csprojName}`));
        return;
    }
}

async function renameInCsproj(oldFilePath: string, newFilePath: string) {
    // Удаляем старый файл из проекта
    await removeFromCsproj(oldFilePath);

    // Добавляем новый файл в проект
    await addToCsproj(newFilePath);
}

export function deactivate() { }
