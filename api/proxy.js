// api/proxy.js
// A minimal CORS proxy for Vercel – no external dependencies
// Usage: /api/proxy?url=https://target.example.com/path?query=...

const https = require('https');
const http = require('http');
const { URL } = require('url');

// Allowed HTTP methods (you can extend if needed)
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

// Maximum response size (to prevent abuse) – 10 MB
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;

// Timeout for upstream request (in ms)
const REQUEST_TIMEOUT = 30000;

module.exports = async (req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Max-Age', '86400');
        res.statusCode = 204;
        res.end();
        return;
    }

    // Set CORS headers for all responses
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Parse target URL from query parameter
    const targetUrl = req.query?.url || req.url?.split('?url=')[1];
    if (!targetUrl) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Missing "url" query parameter' }));
        return;
    }

    // Decode the URL (it may be URL-encoded)
    let decodedUrl;
    try {
        decodedUrl = decodeURIComponent(targetUrl);
    } catch (e) {
        decodedUrl = targetUrl;
    }

    // Validate URL
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

    // Prepare upstream request options
    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    // Collect request body (if any)
    const chunks = [];
    let bodyBuffer = null;
    for await (const chunk of req) {
        chunks.push(chunk);
        if (Buffer.concat(chunks).length > MAX_RESPONSE_SIZE) {
            res.statusCode = 413;
            res.end('Request body too large');
            return;
        }
    }
    if (chunks.length > 0) {
        bodyBuffer = Buffer.concat(chunks);
    }

    // Build headers to forward (exclude host and accept-encoding to avoid compression issues)
    const forwardHeaders = { ...req.headers };
    delete forwardHeaders.host;
    delete forwardHeaders['accept-encoding'];
    delete forwardHeaders['content-length']; // will set manually if body exists

    if (bodyBuffer) {
        forwardHeaders['content-length'] = Buffer.byteLength(bodyBuffer);
    }

    const upstreamOptions = {
        method: req.method,
        headers: forwardHeaders,
        timeout: REQUEST_TIMEOUT,
    };

    // Make the upstream request
    const upstreamReq = transport.request(parsedUrl, upstreamOptions, (upstreamRes) => {
        // Copy status code and headers
        res.statusCode = upstreamRes.statusCode;

        // Copy headers, but skip content-encoding (we'll let the client handle it)
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (key.toLowerCase() === 'content-encoding') continue; // avoid double encoding
            if (key.toLowerCase() === 'content-length') continue; // we'll set manually
            res.setHeader(key, value);
        }

        // Set CORS header again (in case it got overwritten)
        res.setHeader('Access-Control-Allow-Origin', '*');

        // Pipe the response body
        let totalSize = 0;
        upstreamRes.on('data', (chunk) => {
            totalSize += chunk.length;
            if (totalSize > MAX_RESPONSE_SIZE) {
                upstreamReq.destroy();
                res.statusCode = 502;
                res.end('Upstream response too large');
                return;
            }
            res.write(chunk);
        });

        upstreamRes.on('end', () => {
            res.end();
        });

        upstreamRes.on('error', (err) => {
            res.statusCode = 502;
            res.end(`Upstream error: ${err.message}`);
        });
    });

    upstreamReq.on('timeout', () => {
        upstreamReq.destroy(new Error('Upstream request timed out'));
    });

    upstreamReq.on('error', (err) => {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: `Proxy error: ${err.message}` }));
    });

    // Send the request body if present
    if (bodyBuffer) {
        upstreamReq.write(bodyBuffer);
    }
    upstreamReq.end();
};
