addEventListener('fetch', (event) => {
    event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
    const url = new URL(request.url);
    const targetUrlStr = url.searchParams.get('url');

    if (url.pathname === '/' || url.pathname === '/web.html') {
        if (targetUrlStr) {
            return await handleProxyPipeline(request, url, targetUrlStr);
        }

        try {
            const htmlContent = await Deno.readTextFile('./web.html');
            return new Response(htmlContent, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (err) {
            return new Response("Error: Unable to locate web.html.", { status: 500 });
        }
    }

    if (url.pathname === '/cors' || url.pathname === '/cors.html') {
        try {
            const htmlContent = await Deno.readTextFile('./cors.html');
            return new Response(htmlContent, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        } catch (err) {
            return new Response("Error: Unable to locate cors.html.", { status: 500 });
        }
    }

    // ROUTE 3: Handle Preflight CORS Verification
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            }
        });
    }

    // ROUTE 4: Legacy Proxy Data Pipeline Endpoint
    if (url.pathname === '/proxy') {
        if (!targetUrlStr) {
            return new Response(JSON.stringify({ error: "Missing parameter: ?url=" }), { status: 400 });
        }
        return await handleProxyPipeline(request, url, targetUrlStr);
    }

    return new Response("Resource Not Found", { status: 404 });
}

// Shared proxy handler execution logic
async function handleProxyPipeline(request, url, targetUrlStr) {
    try {
        const targetUrl = new URL(targetUrlStr);
        const headers = new Headers(request.headers);
        headers.set('Host', targetUrl.host);

        const proxyRequest = new Request(targetUrl, {
            method: request.method,
            headers: headers,
            body: request.method !== 'GET' && request.method !== 'HEAD' ? await request.blob() : null,
            redirect: 'follow'
        });

        const response = await fetch(proxyRequest);
        const responseHeaders = new Headers(response.headers);
        
        // Set universal CORS policy on responses
        responseHeaders.set('Access-Control-Allow-Origin', '*');

        const contentType = response.headers.get('content-type') || '';
        
        const referer = request.headers.get('referer') || '';
        if (contentType.includes('text/html') && !referer.includes('/cors')) {
            let htmlText = await response.text();
            
            const baseProxyPath = `${url.origin}/?url=${encodeURIComponent(targetUrl.origin)}/`;
            const baseTag = `<base href="${baseProxyPath}">`;

            if (htmlText.includes('<head>')) {
                htmlText = htmlText.replace('<head>', `<head>\n    ${baseTag}`);
            } else {
                htmlText = baseTag + htmlText;
            }
            return new Response(htmlText, { status: response.status, headers: responseHeaders });
        }

        return new Response(response.body, { status: response.status, headers: responseHeaders });

    } catch (error) {
        return new Response(JSON.stringify({ error: "Proxy routing exception", details: error.message }), { 
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
