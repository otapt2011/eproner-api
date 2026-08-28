// api/debug-page.js
// Fetches canonical video page and returns a snippet of HTML for debugging.
// Usage: /api/debug-page?id=VIDEO_ID

const https = require('https');
const http = require('http');

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
        res.end(JSON.stringify({ error: 'Missing id' }));
        return;
    }

    const embedUrl = `https://www.eporner.com/embed/${videoId}`;
    const embedHtml = await fetchPage(embedUrl);
    const urlMatch = embedHtml.match(/EP\.video\.player\.url\s*=\s*['"]([^'"]+)['"]/i);
    const canonicalUrl = urlMatch ? urlMatch[1] : `https://www.eporner.com/video-${videoId}/`;

    const html = await fetchPage(canonicalUrl);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        canonicalUrl,
        htmlSnippet: html.substring(0, 5000),
        length: html.length
    }));

    function fetchPage(url) {
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
            req.on('timeout', () => req.destroy(new Error('Timeout')));
            req.on('error', reject);
        });
    }
};
