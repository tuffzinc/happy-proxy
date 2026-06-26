const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// PERFORMANCE OPTIMIZATION: Persistent keep-alive sockets reduce overhead handshakes significantly
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 150 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 150 });

let lastTargetOrigin = '';
let lastTargetFolder = ''; 

const server = http.createServer((req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const reqUrl = new URL(req.url, `${protocol}://${host}`);
    let targetUrlStr = reqUrl.searchParams.get('url');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Cookie',
            'Access-Control-Allow-Credentials': 'true',
            'Access-Control-Max-Age': '86400'
        });
        return res.end();
    }

    if (!targetUrlStr && !['/', '/index.html', '/cors', '/cors.html', '/web', '/web.html'].includes(reqUrl.pathname)) {
        const referer = req.headers['referer'] || '';
        let refererFolder = '';
        let refererOrigin = '';

        if (referer) {
            try {
                const refUrl = new URL(referer);
                const proxyUrlParam = refUrl.searchParams.get('url');
                if (proxyUrlParam) {
                    const parsedProxyUrl = new URL(proxyUrlParam);
                    refererOrigin = parsedProxyUrl.origin;
                    const segments = parsedProxyUrl.pathname.split('/');
                    segments.pop();
                    refererFolder = parsedProxyUrl.origin + segments.join('/') + '/';
                }
            } catch (e) {}
        }

        const activeOrigin = refererOrigin || lastTargetOrigin;
        const activeFolder = refererFolder || lastTargetFolder;

        if (reqUrl.pathname.startsWith('/')) {
            if (activeOrigin) targetUrlStr = activeOrigin + reqUrl.pathname + reqUrl.search;
        } else if (activeFolder) {
            targetUrlStr = activeFolder + reqUrl.pathname + reqUrl.search;
        }
    }

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html' || (!reqUrl.searchParams.get('url') && targetUrlStr)) {
        if (targetUrlStr) return handleProxyPipeline(req, res, targetUrlStr, reqUrl);
        return serveStaticFile(res, 'index.html', 'text/html');
    }

    if (reqUrl.pathname === '/cors' || reqUrl.pathname === '/cors.html') return serveStaticFile(res, 'cors.html', 'text/html');
    if (reqUrl.pathname === '/web' || reqUrl.pathname === '/web.html') return serveStaticFile(res, 'web.html', 'text/html');

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Resource Not Found');
});

function serveStaticFile(res, filename, contentType) {
    const filePath = path.join(__dirname, filename);
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            return res.end(`Error: Unable to locate ${filename}`);
        }
        res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
        res.end(data);
    });
}

