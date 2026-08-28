// api/video-sources.js
// Combines scraping hash from embed page and fetching XHR video sources.
// Usage: /api/video-sources?id=VIDEO_ID
// Returns JSON: the full response from eporner XHR endpoint (sources, etc.)

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

// XHR endpoint parameters (same as observed in browser)
const XHR_PARAMS = {
    domain: 'www.eporner.com',
    pixelRatio: '3',
    playerWidth: '0',
    playerHeight: '0',
    fallback: 'true',
    embed: 'false',
    supportedFormats: 'hls,dash,vp9,mp4',
    _: Date.now().toString(), // cache buster
};

module.exports = async (req, res) => {
    // CORS preflight
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

    // Helper to fetch URL and return text (or buffer)
    function fetchText(url) {
        return new Promise((resolve, reject) => {
            const transport = url.startsWith('https') ? https : http;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': 'https://www.eporner.com/',
                },
                timeout: 20000,
            };
            const req = transport.get(url, options, (res) => {
                const chunks = [];
                res.on('data', chunk => chunks.push(chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 400) {
                        resolve(Buffer.concat(chunks).toString('utf8'));
                    } else {
                        reject(new Error(`HTTP ${res.statusCode}`));
                    }
                });
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Request timeout')));
            req.on('error', reject);
        });
    }

    try {
        // 1. Fetch embed page to get hash
        const embedUrl = `https://www.eporner.com/embed/${videoId}`;
        const embedHtml = await fetchText(embedUrl);

        // Extract hash using patterns for EP.video.player.hash
        const hashPatterns = [
            /EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{16,})['"]/i,
            /["']hash["']\s*[:=]\s*['"]([a-f0-9]{16,})['"]/i,
            /hash\s*=\s*['"]([a-f0-9]{16,})['"]/i,
            /hash\s*:\s*['"]([a-f0-9]{16,})['"]/i,
        ];

        let hash = null;
        for (const regex of hashPatterns) {
            const match = embedHtml.match(regex);
            if (match && match[1]) {
                hash = match[1];
                break;
            }
        }

        if (!hash) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Hash not found in embed page' }));
            return;
        }

        // 2. Build XHR URL with hash and parameters
        const xhrUrl = new URL(`https://www.eporner.com/xhr/video/${videoId}`);
        xhrUrl.searchParams.set('hash', hash);
        // Add all other params
        for (const [key, value] of Object.entries(XHR_PARAMS)) {
            xhrUrl.searchParams.set(key, value);
        }

        // 3. Fetch XHR data
        const xhrData = await fetchText(xhrUrl.toString());

        // Parse JSON and return
        let jsonData;
        try {
            jsonData = JSON.parse(xhrData);
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
