const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const axios = require('axios');
const { raceWithAbort, throwIfAborted } = require('./crawlCancellation');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_LIMIT = 5;

class OutboundUrlError extends Error {
  constructor(message, code = 'OUTBOUND_URL_REJECTED') {
    super(message);
    this.name = 'OutboundUrlError';
    this.code = code;
  }
}

function parseOutboundUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new OutboundUrlError('Invalid outbound URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new OutboundUrlError(
      'Only HTTP and HTTPS outbound URLs are allowed.'
    );
  }
  if (url.username || url.password) {
    throw new OutboundUrlError('Credentials in outbound URLs are not allowed.');
  }
  if (!url.hostname || url.hostname.includes('%')) {
    throw new OutboundUrlError('Invalid outbound hostname.');
  }

  return url;
}

function parseIpv4Number(address) {
  if (net.isIP(address) !== 4) return null;
  return address
    .split('.')
    .reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function inIpv4Range(address, network, prefix) {
  const value = parseIpv4Number(address);
  const base = parseIpv4Number(network);
  if (value === null || base === null) return false;
  const shift = 32n - BigInt(prefix);
  return value >> shift === base >> shift;
}

const PROHIBITED_IPV4_RANGES = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv6ToBigInt(address) {
  if (net.isIP(address) !== 6) return null;
  let normalized = address.toLowerCase();
  if (normalized.includes('%')) return null;

  const lastColon = normalized.lastIndexOf(':');
  const dottedTail = normalized.slice(lastColon + 1);
  if (dottedTail.includes('.')) {
    const ipv4 = parseIpv4Number(dottedTail);
    if (ipv4 === null) return null;
    normalized = `${normalized.slice(0, lastColon)}:${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (
    (halves.length === 1 && missing !== 0) ||
    (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (
    groups.length !== 8 ||
    groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(`0x${group}`),
    0n
  );
}

function inIpv6Range(value, network, prefix) {
  const base = ipv6ToBigInt(network);
  if (value === null || base === null) return false;
  const shift = 128n - BigInt(prefix);
  return value >> shift === base >> shift;
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    return !PROHIBITED_IPV4_RANGES.some(([network, prefix]) =>
      inIpv4Range(address, network, prefix)
    );
  }
  if (family !== 6) return false;

  const value = ipv6ToBigInt(address);
  if (value === null) return false;

  const mappedPrefix = value >> 32n;
  if (mappedPrefix === 0xffffn) {
    const embedded = value & 0xffffffffn;
    const mappedIpv4 = [24n, 16n, 8n, 0n]
      .map((shift) => Number((embedded >> shift) & 0xffn))
      .join('.');
    return isPublicAddress(mappedIpv4);
  }

  if (!inIpv6Range(value, '2000::', 3)) return false;
  const prohibitedIpv6Ranges = [
    ['2001::', 23],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['3fff::', 20],
  ];
  return !prohibitedIpv6Ranges.some(([network, prefix]) =>
    inIpv6Range(value, network, prefix)
  );
}

function pinnedLookup(address) {
  const family = net.isIP(address);
  return (hostname, options, callback) => {
    if (typeof options === 'function') callback = options;
    const lookupOptions = typeof options === 'function' ? {} : options || {};
    queueMicrotask(() => {
      if (lookupOptions.family && lookupOptions.family !== family) {
        callback(
          Object.assign(new Error('Pinned address family mismatch.'), {
            code: 'EAI_ADDRFAMILY',
          })
        );
      } else if (lookupOptions.all) {
        callback(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    });
  };
}

async function resolveOutboundDestination(
  value,
  resolver = dns.promises.lookup,
  validateAddress = isPublicAddress
) {
  const url =
    value instanceof URL ? new URL(value.href) : parseOutboundUrl(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new OutboundUrlError('Invalid outbound URL.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let records;
  if (net.isIP(hostname)) {
    records = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    try {
      records = await resolver(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new OutboundUrlError(
        `Outbound DNS resolution failed for ${hostname}.`,
        'OUTBOUND_DNS_FAILED'
      );
    }
  }

  if (!Array.isArray(records) || records.length === 0) {
    throw new OutboundUrlError(
      'Outbound hostname resolved to no addresses.',
      'OUTBOUND_DNS_FAILED'
    );
  }
  if (records.some(({ address }) => !validateAddress(address, hostname, url))) {
    throw new OutboundUrlError(
      'Outbound hostname resolves to a prohibited address.'
    );
  }

  const address = records[0].address;
  return {
    url,
    hostname,
    address,
    family: net.isIP(address),
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
  };
}

async function requestPublicUrl(value, options = {}, dependencies = {}) {
  const httpClient = dependencies.httpClient || axios;
  const resolver = dependencies.resolver || dns.promises.lookup;
  const validateAddress = dependencies.validateAddress || isPublicAddress;
  let url = parseOutboundUrl(value);
  let method = (options.method || 'get').toLowerCase();
  let data = options.data;
  let headers = { ...(options.headers || {}) };

  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfAborted(options.signal);
    if (options.beforeRequest) await options.beforeRequest(url, redirectCount);
    const destination = await raceWithAbort(
      resolveOutboundDestination(url, resolver, validateAddress),
      options.signal
    );
    throwIfAborted(options.signal);

    const httpAgent = new http.Agent({
      keepAlive: false,
      lookup: pinnedLookup(destination.address),
    });
    const httpsAgent = new https.Agent({
      keepAlive: false,
      lookup: pinnedLookup(destination.address),
    });
    let response;
    try {
      response = await httpClient.request({
        ...options,
        method,
        url: url.href,
        data,
        headers,
        timeout: options.timeout,
        signal: options.signal,
        maxRedirects: 0,
        proxy: false,
        httpAgent,
        httpsAgent,
        validateStatus: () => true,
      });
    } finally {
      httpAgent.destroy();
      httpsAgent.destroy();
    }

    const location = response.headers?.location;
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    if (redirectCount >= (options.maxRedirects ?? REDIRECT_LIMIT)) {
      throw new OutboundUrlError(
        'Outbound redirect limit exceeded.',
        'OUTBOUND_REDIRECT_LIMIT'
      );
    }

    const previousOrigin = url.origin;
    url = parseOutboundUrl(new URL(location, url).href);
    if (url.origin !== previousOrigin) {
      for (const header of Object.keys(headers)) {
        if (
          ['authorization', 'cookie', 'proxy-authorization'].includes(
            header.toLowerCase()
          )
        ) {
          delete headers[header];
        }
      }
    }
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) &&
        method === 'post')
    ) {
      method = 'get';
      data = undefined;
      headers = { ...headers };
      for (const header of Object.keys(headers)) {
        if (['content-length', 'content-type'].includes(header.toLowerCase())) {
          delete headers[header];
        }
      }
    }
  }
}

module.exports = {
  OutboundUrlError,
  isPublicAddress,
  parseOutboundUrl,
  pinnedLookup,
  requestPublicUrl,
  resolveOutboundDestination,
};
