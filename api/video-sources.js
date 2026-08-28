// api/video-sources.js
// Scrapes the main video page to get the correct hash, then fetches XHR.
// Uses embed=false and proper cookie handling.
// Usage: /api/video-sources?id=VIDEO_ID

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

// XHR parameters – embed is false (main site context)
const XHR_PARAMS = {
    domain: 'www.eporner.com',
    pixelRatio: '3',
    playerWidth: '0',
    playerHeight: '0',
    fallback: 'true',
    embed: 'false',               // changed back to false
    supportedFormats: 'hls,dash,vp9,mp4',
    _: Date.now().toString(),
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

    // Helper to fetch a URL and return body, cookies (as name=value pairs)
    function fetchUrl(url, cookieHeader = '', extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const transport = url.startsWith('https') ? https : http;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
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
                        const cookiePairs = setCookies.map(cookie => cookie.split(';')[0].trim()).filter(p => p.includes('='));
                        resolve({ body, cookies: cookiePairs });
                    } else {
                        reject(new Error(`HTTP ${response.statusCode}`));
                    }
                });
                response.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Request timeout')));
            req.on('error', reject);
        });
    }

    try {
        // 1. Try to fetch main video page: https://www.eporner.com/video-{id}/
        let mainPageUrl = `https://www.eporner.com/video-${videoId}/`;
        let mainResponse;
        try {
            mainResponse = await fetchUrl(mainPageUrl);
        } catch (err) {
            // Fallback: fetch embed page to get canonical URL from EP.video.player.url
            const embedUrl = `https://www.eporner.com/embed/${videoId}`;
            const embedResponse = await fetchUrl(embedUrl);
            const urlMatch = embedResponse.body.match(/EP\.video\.player\.url\s*=\s*['"]([^'"]+)['"]/i);
            if (urlMatch && urlMatch[1]) {
                mainPageUrl = urlMatch[1];
                mainResponse = await fetchUrl(mainPageUrl);
            } else {
                throw new Error('Could not find main video page URL');
            }
        }

        // Extract hash from main page HTML
        const hashPatterns = [
            /EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{16,})['"]/i,
            /["']hash["']\s*[:=]\s*['"]([a-f0-9]{16,})['"]/i,
            /hash\s*=\s*['"]([a-f0-9]{16,})['"]/i,
            /hash\s*:\s*['"]([a-f0-9]{16,})['"]/i,
        ];

        let hash = null;
        for (const regex of hashPatterns) {
            const match = mainResponse.body.match(regex);
            if (match && match[1]) {
                hash = match[1];
                break;
            }
        }

        if (!hash) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Hash not found in main page' }));
            return;
        }

        // 2. Build XHR URL with hash
        const xhrUrl = new URL(`https://www.eporner.com/xhr/video/${videoId}`);
        xhrUrl.searchParams.set('hash', hash);
        for (const [key, value] of Object.entries(XHR_PARAMS)) {
            xhrUrl.searchParams.set(key, value);
        }

        // 3. Prepare cookie header from main page cookies
        const cookieHeader = mainResponse.cookies.join('; ');

        // 4. Fetch XHR with cookies and browser-like headers
        const xhrResponse = await fetchUrl(xhrUrl.toString(), cookieHeader, {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': mainPageUrl,
            'Origin': 'https://www.eporner.com',
        });

        // 5. Parse JSON
        let jsonData;
        try {
            jsonData = JSON.parse(xhrResponse.body);
        } catch (e) {
            res.statusCode = 502;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid JSON from XHR endpoint' }));
            return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(jsonData));
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    }
};
