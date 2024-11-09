import * as vscode from 'vscode';

export function getLocalizedMessage(message: string): string {
    const language = vscode.env.language;
    const messages: Record<string, Record<string, string>> = {
        'en': {
            'not found': 'not found',
            'Failed to parse': 'Failed to parse',
            'Added': 'Added',
            'to': 'to',
            'Removed': 'Removed',
            'from': 'from'
        },
        'ru': {
            'not found': 'не найден',
            'Failed to parse': 'Не удалось разобрать',
            'Added': 'Добавлен',
            'to': 'в',
            'Removed': 'Удалён',
            'from': 'из'
        },
        'zh-cn': {
            'not found': '未找到',
            'Failed to parse': '解析失败',
            'Added': '已添加',
            'to': '到',
            'Removed': '已移除',
            'from': '从'
        },
        'fr': {
            'not found': 'introuvable',
            'Failed to parse': 'Échec de l’analyse',
            'Added': 'Ajouté',
            'to': 'à',
            'Removed': 'Supprimé',
            'from': 'de'
        },
        'de': {
            'not found': 'nicht gefunden',
            'Failed to parse': 'Fehler beim Parsen',
            'Added': 'Hinzugefügt',
            'to': 'zu',
            'Removed': 'Entfernt',
            'from': 'von'
        },
        'es': {
            'not found': 'no encontrado',
            'Failed to parse': 'No se pudo analizar',
            'Added': 'Añadido',
            'to': 'a',
            'Removed': 'Eliminado',
            'from': 'de'
        },
        'it': {
            'not found': 'non trovato',
            'Failed to parse': 'Analisi non riuscita',
            'Added': 'Aggiunto',
            'to': 'a',
            'Removed': 'Rimosso',
            'from': 'da'
        },
        'ja': {
            'not found': '見つかりません',
            'Failed to parse': '解析に失敗しました',
            'Added': '追加されました',
            'to': 'に',
            'Removed': '削除されました',
            'from': 'から'
        },
        'ko': {
            'not found': '찾을 수 없음',
            'Failed to parse': '구문 분석 실패',
            'Added': '추가됨',
            'to': '에',
            'Removed': '제거됨',
            'from': '에서'
        },
        'pt-br': {
            'not found': 'não encontrado',
            'Failed to parse': 'Falha ao analisar',
            'Added': 'Adicionado',
            'to': 'a',
            'Removed': 'Removido',
            'from': 'de'
        },
        'tr': {
            'not found': 'bulunamadı',
            'Failed to parse': 'Ayrıştırma başarısız',
            'Added': 'Eklendi',
            'to': 'için',
            'Removed': 'Kaldırıldı',
            'from': 'dan'
        },
        'pl': {
            'not found': 'nie znaleziono',
            'Failed to parse': 'Nie udało się przeanalizować',
            'Added': 'Dodano',
            'to': 'do',
            'Removed': 'Usunięto',
            'from': 'z'
        },
        'nl': {
            'not found': 'niet gevonden',
            'Failed to parse': 'Kon niet ontleden',
            'Added': 'Toegevoegd',
            'to': 'aan',
            'Removed': 'Verwijderd',
            'from': 'van'
        },
        'sv': {
            'not found': 'hittades inte',
            'Failed to parse': 'Kunde inte tolkas',
            'Added': 'Lades till',
            'to': 'till',
            'Removed': 'Borttagen',
            'from': 'från'
        },
        'fi': {
            'not found': 'ei löytynyt',
            'Failed to parse': 'Jäsennys epäonnistui',
            'Added': 'Lisätty',
            'to': 'kohteeseen',
            'Removed': 'Poistettu',
            'from': 'kohteesta'
        }
    };

    const localizedMessages = messages[language] || messages['en'];
    return message.split(' ').map(word => localizedMessages[word] || word).join(' ');
}