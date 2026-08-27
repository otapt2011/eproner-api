// api/video-duration.js
const https = require('https');
const http = require('http');
const { URL } = require('url');

const REQUEST_TIMEOUT = 20000;
const CHUNK_SIZE = 1024 * 1024; // 1 MB
const FULL_DOWNLOAD_LIMIT = 5 * 1024 * 1024; // 5 MB

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
                    'User-Agent': 'Mozilla/5.0 (compatible; VideoDurationProxy/2.0)',
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

    function parseDuration(buffer) {
        // Search for 'moov' box anywhere in buffer
        let offset = 0;
        while (offset + 8 <= buffer.length) {
            const size = buffer.readUInt32BE(offset);
            const type = buffer.toString('ascii', offset + 4, offset + 8);
            if (type === 'moov') {
                const moovStart = offset + 8;
                const moovEnd = offset + size;
                let childOffset = moovStart;
                while (childOffset + 8 <= moovEnd && childOffset < buffer.length) {
                    const childSize = buffer.readUInt32BE(childOffset);
                    const childType = buffer.toString('ascii', childOffset + 4, childOffset + 8);
                    if (childType === 'mvhd') {
                        const version = buffer.readUInt8(childOffset + 8);
                        let timescale, duration;
                        if (version === 1) {
                            timescale = buffer.readUInt32BE(childOffset + 20);
                            duration = buffer.readBigUInt64BE(childOffset + 24);
                        } else {
                            timescale = buffer.readUInt32BE(childOffset + 16);
                            duration = buffer.readUInt32BE(childOffset + 20);
                        }
                        if (timescale > 0) {
                            return Number(duration) / timescale;
                        }
                    }
                    childOffset += childSize;
                }
                break; // moov found but mvhd maybe missing
            }
            offset += size;
        }
        return null;
    }

    try {
        // 1. First chunk
        let buffer = await fetchRange(0, CHUNK_SIZE - 1);
        let duration = parseDuration(buffer);
        if (duration !== null) {
            res.json({ duration });
            return;
        }

        // 2. Last chunk (if file size can be determined)
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
            duration = parseDuration(buffer);
            if (duration !== null) {
                res.json({ duration });
                return;
            }

            // 3. Binary search middle chunks (try up to 3 middle positions)
            for (let i = 1; i <= 3; i++) {
                const mid = Math.floor((fileSize * i) / 4);
                const chunkStart = Math.max(0, mid - Math.floor(CHUNK_SIZE / 2));
                const chunkEnd = Math.min(fileSize - 1, chunkStart + CHUNK_SIZE - 1);
                buffer = await fetchRange(chunkStart, chunkEnd);
                duration = parseDuration(buffer);
                if (duration !== null) {
                    res.json({ duration });
                    return;
                }
            }
        }

        // 4. Fallback: full download if small
        if (!fileSize || fileSize <= FULL_DOWNLOAD_LIMIT) {
            buffer = await fetchRange(0, FULL_DOWNLOAD_LIMIT);
            duration = parseDuration(buffer);
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
