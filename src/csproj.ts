import * as path from 'path';

export const encoding = 'utf-8';

const firstPassRootFolders = new Set(['Plugins', 'Standard Assets', 'Pro Standard Assets']);
const compileElementPattern = String.raw`<Compile\b[^>]*?\bInclude=(['"])(.*?)\1[^>]*?(?:\/>|>[\s\S]*?<\/Compile>)`;

export type CsprojMutationResult = 'changed' | 'unchanged';

export type CsprojReassignmentResult = CsprojMutationResult | 'targetMissing';

export type CsprojInfo = {
    csprojName: string;
    csprojPath: string;
};

export type CsprojContentCacheEntry = CsprojInfo & {
    originalContent: string;
    content: string;
    /** Number of Compile elements per normalized include path, kept in step with content. */
    includeCounts: Map<string, number>;
};

export function toCsprojIncludePath(rootPath: string, filePath: string): string {
    return path.relative(rootPath, filePath).replace(/\//g, '\\');
}

export function decodeXmlAttribute(value: string): string {
    return value
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
}

export function escapeXmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function normalizeCsprojIncludePath(includePath: string): string {
    return decodeXmlAttribute(includePath).replace(/[\\/]+/g, '\\').toLowerCase();
}

export function isSameCsprojIncludePath(firstPath: string, secondPath: string): boolean {
    return normalizeCsprojIncludePath(firstPath) === normalizeCsprojIncludePath(secondPath);
}

export function normalizeFileSystemPath(filePath: string): string {
    const resolvedPath = path.resolve(filePath);
    return process.platform === 'win32' ? resolvedPath.toLowerCase() : resolvedPath;
}

export function isSameFileSystemPath(firstPath: string, secondPath: string): boolean {
    return normalizeFileSystemPath(firstPath) === normalizeFileSystemPath(secondPath);
}

export function isEditorScriptPath(filePath: string): boolean {
    return filePath.split(/[\\/]+/).some(segment => segment === 'Editor');
}

export function isUnityIgnoredName(name: string): boolean {
    return name.startsWith('.') || name.endsWith('~') || name.toLowerCase() === 'cgi-bin';
}

export function isUnityIgnoredPath(relativePath: string): boolean {
    return relativePath.split(/[\\/]+/).some(isUnityIgnoredName);
}

export function getDefaultCsprojName(relativePath: string): string {
    const isFirstPass = firstPassRootFolders.has(relativePath.split(/[\\/]+/)[1]);
    const editorSuffix = isEditorScriptPath(relativePath) ? '-Editor' : '';
    const firstPassSuffix = isFirstPass ? '-firstpass' : '';

    return `Assembly-CSharp${editorSuffix}${firstPassSuffix}.csproj`;
}

export function getPlayerCsprojPath(csprojPath: string): string {
    return csprojPath.replace(/\.csproj$/i, '.Player.csproj');
}

function parseJsonWithoutBom(content: string): any {
    return JSON.parse(content.replace(/^\uFEFF/, ''));
}

function getNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export function parseAsmdefName(content: string): string | null {
    return getNonEmptyString(parseJsonWithoutBom(content).name);
}

export function parseAsmrefReference(content: string): string | null {
    return getNonEmptyString(parseJsonWithoutBom(content).reference);
}

export function parseMetaGuid(content: string): string | null {
    return content.match(/^guid:\s*([0-9a-fA-F]+)/m)?.[1].toLowerCase() ?? null;
}

function getLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function getCompileIncludeMatches(csprojContent: string): RegExpMatchArray[] {
    return Array.from(csprojContent.matchAll(new RegExp(compileElementPattern, 'g')));
}

function createCompileLineRegex(): RegExp {
    return new RegExp(String.raw`^[ \t]*${compileElementPattern}[ \t]*(?:\r?\n|$)`, 'gm');
}

function getCompileIncludeCounts(csprojContent: string): Map<string, number> {
    const counts = new Map<string, number>();

    for (const match of getCompileIncludeMatches(csprojContent)) {
        const includePath = normalizeCsprojIncludePath(match[2]);
        counts.set(includePath, (counts.get(includePath) ?? 0) + 1);
    }

    return counts;
}

export function createCsprojContentEntry(info: CsprojInfo, content: string): CsprojContentCacheEntry {
    return { ...info, originalContent: content, content, includeCounts: getCompileIncludeCounts(content) };
}

export function setCsprojEntryContent(entry: CsprojContentCacheEntry, content: string): void {
    entry.content = content;
    entry.includeCounts = getCompileIncludeCounts(content);
}

export function countCompileIncludes(csprojContent: string, relativePath: string): number {
    return getCompileIncludeMatches(csprojContent).filter(match => isSameCsprojIncludePath(match[2], relativePath)).length;
}

export function hasCompileInclude(csprojContent: string, relativePath: string): boolean {
    return countCompileIncludes(csprojContent, relativePath) > 0;
}

function inferCompileIndent(itemGroupContent: string, itemGroupIndent: string): string {
    const compileLineMatch = itemGroupContent.match(/\r?\n([ \t]*)<Compile\b/);
    if (compileLineMatch) {
        return compileLineMatch[1];
    }

    const childLineMatch = itemGroupContent.match(/\r?\n([ \t]*)<[^/!][^>]*>/);
    if (childLineMatch) {
        return childLineMatch[1];
    }

    return `${itemGroupIndent}  `;
}

function getCompileInsertIndex(itemGroupContent: string): number {
    const compileLineRegex = createCompileLineRegex();
    let insertIndex = -1;
    let match: RegExpExecArray | null;

    while ((match = compileLineRegex.exec(itemGroupContent)) !== null) {
        insertIndex = match.index + match[0].length;
    }

    if (insertIndex !== -1) {
        return insertIndex;
    }

    const firstReferenceMatch = itemGroupContent.match(/^[ \t]*<Reference\b/m);
    if (firstReferenceMatch?.index !== undefined) {
        return firstReferenceMatch.index;
    }

    return itemGroupContent.lastIndexOf('</ItemGroup>');
}

export function addCompileInclude(csprojContent: string, relativePath: string): string | null {
    if (hasCompileInclude(csprojContent, relativePath)) {
        return null;
    }

    const lineEnding = getLineEnding(csprojContent);
    const escapedRelativePath = escapeXmlAttribute(relativePath);
    const itemGroupRegex = /(^[ \t]*)<ItemGroup\b[^>]*>[\s\S]*?<\/ItemGroup>/gm;
    const itemGroups = Array.from(csprojContent.matchAll(itemGroupRegex));

    let targetItemGroup: RegExpMatchArray | undefined;
    const analyzerIndex = itemGroups.findIndex(match => /<Analyzer\b/.test(match[0]));
    if (analyzerIndex !== -1 && analyzerIndex + 1 < itemGroups.length) {
        targetItemGroup = itemGroups[analyzerIndex + 1];
    } else {
        targetItemGroup = itemGroups.find(match => /<Compile\b/.test(match[0])) ?? itemGroups[0];
    }

    if (targetItemGroup && targetItemGroup.index !== undefined) {
        const itemGroupContent = targetItemGroup[0];
        const itemGroupIndent = targetItemGroup[1];
        const compileIndent = inferCompileIndent(itemGroupContent, itemGroupIndent);
        const compileLine = `${compileIndent}<Compile Include="${escapedRelativePath}" />${lineEnding}`;
        const insertIndex = getCompileInsertIndex(itemGroupContent);
        const updatedItemGroup = `${itemGroupContent.slice(0, insertIndex)}${compileLine}${itemGroupContent.slice(insertIndex)}`;

        return `${csprojContent.slice(0, targetItemGroup.index)}${updatedItemGroup}${csprojContent.slice(targetItemGroup.index + itemGroupContent.length)}`;
    }

    const projectCloseMatch = csprojContent.match(/(^[ \t]*)<\/Project>/m);
    if (!projectCloseMatch || projectCloseMatch.index === undefined) {
        throw new Error('Project closing tag not found');
    }

    const projectIndent = projectCloseMatch[1];
    const itemGroupIndent = `${projectIndent}  `;
    const compileIndent = `${itemGroupIndent}  `;
    const newItemGroup = `${itemGroupIndent}<ItemGroup>${lineEnding}${compileIndent}<Compile Include="${escapedRelativePath}" />${lineEnding}${itemGroupIndent}</ItemGroup>${lineEnding}`;

    return `${csprojContent.slice(0, projectCloseMatch.index)}${newItemGroup}${csprojContent.slice(projectCloseMatch.index)}`;
}

function removeCompileIncludesMatching(csprojContent: string, shouldRemove: (includePath: string) => boolean): string | null {
    let removed = false;
    const updatedContent = csprojContent.replace(createCompileLineRegex(), (match, _quote, includePath) => {
        if (shouldRemove(includePath)) {
            removed = true;
            return '';
        }

        return match;
    });

    return removed ? updatedContent : null;
}

export function removeCompileInclude(csprojContent: string, relativePath: string): string | null {
    return removeCompileIncludesMatching(csprojContent, includePath => isSameCsprojIncludePath(includePath, relativePath));
}

export function removeCompileIncludes(csprojContent: string, relativePaths: string[]): string | null {
    const normalizedPaths = new Set(relativePaths.map(normalizeCsprojIncludePath));
    return removeCompileIncludesMatching(csprojContent, includePath => normalizedPaths.has(normalizeCsprojIncludePath(includePath)));
}

export function removeCompileIncludesUnderFolder(csprojContent: string, relativeFolderPath: string): string | null {
    const folderPrefix = `${normalizeCsprojIncludePath(relativeFolderPath)}\\`;
    return removeCompileIncludesMatching(csprojContent, includePath => normalizeCsprojIncludePath(includePath).startsWith(folderPrefix));
}

export function reassignCompileInclude(
    entries: CsprojContentCacheEntry[],
    targetCsprojPath: string,
    relativePath: string,
): CsprojReassignmentResult {
    if (!entries.some(entry => isSameFileSystemPath(entry.csprojPath, targetCsprojPath))) {
        return 'targetMissing';
    }

    const playerCsprojPath = getPlayerCsprojPath(targetCsprojPath);
    const includeKey = normalizeCsprojIncludePath(relativePath);
    let changed = false;

    for (const entry of entries) {
        const isTarget = isSameFileSystemPath(entry.csprojPath, targetCsprojPath) || isSameFileSystemPath(entry.csprojPath, playerCsprojPath);

        if ((entry.includeCounts.get(includeKey) ?? 0) > (isTarget ? 1 : 0)) {
            const withoutInclude = removeCompileInclude(entry.content, relativePath);
            if (withoutInclude) {
                entry.content = withoutInclude;
                entry.includeCounts.delete(includeKey);
                changed = true;
            }
        }

        if (isTarget && !entry.includeCounts.has(includeKey)) {
            const withInclude = addCompileInclude(entry.content, relativePath);
            if (withInclude) {
                entry.content = withInclude;
                entry.includeCounts.set(includeKey, 1);
                changed = true;
            }
        }
    }

    return changed ? 'changed' : 'unchanged';
}
