// api/video-sources-puppeteer.js
// Uses headless Chromium to load embed page, extract hash, and fetch XHR.
// Usage: /api/video-sources-puppeteer?id=VIDEO_ID

const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

// XHR parameters (embed=false as we're on main video page context after loading embed? Actually we can use embed=true because the page is embed)
// We'll set embed=true because we are loading the embed page.
const XHR_PARAMS = {
    domain: 'www.eporner.com',
    pixelRatio: '3',
    playerWidth: '0',
    playerHeight: '0',
    fallback: 'true',
    embed: 'true',
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

    let browser = null;
    try {
        // Launch headless Chromium
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
        });

        const page = await browser.newPage();

        // Set a realistic user agent (optional, but helpful)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // Navigate to embed page
        const embedUrl = `https://www.eporner.com/embed/${videoId}`;
        await page.goto(embedUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Extract the hash from the page
        const hash = await page.evaluate(() => {
            if (window.EP && window.EP.video && window.EP.video.player) {
                return window.EP.video.player.hash || null;
            }
            // Fallback: search for hash in inline scripts
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                const text = script.textContent;
                const match = text.match(/EP\.video\.player\.hash\s*=\s*['"]([a-f0-9]{16,})['"]/i);
                if (match) return match[1];
            }
            return null;
        });

        if (!hash) {
            throw new Error('Hash not found on embed page');
        }

        // Build XHR URL
        const xhrUrl = `https://www.eporner.com/xhr/video/${videoId}?hash=${hash}`;
        for (const [key, value] of Object.entries(XHR_PARAMS)) {
            xhrUrl += `&${key}=${encodeURIComponent(value)}`;
        }

        // Fetch the XHR data from within the browser context to inherit cookies and headers
        const xhrData = await page.evaluate(async (url) => {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json, text/plain, */*',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Referer': window.location.href,
                    'Origin': 'https://www.eporner.com',
                },
                credentials: 'include',
            });
            if (!response.ok) throw new Error(`XHR HTTP ${response.status}`);
            return await response.json();
        }, xhrUrl);

        // Send back the result
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(xhrData));
    } catch (err) {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
    } finally {
        if (browser) {
            await browser.close();
        }
    }
};
