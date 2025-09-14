const CryptoJS = require('crypto-js');


const BASE_URL = 'https://api.inmoviebox.com/wefeed-mobile-bff';

function md5Hex(data) {
    return CryptoJS.MD5(data).toString(CryptoJS.enc.Hex);
}

function signRequest(keyB64, url, method = 'GET', body = '') {
    const timestamp = Date.now();

    const u = new URL(url);
    const path = u.pathname || '';
    const params = [];
    u.searchParams.forEach((value, key) => {
        params.push([decodeURIComponent(key), decodeURIComponent(value)]);
    });
    params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const qs = params.map(([k, v]) => `${k}=${v}`).join('&');
    const canonicalUrl = qs ? `${path}?${qs}` : path;

    let bodyHash = '';
    let bodyLength = '';
    if (body) {
        const bodyUtf8 = CryptoJS.enc.Utf8.parse(body);
        bodyLength = String(bodyUtf8.sigBytes);
        // The original script slices the body to 100KB before hashing.
        // For simplicity, we hash the whole body, assuming it won't exceed the limit for typical requests.
        bodyHash = md5Hex(bodyUtf8);
    }

    const canonical = [
        method.toUpperCase(),
        'application/json',
        'application/json; charset=utf-8',
        bodyLength,
        String(timestamp),
        bodyHash,
        canonicalUrl,
    ].join('\n');

    const key = CryptoJS.enc.Base64.parse(keyB64);
    const sig = CryptoJS.HmacMD5(canonical, key).toString(CryptoJS.enc.Base64);

    const xTrSignature = `${timestamp}|2|${sig}`;
    const rev = String(timestamp).split('').reverse().join('');
    const xClientToken = `${timestamp},${md5Hex(rev)}`;

    return { xTrSignature, xClientToken };
}


function makeApiRequest(url, method = 'GET', body = '') {
    const { xTrSignature, xClientToken } = signRequest(PRIMARY_KEY, url, method, body);
    const headers = {
        'User-Agent': 'com.community.mbox.in/50020042 (Linux; Android 16; sdk_gphone64_x86_64; Cronet/133.0.6876.3)',
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'x-client-info': JSON.stringify({ package_name: 'com.community.mbox.in' }),
        'x-client-token': xClientToken,
        'x-tr-signature': xTrSignature,
        'x-client-status': '0',
    };

    const options = {
        method: method.toUpperCase(),
        headers: headers,
    };

    if (method.toUpperCase() === 'POST' && body) {
        options.body = body;
    }

    return fetch(url, options).then(function(res) {
        if (!res.ok) {
            console.error(`[MovieBox] API request failed: ${res.status}`);
        }
        return res.json();
    });
}

function search(keyword) {
    const url = `${BASE_URL}/subject-api/search/v2`;
    const body = JSON.stringify({ page: 1, perPage: 10, keyword });
    return makeApiRequest(url, 'POST', body)
        .then(function(res) {
            const results = res.data?.results || [];
            const subjects = [];
            for (const result of results) {
                subjects.push(...(result.subjects || []));
            }
            return subjects;
        });
}

function getPlayInfo(subjectId, season, episode) {
    let url;
    if (season && episode) {
        url = `${BASE_URL}/subject-api/play-info?subjectId=${subjectId}&se=${season}&ep=${episode}`;
    } else {
        url = `${BASE_URL}/subject-api/play-info?subjectId=${subjectId}`;
    }

    return makeApiRequest(url).then(function(res) {
        const data = res?.data || {};
        let streams = data.streams || [];
        if (!streams || streams.length === 0) {
            streams = data.playInfo?.streams || [];
        }
        for (const s of streams) {
            s.audioTracks = Array.isArray(s.audioTracks) ? s.audioTracks : [];
            if (Array.isArray(s.resolutions)) {
                // keep as-is
            } else if (typeof s.resolutions === 'string') {
                s.resolutions = s.resolutions.split(',').map(function(v) {
                    return v.trim();
                }).filter(Boolean);
            } else if (s.resolution) {
                s.resolutions = Array.isArray(s.resolution) ? s.resolution : [s.resolution];
            } else {
                s.resolutions = [];
            }
        }
        return streams;
    });
}


