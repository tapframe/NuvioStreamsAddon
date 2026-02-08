/**
 * Extract resolution from filename
 * Ported from webstreamr's height.ts
 * Supports: 1080p, 720p, 2160p, 4K, etc.
 */
function extractResolution(filename) {
    if (!filename) return null;

    // Match patterns like: 1080p, 720p, 2160p, 480p
    // Or: 1920x1080, 1280x720, 3840x2160
    // Or: 4K, 2K, 8K
    const matches = filename.match(/(\d+)p|(\d+)x(\d+)|(\d+)K/gi);

    if (!matches || matches.length === 0) return null;

    // Extract all heights found
    const heights = matches.map(match => {
        const pMatch = match.match(/(\d+)p/i);
        if (pMatch) return parseInt(pMatch[1]);

        const xMatch = match.match(/\d+x(\d+)/);
        if (xMatch) return parseInt(xMatch[1]);

        const kMatch = match.match(/(\d+)K/i);
        if (kMatch) {
            const k = parseInt(kMatch[1]);
            // 4K = 2160p, 2K = 1080p, 8K = 4320p
            return k === 4 ? 2160 : k === 2 ? 1080 : k === 8 ? 4320 : null;
        }

        return null;
    }).filter(h => h !== null);

    if (heights.length === 0) return null;

    // Return the maximum height found
    const maxHeight = Math.max(...heights);

    // Convert back to standard format
    if (maxHeight >= 2160) return '4K';
    if (maxHeight >= 1080) return '1080p';
    if (maxHeight >= 720) return '720p';
    if (maxHeight >= 480) return '480p';
    return `${maxHeight}p`;
}

module.exports = { extractResolution };
