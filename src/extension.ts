import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const encoding = 'utf-8';

export function activate(context: vscode.ExtensionContext) {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    
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

// Функции findNearestAsmdef и getAssemblyNameFromAsmdef как показано выше

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

function getAssemblyNameFromAsmdef(asmdefPath: string): string {
    const content = fs.readFileSync(asmdefPath, encoding);
    const asmdefJson = JSON.parse(content);
    return asmdefJson.name;
}

function addToCsproj(filePath: string) {
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
        vscode.window.showErrorMessage(`${csprojName} not found`);
        return;
    }

    let csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');

    if (csprojContent.includes(`Compile Include="${relativePath}"`)) {
        return; // Файл уже добавлен в проект
    }

    const newItem = `    <Compile Include="${relativePath}" />\n`;
    const insertPosition = csprojContent.lastIndexOf('</ItemGroup>');
    if (insertPosition === -1) {
        vscode.window.showErrorMessage('Not found <ItemGroup> for write');
        return;
    }

    csprojContent =
        csprojContent.slice(0, insertPosition) +
        newItem +
        csprojContent.slice(insertPosition);

    fs.writeFileSync(csprojPath, csprojContent, encoding);
    vscode.window.showInformationMessage(`Added ${relativePath} to ${csprojName}`);
}

function removeFromCsproj(filePath: string) {
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
        vscode.window.showErrorMessage(`${csprojName} not found`);
        return;
    }

    let csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(rootPath, filePath).replace(/\\/g, '/');
    const itemToRemove = new RegExp(`\\s*<Compile Include="${relativePath}" />\\s*\\n?`, 'g');
    csprojContent = csprojContent.replace(itemToRemove, '');

    fs.writeFileSync(csprojPath, csprojContent, encoding);
    vscode.window.showInformationMessage(`Deleted ${relativePath} from ${csprojName}`);
}

function renameInCsproj(oldFilePath: string, newFilePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const rootPath = workspaceFolders[0].uri.fsPath;

    // Поиск .asmdef файлов для старого и нового пути
    const oldAsmdefPath = findNearestAsmdef(oldFilePath);
    const newAsmdefPath = findNearestAsmdef(newFilePath);

    let oldAssemblyName = '';
    let oldCsprojName = '';
    let oldCsprojPath = '';

    if (oldAsmdefPath) {
        oldAssemblyName = getAssemblyNameFromAsmdef(oldAsmdefPath);
        oldCsprojName = `${oldAssemblyName}.csproj`;
        oldCsprojPath = path.join(rootPath, oldCsprojName);
    } else {
        const isEditorScript = oldFilePath.includes(`${path.sep}Editor${path.sep}`);
        oldCsprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
        oldCsprojPath = path.join(rootPath, oldCsprojName);
    }

    let newAssemblyName = '';
    let newCsprojName = '';
    let newCsprojPath = '';

    if (newAsmdefPath) {
        newAssemblyName = getAssemblyNameFromAsmdef(newAsmdefPath);
        newCsprojName = `${newAssemblyName}.csproj`;
        newCsprojPath = path.join(rootPath, newCsprojName);
    } else {
        const isEditorScript = newFilePath.includes(`${path.sep}Editor${path.sep}`);
        newCsprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
        newCsprojPath = path.join(rootPath, newCsprojName);
    }

    const oldRelativePath = path.relative(rootPath, oldFilePath).replace(/\\/g, '/');
    const newRelativePath = path.relative(rootPath, newFilePath).replace(/\\/g, '/');

    if (oldCsprojPath === newCsprojPath) {
        // Если файл остаётся в той же сборке, обновляем путь
        if (!fs.existsSync(oldCsprojPath)) {
            vscode.window.showErrorMessage(`${oldCsprojName} not found`);
            return;
        }

        let csprojContent = fs.readFileSync(oldCsprojPath, encoding);

        const itemToUpdate = new RegExp(`(<Compile Include=")${oldRelativePath}(" />)`, 'g');
        if (!itemToUpdate.test(csprojContent)) {
            vscode.window.showErrorMessage(`Unable to find record for ${oldRelativePath} in ${oldCsprojName}`);
            return;
        }

        csprojContent = csprojContent.replace(itemToUpdate, `$1${newRelativePath}$2`);

        fs.writeFileSync(oldCsprojPath, csprojContent, encoding);
        vscode.window.showInformationMessage(`Renamed ${oldRelativePath} to ${newRelativePath} to ${oldCsprojName}`);
    } else {
        // Если файл переместился между сборками, удаляем из старой и добавляем в новую
        removeFromCsproj(oldFilePath);
        addToCsproj(newFilePath);
    }
}

// Функции addToCsproj, removeFromCsproj, renameInCsproj как показано выше

// ...

export function deactivate() { }
