const assert = require('node:assert/strict');
const test = require('node:test');
const {
  OutboundUrlError,
  isPublicAddress,
  parseOutboundUrl,
  requestPublicUrl,
  resolveOutboundDestination,
} = require('../src/services/outboundUrlPolicy');

const publicAddress = '93.184.216.34';

function resolverFor(records) {
  return async (hostname, options) => {
    assert.equal(hostname, 'public.example.test');
    assert.deepEqual(options, { all: true, verbatim: true });
    return records;
  };
}

function fakeHttpClient(responses, contactedAddresses = []) {
  return {
    async request(options) {
      const url = new URL(options.url);
      const agent =
        url.protocol === 'https:' ? options.httpsAgent : options.httpAgent;
      const address = await new Promise((resolve, reject) => {
        agent.options.lookup(url.hostname, {}, (error, resolvedAddress) =>
          error ? reject(error) : resolve(resolvedAddress)
        );
      });
      contactedAddresses.push(address);
      return responses.shift();
    },
  };
}

test('blocks prohibited IPv4 and IPv6 ranges, including IPv4-mapped IPv6', () => {
  const prohibited = [
    '0.1.2.3',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.8',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '2001:db8::1',
    '2002::1',
    '::ffff:127.0.0.1',
    '::ffff:10.1.2.3',
  ];
  for (const address of prohibited)
    assert.equal(isPublicAddress(address), false, address);

  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  assert.equal(isPublicAddress('::ffff:8.8.8.8'), true);
});

test('accepts only HTTP(S) URLs without embedded credentials', () => {
  assert.equal(
    parseOutboundUrl('https://public.example.test/path').protocol,
    'https:'
  );
  assert.throws(
    () => parseOutboundUrl('ftp://public.example.test/file'),
    OutboundUrlError
  );
  assert.throws(
    () => parseOutboundUrl('http://user:pass@public.example.test/'),
    OutboundUrlError
  );
});

test('rejects public hostnames with any prohibited DNS answer', async () => {
  await assert.rejects(
    resolveOutboundDestination(
      'https://public.example.test/',
      resolverFor([
        { address: publicAddress, family: 4 },
        { address: '127.0.0.1', family: 4 },
      ])
    ),
    /prohibited address/
  );
});

test('fails closed on DNS errors and empty DNS responses', async () => {
  await assert.rejects(
    resolveOutboundDestination('https://public.example.test/', async () => {
      throw new Error('injected lookup failure');
    }),
    { code: 'OUTBOUND_DNS_FAILED' }
  );
  await assert.rejects(
    resolveOutboundDestination('https://public.example.test/', async () => []),
    { code: 'OUTBOUND_DNS_FAILED' }
  );
});

test('pins the socket lookup to the validated public address', async () => {
  const contacted = [];
  const client = fakeHttpClient([{ status: 200, headers: {} }], contacted);
  const response = await requestPublicUrl(
    'https://public.example.test/health',
    { method: 'get' },
    {
      resolver: resolverFor([{ address: publicAddress, family: 4 }]),
      httpClient: client,
    }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(contacted, [publicAddress]);
});

test('does not perform a second DNS lookup between validation and socket connect', async () => {
  let dnsCalls = 0;
  const contacted = [];
  const resolver = async () => {
    dnsCalls += 1;
    return [
      {
        address: dnsCalls === 1 ? publicAddress : '127.0.0.1',
        family: 4,
      },
    ];
  };
  const client = fakeHttpClient([{ status: 200, headers: {} }], contacted);

  await requestPublicUrl(
    'https://public.example.test/path',
    {},
    { resolver, httpClient: client }
  );

  assert.equal(dnsCalls, 1);
  assert.deepEqual(contacted, [publicAddress]);
});

test('rejects a public-to-private redirect before opening the redirected connection', async () => {
  const contacted = [];
  const client = fakeHttpClient(
    [{ status: 302, headers: { location: 'http://127.0.0.1/admin' } }],
    contacted
  );
  await assert.rejects(
    requestPublicUrl(
      'https://public.example.test/start',
      {},
      {
        resolver: resolverFor([{ address: publicAddress, family: 4 }]),
        httpClient: client,
      }
    ),
    /prohibited address/
  );
  assert.deepEqual(contacted, [publicAddress]);
});

test('detects DNS rebinding between redirect hops and never contacts the changed address', async () => {
  const contacted = [];
  let resolution = 0;
  const resolver = async () => {
    resolution += 1;
    return [
      { address: resolution === 1 ? publicAddress : '10.0.0.8', family: 4 },
    ];
  };
  const client = fakeHttpClient(
    [
      {
        status: 302,
        headers: { location: 'https://public.example.test/next' },
      },
    ],
    contacted
  );

  await assert.rejects(
    requestPublicUrl(
      'https://public.example.test/start',
      {},
      { resolver, httpClient: client }
    ),
    /prohibited address/
  );
  assert.equal(resolution, 2);
  assert.deepEqual(contacted, [publicAddress]);
});

test('permits public URLs and follows only revalidated public redirects', async () => {
  const contacted = [];
  let resolution = 0;
  const resolver = async () => {
    resolution += 1;
    return [
      { address: resolution === 1 ? publicAddress : '1.1.1.1', family: 4 },
    ];
  };
  const client = fakeHttpClient(
    [
      {
        status: 302,
        headers: { location: 'https://public.example.test/final' },
      },
      { status: 200, headers: { 'content-type': 'text/plain' }, data: 'ok' },
    ],
    contacted
  );
  const response = await requestPublicUrl(
    'https://public.example.test/start',
    {},
    { resolver, httpClient: client }
  );
  assert.equal(response.status, 200);
  assert.deepEqual(contacted, [publicAddress, '1.1.1.1']);
});

test('strips sensitive headers on cross-origin redirects', async () => {
  const calls = [];
  const client = {
    async request(options) {
      calls.push(options);
      return calls.length === 1
        ? {
            status: 302,
            headers: { location: 'https://other.example.test/final' },
          }
        : { status: 200, headers: {} };
    },
  };
  const resolver = async () => [{ address: publicAddress, family: 4 }];

  await requestPublicUrl(
    'https://public.example.test/start',
    {
      headers: {
        Authorization: 'Bearer test',
        Cookie: 'session=test',
        'X-Request-ID': 'public',
      },
    },
    { resolver, httpClient: client }
  );

  assert.equal(calls[1].headers.Authorization, undefined);
  assert.equal(calls[1].headers.Cookie, undefined);
  assert.equal(calls[1].headers['X-Request-ID'], 'public');
});

test('does not call the HTTP client for a webhook URL targeting a private service', async () => {
  let calls = 0;
  await assert.rejects(
    requestPublicUrl(
      'http://[::ffff:127.0.0.1]:8080/webhook',
      { method: 'post', data: { event: 'crawl_completed' } },
      {
        httpClient: {
          request: async () => {
            calls += 1;
          },
        },
      }
    ),
    /prohibited address/
  );
  assert.equal(calls, 0);
});
