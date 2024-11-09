import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseStringPromise, Builder } from 'xml2js';
import { getLocalizedMessage } from './localization';

const encoding = 'utf-8';

export function activate(context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/Assets/**/*.cs');

    watcher.onDidCreate((uri: vscode.Uri) => {
        addToCsproj(uri.fsPath);
    });

    watcher.onDidDelete((uri: vscode.Uri) => {
        removeFromCsproj(uri.fsPath);
    });

    vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            renameInCsproj(file.oldUri.fsPath, file.newUri.fsPath);
        });
    });

    context.subscriptions.push(watcher);
}

// Функция для поиска ближайшего .asmdef файла
function findNearestAsmdef(filePath: string): string | null {
    let dir = path.dirname(filePath);
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;

    while (dir.startsWith(root)) {
        const asmdefFiles = fs.readdirSync(dir).filter(file => file.endsWith('.asmdef'));
        if (asmdefFiles.length > 0) {
            return path.join(dir, asmdefFiles[0]);
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

async function addToCsproj(filePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;
    let assemblyName = '';
    let csprojName = '';
    let csprojPath = '';

    // Поиск ближайшего .asmdef файла
    const asmdefPath = findNearestAsmdef(filePath);

    if (asmdefPath) {
        // Получаем имя сборки из .asmdef файла
        assemblyName = getAssemblyNameFromAsmdef(asmdefPath);
        csprojName = `${assemblyName}.csproj`;
        csprojPath = path.join(rootPath, csprojName);
    } else {
        // Используем стандартные сборки Unity
        const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
        csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
        csprojPath = path.join(rootPath, csprojName);
    }

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
        return;
    }

    const csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(rootPath, filePath).replace(/\//g, '\\');

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
                if (compile.$ && compile.$.Include === relativePath) {
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
    let assemblyName = '';
    let csprojName = '';
    let csprojPath = '';

    // Поиск ближайшего .asmdef файла
    const asmdefPath = findNearestAsmdef(filePath);

    if (asmdefPath) {
        assemblyName = getAssemblyNameFromAsmdef(asmdefPath);
        csprojName = `${assemblyName}.csproj`;
        csprojPath = path.join(rootPath, csprojName);
    } else {
        const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
        csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
        csprojPath = path.join(rootPath, csprojName);
    }

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(getLocalizedMessage(`${csprojName} not found`));
        return;
    }

    const csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(rootPath, filePath).replace(/\//g, '\\');

    // Парсинг XML-содержимого
    let xmlObj;
    try {
        xmlObj = await parseStringPromise(csprojContent);
    } catch (err: any) {
        vscode.window.showErrorMessage(getLocalizedMessage(`Failed to parse ${csprojName}: ${err.message}`));
        return;
    }

    let itemGroups = xmlObj.Project.ItemGroup;
    if (!itemGroups) {
        return;
    }

    let found = false;

    // Ищем и удаляем элемент Compile с указанным файлом
    for (const itemGroup of itemGroups) {
        if (itemGroup.Compile) {
            const newCompileList = itemGroup.Compile.filter((compile: any) => {
                return compile.$.Include !== relativePath;
            });

            if (newCompileList.length !== itemGroup.Compile.length) {
                itemGroup.Compile = newCompileList;
                found = true;
                break;
            }
        }
    }

    if (!found) {
        // Файл не найден в проекте
        return;
    }

    // Сборка XML обратно в строку
    const builder = new Builder({ headless: true });
    const updatedCsprojContent = builder.buildObject(xmlObj);

    // Записываем изменения обратно в файл .csproj
    fs.writeFileSync(csprojPath, updatedCsprojContent, encoding);
    vscode.window.showInformationMessage(getLocalizedMessage(`Removed ${path.basename(filePath)} from ${csprojName}`));
}

async function renameInCsproj(oldFilePath: string, newFilePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Удаляем старый файл из проекта
    await removeFromCsproj(oldFilePath);

    // Добавляем новый файл в проект
    await addToCsproj(newFilePath);
}

export function deactivate() { }
