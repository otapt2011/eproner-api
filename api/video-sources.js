// api/video-sources-v2.js
// Fetches embed page to get hash and cookies, then calls XHR with embed=false.
// Usage: /api/video-sources-v2?id=VIDEO_ID

const https = require('https');
const http = require('http');
const { URL } = require('url');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

const XHR_PARAMS = {
    domain: 'www.eporner.com',
    pixelRatio: '3',
    playerWidth: '0',
    playerHeight: '0',
    fallback: 'true',
    embed: 'false',               // changed to false
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

    // Helper to fetch URL and return body, cookies (as name=value pairs)
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

    try {
        // 1. Fetch embed page
        const embedUrl = `https://www.eporner.com/embed/${videoId}`;
        const embedResponse = await fetchUrl(embedUrl);

        // Extract hash from embed page
        const hashMatch = embedResponse.body.match(/EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{16,})['"]/i);
        if (!hashMatch || !hashMatch[1]) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Hash not found in embed page' }));
            return;
        }
        const hash = hashMatch[1];

        // 2. Build XHR URL
        const xhrUrl = new URL(`https://www.eporner.com/xhr/video/${videoId}`);
        xhrUrl.searchParams.set('hash', hash);
        for (const [key, value] of Object.entries(XHR_PARAMS)) {
            xhrUrl.searchParams.set(key, value);
        }

        // 3. Use cookies from embed page
        const cookieHeader = embedResponse.cookies.join('; ');

        // 4. Fetch XHR with embed=false and cookies
        const xhrResponse = await fetchUrl(xhrUrl.toString(), cookieHeader, {
            'Accept': 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': embedUrl,
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
