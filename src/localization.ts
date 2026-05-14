import * as vscode from 'vscode';

type MessageParams = Record<string, string | number>;

type MessageKey =
    | 'csprojUpdateFailed'
    | 'scanFailed'
    | 'csprojNotFound'
    | 'asmdefInvalidAssemblyName'
    | 'asmdefReadFailed'
    | 'fileAddedToProject'
    | 'fileRemovedFromProjects'
    | 'asmdefScopeResynced';

const messages: Record<string, Record<MessageKey, string>> = {
    en: {
        csprojUpdateFailed: 'Failed to update csproj: {error}',
        scanFailed: 'Failed to scan {directoryName}: {error}',
        csprojNotFound: '{csprojName} not found',
        asmdefInvalidAssemblyName: '{asmdefName} does not contain a valid assembly name',
        asmdefReadFailed: 'Failed to read {asmdefName}: {error}',
        fileAddedToProject: 'Added {fileName} to {csprojName}',
        fileRemovedFromProjects: 'Removed {fileName} from {csprojNames}',
        asmdefScopeResynced: 'Resynced {scriptCount} scripts for {asmdefName}: {updatedCount} updated, {unchangedCount} unchanged',
    },
    ru: {
        csprojUpdateFailed: 'Не удалось обновить csproj: {error}',
        scanFailed: 'Не удалось просканировать {directoryName}: {error}',
        csprojNotFound: '{csprojName} не найден',
        asmdefInvalidAssemblyName: '{asmdefName} не содержит корректное имя сборки',
        asmdefReadFailed: 'Не удалось прочитать {asmdefName}: {error}',
        fileAddedToProject: '{fileName} добавлен в {csprojName}',
        fileRemovedFromProjects: '{fileName} удалён из {csprojNames}',
        asmdefScopeResynced: 'Повторно синхронизировано {scriptCount} скриптов для {asmdefName}: {updatedCount} обновлено, {unchangedCount} без изменений',
    },
};

export function getLocalizedMessage(key: MessageKey, params: MessageParams = {}): string {
    const language = vscode.env.language.toLowerCase();
    const languageMessages = messages[language] ?? messages[language.split('-')[0]] ?? messages.en;
    const template = languageMessages[key] ?? messages.en[key];

    return template.replace(/\{(\w+)\}/g, (_match, paramName: string) => String(params[paramName] ?? `{${paramName}}`));
}
