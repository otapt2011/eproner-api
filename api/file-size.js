// api/file-size.js
// Dedicated file-size proxy for Vercel – returns JSON { size: bytes } or { error: string }
// Usage: /api/file-size?url=<encoded-url>

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Timeout for upstream request (ms)
const REQUEST_TIMEOUT = 20000;

// Maximum size to attempt full download fallback (if HEAD/Range fail) – set to 0 to disable
const MAX_FULL_DOWNLOAD_SIZE = 0; // 0 = disabled; otherwise maximum bytes to fetch (e.g., 50 * 1024 * 1024)

// CORS headers
const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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

    // Parse target URL from query
    const targetUrl = req.query?.url || req.url?.split('?url=')[1];
    if (!targetUrl) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
        return;
    }

    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(targetUrl);
    } catch (e) {
        decodedUrl = targetUrl;
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(decodedUrl);
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
            throw new Error('Only http and https protocols are allowed');
        }
    } catch (err) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Invalid URL: ${err.message}` }));
        return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;

    // Helper to make a request and return (response, headers, bodyBuffer)
    function makeRequest(method, extraHeaders = {}) {
        return new Promise((resolve, reject) => {
            const options = {
                method,
                headers: {
                    'Accept-Encoding': 'identity', // avoid compressed content
                    'User-Agent': 'Mozilla/5.0 (compatible; FileSizeProxy/1.0)',
                    ...extraHeaders,
                },
                timeout: REQUEST_TIMEOUT,
            };

            const req = transport.request(parsedUrl, options, (upstreamRes) => {
                const chunks = [];
                let totalSize = 0;
                let exceeded = false;

                upstreamRes.on('data', (chunk) => {
                    if (exceeded) return;
                    totalSize += chunk.length;
                    if (totalSize > (MAX_FULL_DOWNLOAD_SIZE || Infinity)) {
                        exceeded = true;
                        req.destroy();
                        resolve({ statusCode: upstreamRes.statusCode, headers: upstreamRes.headers, truncated: true });
                        return;
                    }
                    chunks.push(chunk);
                });

                upstreamRes.on('end', () => {
                    if (exceeded) return;
                    resolve({
                        statusCode: upstreamRes.statusCode,
                        headers: upstreamRes.headers,
                        body: Buffer.concat(chunks),
                        truncated: false,
                    });
                });

                upstreamRes.on('error', (err) => {
                    reject(err);
                });
            });

            req.on('timeout', () => {
                req.destroy(new Error('Request timed out'));
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.end();
        });
    }

    try {
        // 1. Try HEAD
        let response = await makeRequest('HEAD');
        if (response.statusCode >= 200 && response.statusCode < 400) {
            const contentLength = response.headers['content-length'];
            if (contentLength && !isNaN(contentLength)) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ size: parseInt(contentLength, 10) }));
                return;
            }
        }

        // 2. Try GET with Range: bytes=0-0
        response = await makeRequest('GET', { 'Range': 'bytes=0-0' });
        if (response.statusCode === 206) {
            const contentRange = response.headers['content-range'];
            if (contentRange) {
                const total = contentRange.split('/')[1];
                if (total && total !== '*' && !isNaN(total)) {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ size: parseInt(total, 10) }));
                    return;
                }
            }
        }

        // 3. Optional: full GET to get Content-Length (if not truncated)
        if (MAX_FULL_DOWNLOAD_SIZE > 0) {
            response = await makeRequest('GET');
            if (response.statusCode >= 200 && response.statusCode < 400 && !response.truncated) {
                const contentLength = response.headers['content-length'];
                if (contentLength && !isNaN(contentLength)) {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ size: parseInt(contentLength, 10) }));
                    return;
                }
            }
        }

        // If we get here, size could not be determined
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Could not determine file size' }));
        return;

    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    }
};
