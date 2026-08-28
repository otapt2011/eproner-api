// api/video-info.js
// Fetches canonical video page and extracts EP.video.player data + JSON-LD metadata.
// Usage: /api/video-info?id=VIDEO_ID

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

module.exports = async (req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    res.setHeader('Access-Control-Allow-Origin', '*');

    const videoId = req.query?.id || req.url?.split('?id=')[1];
    if (!videoId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing "id" query parameter' }));
        return;
    }

    // Helper to fetch URL and return body, cookies
    function fetchUrl(url, cookieHeader = '', extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const transport = url.startsWith('https') ? https : http;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
                    'Referer': 'https://www.eporner.com/',
                    ...extraHeaders,
                },
                timeout: 20000,
            };
            if (cookieHeader) {
                options.headers['Cookie'] = cookieHeader;
            }
            const req = transport.get(url, options, (response) => {
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    if (response.statusCode >= 200 && response.statusCode < 400) {
                        const body = Buffer.concat(chunks).toString('utf8');
                        const setCookies = response.headers['set-cookie'] || [];
                        const cookiePairs = setCookies.map(c => c.split(';')[0].trim()).filter(p => p.includes('='));
                        resolve({ body, cookies: cookiePairs });
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}`));
                    }
                });
                response.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Timeout')));
            req.on('error', reject);
        });
    }

    // Extract JSON-LD objects
    function extractJsonLd(html) {
        const jsonLd = [];
        const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = regex.exec(html)) !== null) {
            try {
                const data = JSON.parse(match[1]);
                jsonLd.push(data);
            } catch (e) {
                // ignore parse errors
            }
        }
        return jsonLd;
    }

    // Extract a value from EP.video.player assignments using regex
    function extractPlayerVar(html, varName) {
        const patterns = [
            new RegExp(`EP\\.video\\.player\\.${varName}\\s*=\\s*['"]([^'"]+)['"]`, 'i'),
            new RegExp(`["']${varName}["']\\s*[:=]\\s*['"]([^'"]+)['"]`, 'i'),
            new RegExp(`${varName}\\s*=\\s*['"]([^'"]+)['"]`, 'i'),
        ];
        for (const regex of patterns) {
            const match = html.match(regex);
            if (match && match[1]) return match[1];
        }
        return null;
    }

    try {
        // 1. Fetch embed page to get canonical URL
        const embedUrl = `https://www.eporner.com/embed/${videoId}`;
        const embedResponse = await fetchUrl(embedUrl);

        const canonicalUrl = extractPlayerVar(embedResponse.body, 'url');
        if (!canonicalUrl) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Canonical URL not found in embed page' }));
            return;
        }

        // 2. Fetch canonical video page
        const videoPageResponse = await fetchUrl(canonicalUrl);

        // Extract player variables
        const hash = extractPlayerVar(videoPageResponse.body, 'hash');
        const vid = extractPlayerVar(videoPageResponse.body, 'vid');
        const poster = extractPlayerVar(videoPageResponse.body, 'poster');
        const embed = extractPlayerVar(videoPageResponse.body, 'embed');
        const VR = extractPlayerVar(videoPageResponse.body, 'VR');

        // Extract JSON-LD
        const jsonLd = extractJsonLd(videoPageResponse.body);

        // Optionally, extract simple title and description from meta tags
        function extractMeta(html, name) {
            const regex = new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i');
            const match = html.match(regex);
            return match ? match[1] : null;
        }

        const title = extractMeta(videoPageResponse.body, 'og:title') || extractMeta(videoPageResponse.body, 'twitter:title');
        const description = extractMeta(videoPageResponse.body, 'og:description') || extractMeta(videoPageResponse.body, 'description');
        const thumbnail = extractMeta(videoPageResponse.body, 'og:image');

        // Build result object
        const result = {
            videoId,
            canonicalUrl,
            hash,
            vid,
            poster,
            embed,
            VR,
            title,
            description,
            thumbnail,
            jsonLd,
        };

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    }
};