function extractQualityFields(stream) {
    const qualities = [];
    const candidates = [
        stream.quality,
        stream.definition,
        stream.label,
        stream.videoQuality,
        stream.profile,
    ].filter(Boolean);
    qualities.push(...candidates.map(String));
    if (Array.isArray(stream.resolutions) && stream.resolutions.length) {
        qualities.push(...stream.resolutions.map(v => String(v)));
    }
    const width = stream.width || (stream.video && stream.video.width);
    const height = stream.height || (stream.video && stream.video.height);
    if (width && height) {
        qualities.push(`${width}x${height}`);
    }
    const seen = new Set();
    return qualities.filter(q => {
        if (seen.has(q)) return false;
        seen.add(q);
        return true;
    });
}

function formatQuality(qualityString) {
    if (!qualityString) return 'Unknown';
    
    // If it already contains 'p', return as is
    if (qualityString.includes('p')) {
        return qualityString;
    }
    
    // If it's a number (like "1080", "720"), add 'p'
    const numberMatch = qualityString.match(/^(\d{3,4})$/);
    if (numberMatch) {
        return `${numberMatch[1]}p`;
    }
    
    // If it's a resolution like "1920x1080", extract height and add 'p'
    const resolutionMatch = qualityString.match(/^\d+x(\d{3,4})$/);
    if (resolutionMatch) {
        return `${resolutionMatch[1]}p`;
    }
    
    // Return as is for other formats
    return qualityString;
}


function loadSubject(subjectId) {
    const url = `${BASE_URL}/subject-api/get?subjectId=${subjectId}`;
    return makeApiRequest(url).then(function(res) {
        return res.data || {};
    });
}

function getSeasons(subjectId) {
    const url = `${BASE_URL}/subject-api/season-info?subjectId=${subjectId}`;
    return makeApiRequest(url).then(function(res) {
        return res.data?.seasons || [];
    });
}

