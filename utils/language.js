// Country code to flag/language mapping
const countryCodeMap = {
    multi: { language: 'Multi', flag: '🌐' },
    al: { language: 'Albanian', flag: '🇦🇱' },
    ar: { language: 'Arabic', flag: '🇸🇦' },
    bg: { language: 'Bulgarian', flag: '🇧🇬' },
    bl: { language: 'Bengali', flag: '🇮🇳' },
    cs: { language: 'Czech', flag: '🇨🇿' },
    de: { language: 'German', flag: '🇩🇪' },
    el: { language: 'Greek', flag: '🇬🇷' },
    en: { language: 'English', flag: '🇺🇸' },
    es: { language: 'Castilian Spanish', flag: '🇪🇸' },
    et: { language: 'Estonian', flag: '🇪🇪' },
    fa: { language: 'Persian', flag: '🇮🇷' },
    fr: { language: 'French', flag: '🇫🇷' },
    gu: { language: 'Gujarati', flag: '🇮🇳' },
    he: { language: 'Hebrew', flag: '🇮🇱' },
    hi: { language: 'Hindi', flag: '🇮🇳' },
    hr: { language: 'Croatian', flag: '🇭🇷' },
    hu: { language: 'Hungarian', flag: '🇭🇺' },
    id: { language: 'Indonesian', flag: '🇮🇩' },
    it: { language: 'Italian', flag: '🇮🇹' },
    ja: { language: 'Japanese', flag: '🇯🇵' },
    kn: { language: 'Kannada', flag: '🇮🇳' },
    ko: { language: 'Korean', flag: '🇰🇷' },
    lt: { language: 'Lithuanian', flag: '🇱🇹' },
    lv: { language: 'Latvian', flag: '🇱🇻' },
    ml: { language: 'Malayalam', flag: '🇮🇳' },
    mr: { language: 'Marathi', flag: '🇮🇳' },
    mx: { language: 'Latin American Spanish', flag: '🇲🇽' },
    nl: { language: 'Dutch', flag: '🇳🇱' },
    no: { language: 'Norwegian', flag: '🇳🇴' },
    pa: { language: 'Punjabi', flag: '🇮🇳' },
    pl: { language: 'Polish', flag: '🇵🇱' },
    pt: { language: 'Portuguese', flag: '🇧🇷' },
    ro: { language: 'Romanian', flag: '🇷🇴' },
    ru: { language: 'Russian', flag: '🇷🇺' },
    sk: { language: 'Slovak', flag: '🇸🇰' },
    sl: { language: 'Slovenian', flag: '🇸🇮' },
    sr: { language: 'Serbian', flag: '🇷🇸' },
    ta: { language: 'Tamil', flag: '🇮🇳' },
    te: { language: 'Telugu', flag: '🇮🇳' },
    th: { language: 'Thai', flag: '🇹🇭' },
    tr: { language: 'Turkish', flag: '🇹🇷' },
    uk: { language: 'Ukrainian', flag: '🇺🇦' },
    vi: { language: 'Vietnamese', flag: '🇻🇳' },
    zh: { language: 'Chinese', flag: '🇨🇳' }
};

// Find country codes in HTML text
function findCountryCodes(value) {
    const countryCodes = [];

    for (const countryCode in countryCodeMap) {
        const language = countryCodeMap[countryCode].language;
        if (!countryCodes.includes(countryCode) && value.includes(language)) {
            countryCodes.push(countryCode);
        }
    }

    return countryCodes;
}

// Get flags from country codes
function getFlags(countryCodes) {
    return countryCodes.map(code => countryCodeMap[code]?.flag || '').join('');
}

module.exports = { findCountryCodes, getFlags };
