const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const createOutboundProxy = require('../src/services/outboundProxy');

test('rejects private HTTP proxy destinations before opening an upstream connection', async (t) => {
  const proxy = createOutboundProxy();
  const proxyUrl = await proxy.listen();
  t.after(() => proxy.close());
  const { port } = new URL(proxyUrl);

  const response = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(port),
        path: 'http://127.0.0.1:8080/internal',
        headers: { Host: '127.0.0.1:8080', Connection: 'close' },
        agent: false,
      },
      (result) => {
        result.resume();
        result.on('end', () => resolve(result));
      }
    );
    request.on('error', reject);
    request.end();
  });

  assert.equal(response.statusCode, 403);
});

test('rejects private CONNECT destinations before establishing a tunnel', async (t) => {
  const proxy = createOutboundProxy();
  const proxyUrl = await proxy.listen();
  t.after(() => proxy.close());
  const { port } = new URL(proxyUrl);

  const response = await new Promise((resolve, reject) => {
    const socket = require('node:net').connect(Number(port), '127.0.0.1');
    let received = '';
    socket.on('connect', () => {
      socket.write(
        'CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\nConnection: close\r\n\r\n'
      );
    });
    socket.on('data', (chunk) => {
      received += chunk.toString();
      if (received.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
  });

  assert.match(response, /^HTTP\/1\.1 403 Forbidden/);
});
