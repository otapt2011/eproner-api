// api/duration.js
const https = require('https');
const http = require('http');
const { URL } = require('url');

const REQUEST_TIMEOUT = 25000;
const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const FULL_DOWNLOAD_LIMIT = 10 * 1024 * 1024; // 10 MB

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const targetUrl = req.query?.url || req.url?.split('?url=')[1];
    if (!targetUrl) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing url parameter' }));
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
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('Only http/https allowed');
    } catch (err) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: `Invalid URL: ${err.message}` }));
        return;
    }

    const transport = parsedUrl.protocol === 'https:' ? https : http;

    function fetchRange(start, end) {
        return new Promise((resolve, reject) => {
            const options = {
                method: 'GET',
                headers: {
                    'Range': `bytes=${start}-${end}`,
                    'Accept-Encoding': 'identity',
                    'User-Agent': 'Mozilla/5.0 (compatible; DurationProxy/3.0)',
                },
                timeout: REQUEST_TIMEOUT,
            };
            const req = transport.request(parsedUrl, options, (upstreamRes) => {
                const chunks = [];
                upstreamRes.on('data', c => chunks.push(c));
                upstreamRes.on('end', () => {
                    if (upstreamRes.statusCode !== 206 && upstreamRes.statusCode !== 200) {
                        reject(new Error(`Unexpected status ${upstreamRes.statusCode}`));
                    } else {
                        resolve(Buffer.concat(chunks));
                    }
                });
                upstreamRes.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('Timeout')));
            req.on('error', reject);
            req.end();
        });
    }

    // Search for "mvhd" and parse duration based on version
    function parseMvhd(buffer) {
        const signature = Buffer.from('mvhd', 'ascii');
        let index = buffer.indexOf(signature);
        while (index !== -1) {
            // Need at least 4 bytes before index for size, but we can use surrounding context
            // Actually we need timescale and duration relative to mvhd start, so we need to know the offset of mvhd within its parent.
            // But we can read directly: version is at index+4, flags at index+5..7, creation at +8, modification at +12, timescale at +16, duration at +20 (for v0)
            const version = buffer.readUInt8(index + 4);
            let timescale, duration;
            if (version === 1) {
                // 64-bit duration: timescale at +20, duration at +24
                if (index + 32 > buffer.length) break;
                timescale = buffer.readUInt32BE(index + 20);
                duration = buffer.readBigUInt64BE(index + 24);
            } else {
                // version 0
                if (index + 24 > buffer.length) break;
                timescale = buffer.readUInt32BE(index + 16);
                duration = buffer.readUInt32BE(index + 20);
            }
            if (timescale > 0 && duration > 0) {
                return Number(duration) / timescale;
            }
            // Continue searching
            index = buffer.indexOf(signature, index + 1);
        }
        return null;
    }

    try {
        // 1. First chunk
        let buffer = await fetchRange(0, CHUNK_SIZE - 1);
        let duration = parseMvhd(buffer);
        if (duration !== null) {
            res.json({ duration });
            return;
        }

        // 2. Last chunk
        let fileSize;
        try {
            const headRes = await new Promise((resolve, reject) => {
                const req = transport.request(parsedUrl, { method: 'HEAD', timeout: REQUEST_TIMEOUT }, resolve);
                req.on('error', reject);
                req.end();
            });
            if (headRes.statusCode >= 200 && headRes.statusCode < 400) {
                const len = headRes.headers['content-length'];
                if (len) fileSize = parseInt(len, 10);
            }
        } catch (e) { /* ignore */ }

        if (fileSize && fileSize > CHUNK_SIZE) {
            const start = fileSize - CHUNK_SIZE;
            buffer = await fetchRange(start, fileSize - 1);
            duration = parseMvhd(buffer);
            if (duration !== null) {
                res.json({ duration });
                return;
            }
        }

        // 3. Full download if file is small enough
        if (!fileSize || fileSize <= FULL_DOWNLOAD_LIMIT) {
            buffer = await fetchRange(0, FULL_DOWNLOAD_LIMIT);
            duration = parseMvhd(buffer);
            if (duration !== null) {
                res.json({ duration });
                return;
            }
        }

        res.statusCode = 502;
        res.json({ error: 'Could not determine video duration' });
    } catch (err) {
        res.statusCode = 502;
        res.json({ error: err.message });
    }
};
