// api/scrape-hash.js
// Serverless function to scrape video page and extract hash.
// Usage: /api/scrape-hash?id=VIDEO_ID

const https = require('https');
const http = require('http');
const { URL } = require('url');

// CORS headers
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

    const videoId = req.query?.id || req.url?.split('?id=')[1];
    if (!videoId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing "id" query parameter' }));
        return;
    }

    const pageUrl = `https://www.eporner.com/video/${videoId}`;

    // Function to fetch the page
    function fetchPage(url) {
        return new Promise((resolve, reject) => {
            const transport = url.startsWith('https') ? https : http;
            const options = {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.5',
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
        const html = await fetchPage(pageUrl);

        // Regex patterns to extract hash
        const patterns = [
            /["']hash["']\s*[:=]\s*["']([a-f0-9]{16,})["']/i,
            /["']hash["']\s*[:=]\s*["']([^"']+)["']/i,
            /hash\s*=\s*["']([a-f0-9]{16,})["']/i,
            /hash\s*:\s*["']([a-f0-9]{16,})["']/i,
            /hash["']?\s*[:=]\s*["']([a-f0-9]{16,})["']/i,
            /hash["']?\s*[:=]\s*([a-f0-9]{16,})/i,
            /["']hash["']?\s*[:=]\s*["']([^"']{8,})["']/i,
        ];

        let hash = null;
        for (const regex of patterns) {
            const match = html.match(regex);
            if (match && match[1]) {
                hash = match[1];
                break;
            }
        }

        if (hash) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ hash }));
        } else {
            // Optionally, return a snippet of HTML for debugging?
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Hash not found in page', sample: html.substring(0, 200) }));
        }
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    }
};
