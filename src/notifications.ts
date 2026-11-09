import * as vscode from 'vscode';

const statusBarMessageMs = 5000;
let channel: vscode.LogOutputChannel | undefined;

export function initializeNotifications(context: vscode.ExtensionContext): void {
    channel = vscode.window.createOutputChannel('UnityFileLinker', { log: true });
    context.subscriptions.push(channel);
}

export function logInfo(message: string): void {
    channel?.info(message);
}

/** Routine updates go to the log and status bar; a toast appears only on request or when the setting is on. */
export function notifyInfo(message: string, options: { alwaysShow?: boolean } = {}): void {
    logInfo(message);
    vscode.window.setStatusBarMessage(`$(sync) UnityFileLinker: ${message}`, statusBarMessageMs);

    if (options.alwaysShow || vscode.workspace.getConfiguration('unityFileLinker').get<boolean>('showInfoNotifications')) {
        vscode.window.showInformationMessage(message);
    }
}

export function notifyWarning(message: string): void {
    channel?.warn(message);
    vscode.window.showWarningMessage(message);
}

export function notifyError(message: string): void {
    channel?.error(message);
    vscode.window.showErrorMessage(message);
}
