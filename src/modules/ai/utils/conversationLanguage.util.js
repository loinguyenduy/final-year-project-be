import { AI_CONVERSATION_LANGUAGES } from '../constants/ai.constants.js';

const VIETNAMESE_DIACRITIC_PATTERN = /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/iu;
const WORD_PATTERN = /\p{L}+/gu;

const VIETNAMESE_WORDS = new Set([
  'ban', 'bạn', 'bi', 'bị', 'can', 'cần', 'chao', 'chào', 'co', 'có', 'cua', 'của',
  'da', 'đã', 'dang', 'đang', 'dieu', 'điều', 'dien', 'điện', 'duoc', 'được',
  'gia', 'giup', 'giúp', 'hoa', 'hòa', 'hong', 'hỏng', 'khong', 'không', 'lanh',
  'lạnh', 'loi', 'lỗi', 'may', 'máy', 'mat', 'mát', 'mui', 'mùi', 'nha', 'nhà',
  'nhe', 'nhẹ', 'nó', 'nong', 'nóng', 'nuoc', 'nước', 'ồn', 'sua',
  'sửa', 'thay', 'thấy', 'thiet', 'thiết', 'toi', 'tôi', 'trong', 'va', 'và',
  'van', 'vẫn'
]);

const ENGLISH_WORDS = new Set([
  'a', 'air', 'an', 'and', 'appliance', 'are', 'bathroom', 'broken', 'can',
  'ceiling', 'clogged', 'conditioner', 'cooling', 'could', 'does', 'door',
  'drain', 'electrical', 'fan', 'five', 'fix', 'for', 'freezer', 'fridge', 'from',
  'has', 'have', 'heating', 'hello', 'help', 'hey', 'hi', 'hot', 'house', 'i',
  'is', 'issue', 'it', 'kitchen', 'leak', 'leaking', 'light', 'machine', 'may',
  'me', 'my', 'need', 'no', 'noise', 'not', 'on', 'outlet', 'oven', 'pipe',
  'please', 'power', 'problem', 'refrigerator', 'repair', 'sink', 'socket',
  'stopped', 'the', 'there', 'this', 'to', 'today', 'toilet', 'washer', 'washing',
  'water', 'with', 'work', 'working', 'would', 'years', 'yesterday', 'you'
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
  if (englishScore === 1 && vietnameseScore === 0) return 'EN';
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
