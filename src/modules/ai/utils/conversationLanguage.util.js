import { AI_CONVERSATION_LANGUAGES } from '../constants/ai.constants.js';

const VIETNAMESE_DIACRITIC_PATTERN = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu;
const WORD_PATTERN = /\p{L}+/gu;

const VIETNAMESE_WORDS = new Set([
  'bị', 'có', 'của', 'đã', 'đang', 'điều', 'điện', 'gia', 'giúp', 'hòa',
  'không', 'lạnh', 'máy', 'mát', 'mùi', 'nhà', 'nhẹ', 'nóng', 'nước', 'ồn',
  'sửa', 'thấy', 'thiết', 'tôi', 'trong', 'và', 'vẫn'
]);

const ENGLISH_WORDS = new Set([
  'air', 'and', 'appliance', 'conditioner', 'cooling', 'does', 'five', 'for',
  'from', 'has', 'house', 'is', 'it', 'light', 'my', 'noise', 'not', 'problem',
  'repair', 'the', 'there', 'this', 'water', 'with', 'work', 'years'
]);

const normalizeLanguage = (value) => (
  AI_CONVERSATION_LANGUAGES.includes(value) ? value : null
);

const normalizedWords = (text) => (
  String(text || '')
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN')
    .match(WORD_PATTERN)
  || []
);

const detectExplicitLanguageSwitch = (message) => {
  const normalized = String(message || '')
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;

  const englishRequests = [
    /\b(?:please\s+)?(?:continue|reply|respond|speak|switch)\b.{0,35}\benglish\b/u,
    /\b(?:use|in)\s+english\b/u,
    /(?:hãy|vui lòng|xin)\s+.{0,35}(?:tiếng anh|bằng tiếng anh)/u,
    /(?:chuyển|đổi|trả lời|tiếp tục)\s+.{0,25}(?:tiếng anh|bằng tiếng anh)/u
  ];
  if (englishRequests.some((pattern) => pattern.test(normalized))) return 'EN';

  const vietnameseRequests = [
    /\b(?:please\s+)?(?:continue|reply|respond|speak|switch)\b.{0,35}\bvietnamese\b/u,
    /\b(?:use|in)\s+vietnamese\b/u,
    /(?:hãy|vui lòng|xin)\s+.{0,35}(?:tiếng việt|bằng tiếng việt)/u,
    /(?:chuyển|đổi|trả lời|tiếp tục)\s+.{0,25}(?:tiếng việt|bằng tiếng việt)/u
  ];
  if (vietnameseRequests.some((pattern) => pattern.test(normalized))) return 'VI';
  return null;
};

const detectConversationLanguage = (message) => {
  const normalized = String(message || '').normalize('NFC').trim();
  const words = normalizedWords(normalized);
  if (!normalized || words.length === 0) return null;
  if (VIETNAMESE_DIACRITIC_PATTERN.test(normalized) && words.length >= 2) return 'VI';

  const vietnameseScore = words.reduce(
    (score, word) => score + (VIETNAMESE_WORDS.has(word) ? 1 : 0),
    0
  );
  const englishScore = words.reduce(
    (score, word) => score + (ENGLISH_WORDS.has(word) ? 1 : 0),
    0
  );
  if (vietnameseScore >= 2 && vietnameseScore >= englishScore) return 'VI';
  if (englishScore >= 2 && englishScore > vietnameseScore) return 'EN';
  return null;
};

const resolveConversationLanguage = (currentLanguage, message) => {
  const explicitSwitch = detectExplicitLanguageSwitch(message);
  if (explicitSwitch) return explicitSwitch;
  const lockedLanguage = normalizeLanguage(currentLanguage);
  if (lockedLanguage) return lockedLanguage;
  return detectConversationLanguage(message) || 'VI';
};

export {
  detectConversationLanguage,
  detectExplicitLanguageSwitch,
  resolveConversationLanguage
};
