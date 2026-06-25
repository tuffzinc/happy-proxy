const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8080;

const server = http.createServer((req, res) => {
    const host = req.headers.host || `localhost:${PORT}`;
    const reqUrl = new URL(req.url, `http://${host}`);
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

// Helper to serve local HTML files
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
                'host': targetUrl.host,         // Overwrite host to prevent rejections
                'origin': targetUrl.origin,     // Spoof origin
                'referer': targetUrl.origin     // Spoof referer
            }
        };

        delete proxyOptions.headers['accept-encoding'];

        const transport = targetUrl.protocol === 'https:' ? https : http;

        const proxyReq = transport.request(proxyOptions, (proxyRes) => {
            const responseHeaders = { ...proxyRes.headers };
            
            responseHeaders['Access-Control-Allow-Origin'] = '*'; 

            delete responseHeaders['x-frame-options'];
            delete responseHeaders['content-security-policy'];
            delete responseHeaders['strict-transport-security'];

            const contentType = responseHeaders['content-type'] || '';
            const referer = req.headers['referer'] || '';

            if (contentType.includes('text/html') && !referer.includes('/cors')) {
                let bodyData = '';
                proxyRes.on('data', chunk => bodyData += chunk);
                proxyRes.on('end', () => {
                    const baseProxyPath = `${reqUrl.origin}/?url=${encodeURIComponent(targetUrl.origin)}/`;
                    const baseTag = `<base href="${baseProxyPath}">`;
                    
                    bodyData = bodyData.replace(/href="https?:\/\//gi, `href="${reqUrl.origin}/?url=$&`);
                    bodyData = bodyData.replace(/src="https?:\/\//gi, `src="${reqUrl.origin}/?url=$&`);
                    
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
