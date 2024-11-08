import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

const encoding = 'utf-8';

export function activate(context: vscode.ExtensionContext) {
    // Настраиваем наблюдатель за созданием, удалением и изменением файлов с расширением .cs
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.cs');
    
    // Обработчик срабатывает при создании нового файла
    watcher.onDidCreate((uri: vscode.Uri) => {
        addToCsproj(uri.fsPath);
    });

    // Обработчик срабатывает при удалении файла
    watcher.onDidDelete((uri: vscode.Uri) => {
        removeFromCsproj(uri.fsPath);
    });

    // Обработчик срабатывает при изменении имени файла
    vscode.workspace.onDidRenameFiles((event) => {
        event.files.forEach((file) => {
            renameInCsproj(file.oldUri.fsPath, file.newUri.fsPath);
        });
    });

    context.subscriptions.push(watcher);
}

// Функция добавления файла в Assembly-CSharp или Assembly-CSharp-Editor в зависимости от пути
function addToCsproj(filePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
    const csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    const csprojPath = path.join(workspaceFolders[0].uri.fsPath, csprojName);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(`${csprojName} not found`);
        return;
    }

    let csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(workspaceFolders[0].uri.fsPath, filePath).replace(/\\/g, '/');

    if (csprojContent.includes(`Compile Include="${relativePath}"`)) {
        return; // Файл уже добавлен в проект
    }

    const newItem = `    <Compile Include="${relativePath}" />\n`;
    const insertPosition = csprojContent.lastIndexOf('</ItemGroup>');
    if (insertPosition === -1) {
        vscode.window.showErrorMessage('Could not find <ItemGroup> to insert into');
        return;
    }

    csprojContent =
        csprojContent.slice(0, insertPosition) +
        newItem +
        csprojContent.slice(insertPosition);

    fs.writeFileSync(csprojPath, csprojContent, encoding);
    vscode.window.showInformationMessage(`Added ${relativePath} to ${csprojName}`);
}

// Функция удаления файла из Assembly-CSharp или Assembly-CSharp-Editor в зависимости от пути
function removeFromCsproj(filePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        return;
    }

    const isEditorScript = filePath.includes(`${path.sep}Editor${path.sep}`);
    const csprojName = isEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    const csprojPath = path.join(workspaceFolders[0].uri.fsPath, csprojName);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(`${csprojName} not found`);
        return;
    }

    let csprojContent = fs.readFileSync(csprojPath, encoding);
    const relativePath = path.relative(workspaceFolders[0].uri.fsPath, filePath).replace(/\\/g, '/');
    const itemToRemove = new RegExp(`\s*<Compile Include="${relativePath}" />\s*\n?`, 'g');
    csprojContent = csprojContent.replace(itemToRemove, '');

    fs.writeFileSync(csprojPath, csprojContent, encoding);
    vscode.window.showInformationMessage(`Removed ${relativePath} from ${csprojName}`);
}

// Функция обновления пути к файлу в Assembly-CSharp или Assembly-CSharp-Editor при переименовании файла
function renameInCsproj(oldFilePath: string, newFilePath: string) {
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders) {
        return;
    }

    const oldIsEditorScript = oldFilePath.includes(`${path.sep}Editor${path.sep}`);
    const newIsEditorScript = newFilePath.includes(`${path.sep}Editor${path.sep}`);
    const csprojName = newIsEditorScript ? 'Assembly-CSharp-Editor.csproj' : 'Assembly-CSharp.csproj';
    const csprojPath = path.join(workspaceFolders[0].uri.fsPath, csprojName);

    if (!fs.existsSync(csprojPath)) {
        vscode.window.showErrorMessage(`${csprojName} not found`);
        return;
    }

    let csprojContent = fs.readFileSync(csprojPath, encoding);
    const oldRelativePath = path.relative(workspaceFolders[0].uri.fsPath, oldFilePath).replace(/\\/g, '/');
    const newRelativePath = path.relative(workspaceFolders[0].uri.fsPath, newFilePath).replace(/\\/g, '/');

    const itemToUpdate = new RegExp(`(<Compile Include=")${oldRelativePath}(" />)`, 'g');
    if (!itemToUpdate.test(csprojContent)) {
        vscode.window.showErrorMessage(`Could not find entry for ${oldRelativePath} in ${csprojName}`);
        return;
    }

    csprojContent = csprojContent.replace(itemToUpdate, `$1${newRelativePath}$2`);

    fs.writeFileSync(csprojPath, csprojContent, encoding);
    vscode.window.showInformationMessage(`Renamed ${oldRelativePath} to ${newRelativePath} in ${csprojName}`);
}

export function deactivate() { }
