import { app } from "./agent";

const port = Number(process.env.PORT ?? 8787);

const server = Bun.serve({
  port,
  fetch: async (request, server) => {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    const search = url.search;

    // Log all incoming requests
    console.log(`📥 ${method} ${path}${search}`);
    console.log(`📋 Headers:`, Object.fromEntries(request.headers.entries()));

    // Log request body for POST requests
    if (method === 'POST' && request.headers.get('content-type')?.includes('application/json')) {
      try {
        const body = await request.clone().text();
        console.log(`📦 Body:`, body);
      } catch (error) {
        console.log(`📦 Body: [Could not read body]`);
      }
    }

    console.log('---');

    // Call the original app.fetch
    try {
      const response = await app.fetch(request, server);

      // Log response
      console.log(`📤 Response: ${response.status} ${response.statusText}`);

      return response;
    } catch (error) {
      console.error(`❌ Error handling request:`, error);
      return new Response(`Internal Server Error: ${error.message}`, { status: 500 });
    }
  },
});

console.log(
  `🚀 Agent ready at http://${server.hostname}:${server.port}/.well-known/agent.json`
);
console.log(`🔍 Debug logging enabled - all requests will be logged`);
