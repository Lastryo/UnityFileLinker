import * as path from 'path';

export const encoding = 'utf-8';

export type CsprojMutationResult = 'changed' | 'unchanged';

export type CsprojInfo = {
    csprojName: string;
    csprojPath: string;
};

export type CsprojContentCacheEntry = CsprojInfo & {
    originalContent: string;
    content: string;
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

function getLineEnding(content: string): string {
    return content.includes('\r\n') ? '\r\n' : '\n';
}

function getCompileIncludeMatches(csprojContent: string): RegExpMatchArray[] {
    return Array.from(csprojContent.matchAll(/<Compile\b[^>]*\bInclude=(['"])(.*?)\1[^>]*(?:\/>|>[\s\S]*?<\/Compile>)/g));
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
    const compileLineRegex = /^[ \t]*<Compile\b[^>]*\bInclude=(['"])(.*?)\1[^>]*(?:\/>|>[\s\S]*?<\/Compile>)[ \t]*(?:\r?\n|$)/gm;
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

export function removeCompileInclude(csprojContent: string, relativePath: string): string | null {
    let removed = false;
    const updatedContent = csprojContent.replace(/(^[ \t]*<Compile\b[^>]*\bInclude=(['"])(.*?)\2[^>]*(?:\/>|>[\s\S]*?<\/Compile>)[ \t]*(?:\r?\n|$))/gm, (match, _line, _quote, includePath) => {
        if (isSameCsprojIncludePath(includePath, relativePath)) {
            removed = true;
            return '';
        }

        return match;
    });

    return removed ? updatedContent : null;
}
