const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const {
  OutboundUrlError,
  parseOutboundUrl,
  pinnedLookup,
  resolveOutboundDestination,
} = require('./outboundUrlPolicy');

function createOutboundProxy({ resolver, validateAddress } = {}) {
  const resolveDestination = (url) =>
    resolveOutboundDestination(url, resolver, validateAddress);
  let acceptedConnections = 0;
  let closePromise = null;
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let destination;
    try {
      destination = await resolveDestination(request.url);
    } catch (error) {
      response.writeHead(error instanceof OutboundUrlError ? 403 : 502);
      response.end('Outbound destination rejected.');
      return;
    }

    const { url, address } = destination;
    const transport = url.protocol === 'https:' ? https : http;
    const agent = new transport.Agent({
      keepAlive: false,
      lookup: pinnedLookup(address),
    });
    const headers = { ...request.headers, host: url.host, connection: 'close' };
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];

    const upstream = transport.request(
      {
        protocol: url.protocol,
        hostname: destination.hostname,
        port: destination.port,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers,
        agent,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode || 502,
          upstreamResponse.headers
        );
        upstreamResponse.pipe(response);
      }
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('Outbound request failed.');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => {
      upstream.destroy();
      agent.destroy();
    });
    request.pipe(upstream);
  });
  server.on('connection', (socket) => {
    acceptedConnections += 1;
    sockets.add(socket);
    socket.on('error', (error) => {
      if (error.code !== 'ECONNRESET') socket.destroy();
    });
    socket.once('close', () => sockets.delete(socket));
  });

  server.on('connect', async (request, clientSocket, head) => {
    let destination;
    try {
      const target = parseOutboundUrl(`https://${request.url}`);
      destination = await resolveDestination(target);
    } catch (error) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }

    const upstreamSocket = net.connect({
      host: destination.address,
      port: destination.port,
    });
    let tunnelEstablished = false;
    const rejectTunnel = () => {
      if (tunnelEstablished) {
        clientSocket.destroy();
      } else {
        clientSocket.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'
        );
      }
      upstreamSocket.destroy();
    };
    upstreamSocket.on('error', rejectTunnel);
    upstreamSocket.once('connect', () => {
      tunnelEstablished = true;
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    clientSocket.on('error', () => upstreamSocket.destroy());
    clientSocket.once('close', () => upstreamSocket.destroy());
  });

  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  return {
    get acceptedConnections() {
      return acceptedConnections;
    },
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    close() {
      if (closePromise) return closePromise;
      for (const socket of sockets) socket.destroy();
      closePromise = new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return closePromise;
    },
  };
}

module.exports = createOutboundProxy;