function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
    console.log(`[MovieBox] Fetching streams for TMDB ID: ${tmdbId}, Type: ${mediaType}`);
    const tmdbUrl = `https://api.themoviedb.org/3/${mediaType === 'tv' ? 'tv' : 'movie'}/${tmdbId}?api_key=${TMDB_API_KEY}`;

    return fetch(tmdbUrl)
        .then(function(res) {
            if (!res.ok) {
                throw new Error(`TMDB API request failed: ${res.status}`);
            }
            return res.json();
        })
        .then(function(tmdbData) {
            const title = mediaType === 'tv' ? tmdbData.name : tmdbData.title;
            const year = mediaType === 'tv'
                ? (tmdbData.first_air_date || '').substring(0, 4)
                : (tmdbData.release_date || '').substring(0, 4);

            if (!title) {
                throw new Error('Could not extract title from TMDB response');
            }
            console.log(`[MovieBox] Searching for: "${title}" (${year})`);
            return search(title).then(function(results) {
                return { results: results, title: title, year: year, mediaType: mediaType, seasonNum: seasonNum, episodeNum: episodeNum };
            });
        })
        .then(function(data) {
            const { results, title, mediaType, seasonNum, episodeNum } = data;

            if (!results || results.length === 0) {
                console.log('[MovieBox] No search results found');
                return [];
            }

            // Enhanced filtering with confidence levels
            const filteredResults = results.map(function(result) {
                const matchInfo = isRelevantMatch(title, result.title);
                return {
                    ...result,
                    matchConfidence: matchInfo.confidence,
                    matchScore: matchInfo.score,
                    isRelevant: matchInfo.isRelevant
                };
            });

            const relevantResults = filteredResults.filter(function(result) {
                return result.isRelevant;
            });

            console.log(`[MovieBox] Found ${relevantResults.length} relevant results out of ${results.length} total`);

            // Log confidence levels for debugging
            const confidenceGroups = {};
            relevantResults.forEach(function(result) {
                const confidence = result.matchConfidence;
                if (!confidenceGroups[confidence]) {
                    confidenceGroups[confidence] = [];
                }
                confidenceGroups[confidence].push(result.title);
            });

            Object.keys(confidenceGroups).forEach(function(confidence) {
                console.log(`[MovieBox] ${confidence} confidence: ${confidenceGroups[confidence].length} results`);
            });

            if (relevantResults.length === 0) {
                console.log('[MovieBox] No relevant results found after enhanced filtering');
                return [];
            }

            // Sort by confidence and score for better processing order
            relevantResults.sort(function(a, b) {
                const confidenceOrder = { 'high': 3, 'medium': 2, 'low': 1 };
                const aConfidence = confidenceOrder[a.matchConfidence] || 0;
                const bConfidence = confidenceOrder[b.matchConfidence] || 0;

                if (aConfidence !== bConfidence) {
                    return bConfidence - aConfidence; // Higher confidence first
                }
                return b.matchScore - a.matchScore; // Higher score first
            });

            // Process all relevant results (different languages/versions)
            const promises = relevantResults.map(function(result, index) {
                console.log(`[MovieBox] Processing result ${index + 1}/${relevantResults.length}: ${result.title} (${result.matchConfidence} confidence, score: ${result.matchScore.toFixed(3)})`);

                if (mediaType === 'tv') {
                    if (!seasonNum || !episodeNum) {
                        console.error('[MovieBox] TV show requires season and episode number.');
                        return [];
                    }
                    return getPlayInfo(result.subjectId, seasonNum, episodeNum)
                        .then(function(streams) {
                            return { subject: result, streams: streams };
                        })
                        .catch(function(error) {
                            console.error(`[MovieBox] Error processing TV result ${result.title}: ${error.message}`);
                            return { subject: result, streams: [] };
                        });
                } else {
                    return getPlayInfo(result.subjectId)
                        .then(function(streams) {
                            return { subject: result, streams: streams };
                        })
                        .catch(function(error) {
                            console.error(`[MovieBox] Error processing movie result ${result.title}: ${error.message}`);
                            return { subject: result, streams: [] };
                        });
                }
            });

            return Promise.all(promises);
        })
        .then(function(subjectsWithStreams) {
            if (!subjectsWithStreams || subjectsWithStreams.length === 0) {
                console.log('[MovieBox] No streams found for any results.');
                return [];
            }

            const allStreams = [];

            // Process each subject and its streams
            subjectsWithStreams.forEach(function(subjectData) {
                const { subject, streams } = subjectData;

                if (!streams || streams.length === 0) {
                    console.log(`[MovieBox] No streams found for subject: ${subject.title}`);
                    return;
                }

                console.log(`[MovieBox] Processing ${streams.length} streams for: ${subject.title}`);

                // Process each stream for this subject
                streams.forEach(function(s) {
                    const qualities = extractQualityFields(s);
                    const rawQuality = qualities.find(function(q) { return q.includes('p') || q.includes('x'); }) || qualities[0] || 'Unknown';
                    const quality = formatQuality(rawQuality);
                    const audioTracks = s.audioTracks || [];

                    // Create descriptive title with subject name, quality, and audio information
                    let streamTitle = `${subject.title} - ${s.format || 'Stream'} - ${quality}`;
                    if (audioTracks.length > 0) {
                        streamTitle += ` (${audioTracks.join(', ')})`;
                    }

                    allStreams.push({
                        name: "MovieBox",
                        title: streamTitle,
                        url: s.url,
                        quality: quality,
                        type: 'direct',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                            'Referer': 'https://api.inmoviebox.com'
                        }
                    });
                });
            });

            // Sort by quality (highest first)
            allStreams.sort(function(a, b) {
                const qualityA = parseQualityForSort(a.quality);
                const qualityB = parseQualityForSort(b.quality);
                return qualityB - qualityA;
            });

            console.log(`[MovieBox] Total streams found across all language variants: ${allStreams.length}`);
            return allStreams;
        })
        .catch(function(error) {
            console.error(`[MovieBox] Error in getStreams: ${error.message}`);
            return []; // Return empty array on error as per Nuvio scraper guidelines
        });
}

// Enhanced title matching for reliable movie/TV show identification
function calculateSimilarity(targetTitle, candidateTitle) {
    // Normalize both titles
    const normalizedTarget = normalizeTitle(targetTitle);
    const normalizedCandidate = normalizeTitle(candidateTitle);

    // Exact match after normalization - highest confidence
    if (normalizedTarget === normalizedCandidate) {
        return 1.0;
    }

    // Calculate multiple similarity metrics
    const wordSimilarity = calculateWordSimilarity(normalizedTarget, normalizedCandidate);
    const substringSimilarity = calculateSubstringSimilarity(normalizedTarget, normalizedCandidate);
    const levenshteinSimilarity = calculateLevenshteinSimilarity(normalizedTarget, normalizedCandidate);

    // Weighted combination of metrics
    const combinedScore = (wordSimilarity * 0.5) + (substringSimilarity * 0.3) + (levenshteinSimilarity * 0.2);

    return combinedScore;
}