function handleProxyPipeline(req, res, targetUrlStr, reqUrl) {
    try {
        const targetUrl = new URL(targetUrlStr);
        lastTargetOrigin = targetUrl.origin;
        
        const pathSegments = targetUrl.pathname.split('/');
        pathSegments.pop();
        lastTargetFolder = targetUrl.origin + pathSegments.join('/') + '/';
        
        const isHttps = targetUrl.protocol === 'https:';
        
        const proxyHeaders = { ...req.headers };
        delete proxyHeaders['host'];
        delete proxyHeaders['accept-encoding']; 
        
        const proxyOptions = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            agent: isHttps ? httpsAgent : httpAgent,
            headers: {
                ...proxyHeaders,
                'host': targetUrl.host,         
                'origin': targetUrl.origin,     
                'referer': targetUrl.origin,
                'user-agent': CHROME_USER_AGENT 
            }
        };

        const transport = isHttps ? https : http;

        const proxyReq = transport.request(proxyOptions, (proxyRes) => {
            let responseHeaders = { ...proxyRes.headers };
            responseHeaders['Access-Control-Allow-Origin'] = '*'; 

            delete responseHeaders['x-frame-options'];
            delete responseHeaders['content-security-policy'];
            delete responseHeaders['strict-transport-security'];

            if (responseHeaders['set-cookie']) {
                let cookies = responseHeaders['set-cookie'];
                if (!Array.isArray(cookies)) cookies = [cookies];
                responseHeaders['set-cookie'] = cookies.map(cookie => cookie.replace(/Domain=[^;]+;?\s*/gi, ''));
            }

            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && responseHeaders['location']) {
                try {
                    const absoluteRedirectUrl = new URL(responseHeaders['location'], targetUrl.href).href;
                    responseHeaders['location'] = `${reqUrl.origin}/?url=${encodeURIComponent(absoluteRedirectUrl)}`;
                } catch (e) {}
            }

            const contentType = responseHeaders['content-type'] || '';

            if (contentType.includes('text/html') || contentType.includes('text/css')) {
                let chunks = [];
                proxyRes.on('data', chunk => chunks.push(chunk));
                proxyRes.on('end', () => {
                    let bodyData = Buffer.concat(chunks).toString('utf8');
                    const baseProxyPath = `${reqUrl.origin}/?url=${encodeURIComponent(targetUrl.origin)}/`;
                    const baseTag = `<base href="${baseProxyPath}">`;
                    
                    // BUG FIX: Protocol-relative replacement filtering 
                    bodyData = bodyData.replace(/(href|src|action)=["']\/\/([^"']+)["']/gi, (match, attr, p1) => {
                        return `${attr}="${reqUrl.origin}/?url=${encodeURIComponent('https://' + p1)}"`;
                    });

                    bodyData = bodyData.replace(/(href|src|action)=["'](https?:\/\/[^"']+)["']/gi, (match, attr, p1) => {
                        return `${attr}="${reqUrl.origin}/?url=${encodeURIComponent(p1)}"`;
                    });
                    
                    bodyData = bodyData.replace(/(href|src|action)=["'](\/(?!\/)[^"']*)["']/gi, (match, attr, p1) => {
                        return `${attr}="${reqUrl.origin}/?url=${encodeURIComponent(targetUrl.origin + p1)}"`;
                    });

                    bodyData = bodyData.replace(/(href|src|action)=["'](?!(?:https?:\/\/|\/|#|javascript:|data:))([^"']+)["']/gi, (match, attr, p1) => {
                        return `${attr}="${reqUrl.origin}/?url=${encodeURIComponent(lastTargetFolder + p1)}"`;
                    });

                    bodyData = bodyData.replace(/url\(['"]?\/\/([^'")]+)['"]?\)/gi, (match, p1) => {
                        return `url("${reqUrl.origin}/?url=${encodeURIComponent('https://' + p1)}")`;
                    });
                    bodyData = bodyData.replace(/url\(['"]?(https?:\/\/[^'")]+)['"]?\)/gi, (match, p1) => {
                        return `url("${reqUrl.origin}/?url=${encodeURIComponent(p1)}")`;
                    });
                    bodyData = bodyData.replace(/url\(['"]?(\/(?!\/)[^'")]+)['"]?\)/gi, (match, p1) => {
                        return `url("${reqUrl.origin}/?url=${encodeURIComponent(targetUrl.origin + p1)}")`;
                    });
                    bodyData = bodyData.replace(/url\(['"]?(?!(?:https?:\/\/|\/|data:))([^'")]+)['"]?\)/gi, (match, p1) => {
                        return `url("${reqUrl.origin}/?url=${encodeURIComponent(lastTargetFolder + p1)}")`;
                    });
                    
                    if (contentType.includes('text/html')) {
                        if (bodyData.includes('<head>')) {
                            bodyData = bodyData.replace('<head>', `<head>\n    ${baseTag}`);
                        } else {
                            bodyData = baseTag + bodyData;
                        }
                    }

                    res.writeHead(proxyRes.statusCode, responseHeaders);
                    res.end(bodyData);
                });
            } else {
                res.writeHead(proxyRes.statusCode, responseHeaders);
                proxyRes.pipe(res);
            }
        });

        proxyReq.on('error', (err) => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: "Proxy upstream execution error", details: err.message }));
            }
        });

        req.pipe(proxyReq);

    } catch (error) {
        if (!res.headersSent) {
            res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: "Bad Target URL Parsing Request", details: error.message }));
        }
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
