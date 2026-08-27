// api/video-duration.js
// Dedicated proxy to get video duration (in seconds) from an MP4 URL
// Usage: /api/video-duration?url=<encoded-url>
// Returns JSON: { duration: 123.45 } or { error: "..." }

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Timeout for upstream request (ms)
const REQUEST_TIMEOUT = 15000;

// How many bytes to fetch from the beginning/end when searching for moov
const CHUNK_SIZE = 512 * 1024; // 512 KB

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

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Parse target URL
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

    // Helper to make a range request and return a buffer
    function fetchRange(start, end) {
        return new Promise((resolve, reject) => {
            const options = {
                method: 'GET',
                headers: {
                    'Range': `bytes=${start}-${end}`,
                    'Accept-Encoding': 'identity',
                    'User-Agent': 'Mozilla/5.0 (compatible; VideoDurationProxy/1.0)',
                },
                timeout: REQUEST_TIMEOUT,
            };

            const req = transport.request(parsedUrl, options, (upstreamRes) => {
                const chunks = [];
                upstreamRes.on('data', (chunk) => chunks.push(chunk));
                upstreamRes.on('end', () => {
                    if (upstreamRes.statusCode !== 206 && upstreamRes.statusCode !== 200) {
                        reject(new Error(`Unexpected status ${upstreamRes.statusCode}`));
                        return;
                    }
                    resolve(Buffer.concat(chunks));
                });
                upstreamRes.on('error', reject);
            });

            req.on('timeout', () => req.destroy(new Error('Request timed out')));
            req.on('error', reject);
            req.end();
        });
    }

    // Helper to fetch file size via HEAD (or Range)
    async function getFileSize() {
        return new Promise((resolve, reject) => {
            const req = transport.request(parsedUrl, { method: 'HEAD', timeout: REQUEST_TIMEOUT }, (res) => {
                if (res.statusCode >= 200 && res.statusCode < 400) {
                    const len = res.headers['content-length'];
                    if (len) resolve(parseInt(len, 10));
                    else resolve(null);
                } else {
                    // fallback to range
                    resolve(null);
                }
            });
            req.on('timeout', () => req.destroy(new Error('Timeout')));
            req.on('error', reject);
            req.end();
        });
    }

    // Parse duration from a buffer containing the moov box
    function parseMoovDuration(buffer) {
        // Search for 'moov' box
        let offset = 0;
        while (offset + 8 <= buffer.length) {
            const size = buffer.readUInt32BE(offset);
            const type = buffer.toString('ascii', offset + 4, offset + 8);
            if (type === 'moov') {
                // Found moov box; parse its children to find mvhd
                const moovStart = offset + 8;
                const moovEnd = offset + size;
                let childOffset = moovStart;
                while (childOffset + 8 <= moovEnd && childOffset < buffer.length) {
                    const childSize = buffer.readUInt32BE(childOffset);
                    const childType = buffer.toString('ascii', childOffset + 4, childOffset + 8);
                    if (childType === 'mvhd') {
                        // mvhd structure: version(1) + flags(3) + creation(4) + modification(4) + timescale(4) + duration(4 or 8)
                        const version = buffer.readUInt8(childOffset + 8);
                        let timescale, duration;
                        if (version === 1) {
                            // 64-bit duration
                            timescale = buffer.readUInt32BE(childOffset + 20);
                            duration = buffer.readBigUInt64BE(childOffset + 24);
                        } else {
                            // version 0
                            timescale = buffer.readUInt32BE(childOffset + 16);
                            duration = buffer.readUInt32BE(childOffset + 20);
                        }
                        if (timescale > 0) {
                            return Number(duration) / timescale;
                        }
                    }
                    childOffset += childSize;
                }
                break; // moov found but maybe mvhd missing? we can continue searching other moov? unlikely
            }
            offset += size;
        }
        return null;
    }

    try {
        // Try to get file size first (for end-range)
        let fileSize = await getFileSize();

        // 1. Fetch beginning of file and look for moov
        let buffer = await fetchRange(0, CHUNK_SIZE - 1);
        let duration = parseMoovDuration(buffer);
        if (duration !== null) {
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ duration }));
            return;
        }

        // 2. If not found, try end of file (if size known)
        if (fileSize) {
            const start = Math.max(0, fileSize - CHUNK_SIZE);
            buffer = await fetchRange(start, fileSize - 1);
            duration = parseMoovDuration(buffer);
            if (duration !== null) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ duration }));
                return;
            }
        }

        // 3. Could not determine duration
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Could not determine video duration' }));
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    }
};
