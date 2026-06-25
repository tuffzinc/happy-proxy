const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;

const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const server = http.createServer((req, res) => {
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers.host || `localhost:${PORT}`;
    const reqUrl = new URL(req.url, `${protocol}://${host}`);
    const targetUrlStr = reqUrl.searchParams.get('url');

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, PATCH, OPTIONS',
            'Access-Control-Allow-Headers': 'Origin, X-Requested-With, Content-Type, Accept, Authorization',
            'Access-Control-Max-Age': '86400'
        });
        return res.end();
    }

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/index.html') {
        if (targetUrlStr) {
            return handleProxyPipeline(req, res, targetUrlStr, reqUrl);
        }
        return serveStaticFile(res, 'index.html', 'text/html');
    }

    if (reqUrl.pathname === '/cors' || reqUrl.pathname === '/cors.html') {
        return serveStaticFile(res, 'cors.html', 'text/html');
    }

    if (reqUrl.pathname === '/web' || reqUrl.pathname === '/web.html') {
        return serveStaticFile(res, 'web.html', 'text/html');
    }

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
        
        const proxyOptions = {
            hostname: targetUrl.hostname,
            port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search,
            method: req.method,
            headers: {
                ...req.headers,
                'host': targetUrl.host,         
                'origin': targetUrl.origin,     
                'referer': targetUrl.origin,
                'user-agent': CHROME_USER_AGENT // Forces the backend target to treat the proxy as the newest Chrome
            }
        };

        delete proxyOptions.headers['accept-encoding'];

        const transport = targetUrl.protocol === 'https:' ? https : http;

        const proxyReq = transport.request(proxyOptions, (proxyRes) => {
            let responseHeaders = { ...proxyRes.headers };
            
            responseHeaders['Access-Control-Allow-Origin'] = '*'; 

            delete responseHeaders['x-frame-options'];
            delete responseHeaders['content-security-policy'];
            delete responseHeaders['strict-transport-security'];

            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && responseHeaders['location']) {
                try {
                    const absoluteRedirectUrl = new URL(responseHeaders['location'], targetUrl.href).href;
                    responseHeaders['location'] = `${reqUrl.origin}/?url=${encodeURIComponent(absoluteRedirectUrl)}`;
                } catch (e) {
                }
            }

            const contentType = responseHeaders['content-type'] || '';
            const referer = req.headers['referer'] || '';

            if (contentType.includes('text/html') && !referer.includes('/cors')) {
                let bodyData = '';
                proxyRes.on('data', chunk => bodyData += chunk);
                proxyRes.on('end', () => {
                    const baseProxyPath = `${reqUrl.origin}/?url=${encodeURIComponent(targetUrl.origin)}/`;
                    const baseTag = `<base href="${baseProxyPath}">`;
                    
                    bodyData = bodyData.replace(/href=["'](https?:\/\/[^"']+)["']/gi, (match, p1) => {
                        return `href="${reqUrl.origin}/?url=${encodeURIComponent(p1)}"`;
                    });
                    bodyData = bodyData.replace(/src=["'](https?:\/\/[^"']+)["']/gi, (match, p1) => {
                        return `src="${reqUrl.origin}/?url=${encodeURIComponent(p1)}"`;
                    });
                    
                    if (bodyData.includes('<head>')) {
                        bodyData = bodyData.replace('<head>', `<head>\n    ${baseTag}`);
                    } else {
                        bodyData = baseTag + bodyData;
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
            res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: "Proxy routing exception", details: err.message }));
        });

        req.pipe(proxyReq);

    } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: "Invalid Target URL", details: error.message }));
    }
}

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