function normalizeTitle(title) {
    if (!title) return '';

    return title
        // Convert to lowercase
        .toLowerCase()
        // Remove common punctuation and special characters
        .replace(/[.,!?;:()[\]{}"'-]/g, ' ')
        // Normalize whitespace
        .replace(/\s+/g, ' ')
        .trim()
        // Handle common title prefixes
        .replace(/^(the|a|an)\s+/, '')
        // Remove common movie suffixes
        .replace(/\s+(movie|film|show|series|part|chapter)\s+\d*$/i, '')
        // Remove year patterns
        .replace(/\s+\(\d{4}\)$/, '')
        .trim();
}

function calculateWordSimilarity(str1, str2) {
    const words1 = str1.split(/\s+/).filter(word => word.length > 1);
    const words2 = str2.split(/\s+/).filter(word => word.length > 1);

    if (words1.length === 0 || words2.length === 0) return 0;

    let matches = 0;
    const totalWords = Math.max(words1.length, words2.length);

    for (const word1 of words1) {
        // Check for exact word matches
        if (words2.includes(word1)) {
            matches += 1.0;
            continue;
        }

        // Check for partial matches (one word contains another)
        for (const word2 of words2) {
            if (word1.includes(word2) || word2.includes(word1)) {
                matches += 0.8;
                break;
            }
        }
    }

    return matches / totalWords;
}

function calculateSubstringSimilarity(str1, str2) {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;

    if (longer.length === 0) return 1.0;

    // Check if shorter string is a substring of longer string
    if (longer.includes(shorter)) {
        return shorter.length / longer.length;
    }

    return 0;
}

function calculateLevenshteinSimilarity(str1, str2) {
    const matrix = [];

    for (let i = 0; i <= str2.length; i++) {
        matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
        for (let j = 1; j <= str1.length; j++) {
            if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    const distance = matrix[str2.length][str1.length];
    const maxLength = Math.max(str1.length, str2.length);

    return maxLength === 0 ? 1.0 : (maxLength - distance) / maxLength;
}

// Enhanced filtering with multiple criteria
function isRelevantMatch(targetTitle, candidateTitle, targetYear) {
    const similarityScore = calculateSimilarity(targetTitle, candidateTitle);

    // Very high confidence for exact matches or near-exact matches
    if (similarityScore >= 0.9) {
        return { isRelevant: true, confidence: 'high', score: similarityScore };
    }

    // Medium confidence for good matches
    if (similarityScore >= 0.7) {
        return { isRelevant: true, confidence: 'medium', score: similarityScore };
    }

    // Low confidence but still potentially relevant
    if (similarityScore >= 0.5) {
        // Additional checks for low-confidence matches
        const normalizedTarget = normalizeTitle(targetTitle);
        const normalizedCandidate = normalizeTitle(candidateTitle);

        // Check if both titles share key words
        const keyWords = ['inception', 'avengers', 'batman', 'spider', 'marvel', 'dc'];
        const hasSharedKeywords = keyWords.some(word =>
            normalizedTarget.includes(word) && normalizedCandidate.includes(word)
        );

        if (hasSharedKeywords) {
            return { isRelevant: true, confidence: 'low', score: similarityScore };
        }
    }

    return { isRelevant: false, confidence: 'none', score: similarityScore };
}

function parseQualityForSort(qualityString) {
    if (!qualityString) return 0;
    const match = qualityString.match(/(\d{3,4})p/i);
    return match ? parseInt(match[1], 10) : 0;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        getStreams,
        calculateSimilarity,
        isRelevantMatch,
        normalizeTitle
    };
} else {
    global.getStreams = getStreams;
    global.calculateSimilarity = calculateSimilarity;
    global.isRelevantMatch = isRelevantMatch;
    global.normalizeTitle = normalizeTitle;
}

