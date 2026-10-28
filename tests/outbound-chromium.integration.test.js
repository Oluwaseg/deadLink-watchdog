const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { execFileSync } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const previousNodeEnv = process.env.NODE_ENV;
const previousJwtSecret = process.env.JWT_SECRET;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET =
  'Chromium-Integration-Test-Secret-Only-For-Module-Load-9xQ!';
const WebCrawler = require('../src/services/crawler');
const { CrawlCancellationError } = require('../src/services/crawlCancellation');
const { isPublicAddress } = require('../src/services/outboundUrlPolicy');
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
else process.env.JWT_SECRET = previousJwtSecret;

const LOOPBACK = '127.0.0.1';
const TEST_HOSTS = new Set(['valid.test', 'secure.test', 'mismatch.test']);

function runPowerShell(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { encoding: 'utf8', windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `PowerShell certificate setup failed: ${result.stderr || result.stdout}`
    );
  }
  return result.stdout.trim().split(/\r?\n/).at(-1);
}

function createTemporaryTestCertificate(directory) {
  const pfxPath = path.join(directory, 'server.pfx');
  const rootPath = path.join(directory, 'root.cer');
  const password = 'local-test-only-password';
  const setupScript = `
    $ErrorActionPreference = 'Stop'
    $root = New-SelfSignedCertificate -Subject 'CN=DeadLink Watchdog Local Test Root' -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage CertSign,CRLSign,DigitalSignature -NotAfter (Get-Date).AddDays(2) -TextExtension @('2.5.29.19={critical}{text}ca=1&pathlength=1')
    $leaf = New-SelfSignedCertificate -DnsName 'secure.test' -Signer $root -CertStoreLocation 'Cert:\\CurrentUser\\My' -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddDays(2) -TextExtension @('2.5.29.19={critical}{text}ca=0')
    $securePassword = ConvertTo-SecureString '${password}' -AsPlainText -Force
    Export-PfxCertificate -Cert $leaf -FilePath '${pfxPath}' -Password $securePassword | Out-Null
    Export-Certificate -Cert $root -FilePath '${rootPath}' | Out-Null
    Write-Output "$($root.Thumbprint)|$($leaf.Thumbprint)"
  `;
  const thumbprints = runPowerShell(setupScript).split('|');
  if (!fs.existsSync(pfxPath) || !fs.existsSync(rootPath)) {
    const cleanupScript = `
      Remove-Item -Path 'Cert:\\CurrentUser\\My\\${thumbprints[1]}' -Force -ErrorAction SilentlyContinue
      Remove-Item -Path 'Cert:\\CurrentUser\\My\\${thumbprints[0]}' -Force -ErrorAction SilentlyContinue
    `;
    try {
      runPowerShell(cleanupScript);
    } catch {}
    fs.rmSync(pfxPath, { force: true });
    fs.rmSync(rootPath, { force: true });
    throw new Error(
      'Temporary TLS certificate setup did not produce expected artifacts.'
    );
  }
  const certificate = {
    pfxPath,
    rootPath,
    rootThumbprint: thumbprints[0],
    leafThumbprint: thumbprints[1],
    password,
  };
  return certificate;
}

function removeTemporaryTestCertificate(certificate) {
  if (!certificate) return;
  const cleanupScript = `
    Remove-Item -Path 'Cert:\\CurrentUser\\My\\${certificate.leafThumbprint}' -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'Cert:\\CurrentUser\\My\\${certificate.rootThumbprint}' -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'Cert:\\CurrentUser\\Root\\${certificate.rootThumbprint}' -Force -ErrorAction SilentlyContinue
  `;
  try {
    runPowerShell(cleanupScript);
  } catch {}
  fs.rmSync(certificate.pfxPath, { force: true });
  fs.rmSync(certificate.rootPath, { force: true });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

function closeServer(server) {
  if (!server?.listening) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function closeCrawler(crawler) {
  if (!crawler) return;

  const browserProcess = crawler.browser?.process();
  await crawler.outboundProxy?.close().catch(() => {});
  let timeout;
  const closePromise = crawler.close().catch(() => false);
  const closed = await Promise.race([
    closePromise.then((result) => result !== false),
    new Promise((resolve) => {
      timeout = setTimeout(() => resolve(false), 5000);
    }),
  ]);
  clearTimeout(timeout);

  if (!closed) {
    if (process.platform === 'win32' && browserProcess?.pid) {
      try {
        execFileSync(
          'taskkill.exe',
          ['/PID', String(browserProcess.pid), '/T', '/F'],
          { stdio: 'ignore', windowsHide: true }
        );
      } catch {}
    } else {
      browserProcess?.kill('SIGKILL');
    }
    await Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  }
}

async function waitFor(predicate, message, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    path.join(
      process.env.ProgramFiles || 'C:\\Program Files',
      'Google',
      'Chrome',
      'Application',
      'chrome.exe'
    ),
    path.join(
      process.env.LOCALAPPDATA || '',
      'ms-playwright',
      'chromium-1228',
      'chrome-win64',
      'chrome.exe'
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

test(
  'real Chromium uses the validating proxy for HTTP, CONNECT, redirects, subresources, TLS rejection, and cancellation',
  {
    timeout: 90000,
  },
  async (t) => {
    if (process.platform !== 'win32') {
      t.skip(
        'This integration test requires Windows PowerShell certificate-store support.'
      );
      return;
    }

    const chromePath = findChrome();
    assert.ok(
      chromePath,
      'Install Chrome/Chromium locally or set CHROME_EXECUTABLE_PATH; test will not download a browser.'
    );

    const tempDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'deadlink-chromium-ssrf-')
    );
    let certificate;
    let crawler;
    let httpServer;
    let httpsServer;
    const requestedPaths = [];
    const requestedSniNames = [];
    const slowResponses = new Set();
    const resolverCalls = [];

    try {
      certificate = createTemporaryTestCertificate(tempDirectory);

      httpServer = http.createServer((request, response) => {
        requestedPaths.push(request.url);
        if (request.url === '/subresources') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end(
            `<!doctype html><img src="http://blocked.test:${httpServer.address().port}/private"><img src="http://${LOOPBACK}:${httpServer.address().port}/direct-canary">`
          );
          return;
        }
        if (request.url === '/redirect-private') {
          response.writeHead(302, {
            location: `http://blocked.test:${httpServer.address().port}/redirect-target`,
          });
          response.end();
          return;
        }
        if (request.url === '/slow') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.write('<!doctype html><title>slow</title>');
          slowResponses.add(response);
          response.on('close', () => slowResponses.delete(response));
          return;
        }
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<!doctype html><title>local http works</title>');
      });
      const httpPort = await listen(httpServer);

      const httpsCredentials = {
        pfx: fs.readFileSync(certificate.pfxPath),
        passphrase: certificate.password,
      };
      httpsServer = https.createServer(
        {
          ...httpsCredentials,
          SNICallback: (servername, callback) => {
            requestedSniNames.push(servername);
            callback(null, tls.createSecureContext(httpsCredentials));
          },
        },
        (request, response) => {
          requestedPaths.push(`https:${request.url}`);
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<!doctype html><title>local https works</title>');
        }
      );
      const httpsPort = await listen(httpsServer);

      const resolver = async (hostname, options) => {
        resolverCalls.push(hostname);
        assert.deepEqual(options, { all: true, verbatim: true });
        if (hostname === LOOPBACK || hostname === '127.0.0.1') {
          return [{ address: LOOPBACK, family: 4 }];
        }
        if (
          hostname === 'valid.test' ||
          hostname === 'secure.test' ||
          hostname === 'mismatch.test' ||
          hostname === 'blocked.test'
        ) {
          return [{ address: LOOPBACK, family: 4 }];
        }
        throw new Error(`Unexpected hostname in local test: ${hostname}`);
      };
      const validateAddress = (address, hostname) =>
        address === LOOPBACK && TEST_HOSTS.has(hostname);

      crawler = new WebCrawler({
        resolver,
        validateAddress,
        browserExecutablePath: chromePath,
      });
      const subresourceResult = await crawler.extractLinks(
        `http://valid.test:${httpPort}/subresources`
      );
      assert.equal(
        requestedPaths.includes('/subresources'),
        true,
        `Expected proxied HTTP request; proxy=${crawler.outboundProxyUrl}, proxyConnections=${crawler.outboundProxy.acceptedConnections}, args=${JSON.stringify(crawler.browser.process().spawnargs.filter((arg) => arg.includes('proxy') || arg.includes('host-resolver')))}, paths=${JSON.stringify(requestedPaths)}, dns=${JSON.stringify(resolverCalls)}, errors=${JSON.stringify(subresourceResult.errors)}`
      );
      await waitFor(
        () => resolverCalls.includes('blocked.test'),
        'Chromium did not pass the internal subresource through the validating policy.'
      );
      assert.equal(
        requestedPaths.some((entry) => entry.includes('/private')),
        false
      );
      assert.equal(
        requestedPaths.some((entry) => entry.includes('/direct-canary')),
        false
      );

      const redirectLookupsBefore = resolverCalls.filter(
        (host) => host === 'blocked.test'
      ).length;
      await crawler.extractLinks(
        `http://valid.test:${httpPort}/redirect-private`
      );
      await waitFor(
        () =>
          resolverCalls.filter((host) => host === 'blocked.test').length >
          redirectLookupsBefore,
        'Chromium redirect destination did not pass through the proxy policy.'
      );
      assert.equal(
        requestedPaths.some((entry) => entry.includes('/redirect-target')),
        false
      );

      const secureResult = await crawler.extractLinks(
        `https://secure.test:${httpsPort}/tls-valid`
      );
      assert.equal(
        secureResult.errors.some((entry) =>
          /ERR_CERT_AUTHORITY_INVALID|certificate/i.test(entry.error)
        ),
        true,
        `Chromium should reject the untrusted local test CA with verification enabled: ${JSON.stringify(secureResult.errors)}`
      );
      assert.equal(requestedSniNames.includes('secure.test'), true);
      assert.equal(requestedPaths.includes('https:/tls-valid'), false);

      const requestsBeforeMismatch = requestedPaths.length;
      const mismatchResult = await crawler.extractLinks(
        `https://mismatch.test:${httpsPort}/tls-mismatch`
      );
      assert.equal(requestedPaths.length, requestsBeforeMismatch);
      assert.equal(
        mismatchResult.errors.some((entry) =>
          /ERR_CERT_AUTHORITY_INVALID|certificate/i.test(entry.error)
        ),
        true,
        `Chromium must reject an untrusted TLS certificate without bypass flags: ${JSON.stringify(mismatchResult.errors)}`
      );
      assert.equal(requestedSniNames.includes('mismatch.test'), true);

      const controller = new AbortController();
      const slowCrawl = crawler.extractLinks(
        `http://valid.test:${httpPort}/slow`,
        1,
        null,
        controller.signal
      );
      await waitFor(
        () => requestedPaths.includes('/slow') && slowResponses.size > 0,
        'Slow local request did not reach the test server through the proxy.'
      );
      controller.abort(new CrawlCancellationError('cancelled'));
      await assert.rejects(slowCrawl, (error) => error.reason === 'cancelled');
      await waitFor(
        () => slowResponses.size === 0,
        'Cancellation did not close the proxied browser request.'
      );

      assert.equal(resolverCalls.includes('valid.test'), true);
      assert.equal(resolverCalls.includes('secure.test'), true);
      assert.equal(resolverCalls.includes('mismatch.test'), true);
      assert.equal(isPublicAddress(LOOPBACK), false);
      assert.equal(
        crawler.browser
          .process()
          .spawnargs.some((argument) =>
            argument.includes('ignore-certificate-errors')
          ),
        false,
        'Chromium must not be launched with certificate-verification bypass flags.'
      );
    } finally {
      for (const response of slowResponses) response.destroy();
      await crawler?.outboundProxy?.close().catch(() => {});
      await closeCrawler(crawler).catch((error) => {
        console.error(
          'Failed to close Chromium deterministically:',
          error.message
        );
      });
      await Promise.all([closeServer(httpServer), closeServer(httpsServer)]);
      try {
        removeTemporaryTestCertificate(certificate);
      } catch (error) {
        console.error(
          'Failed to remove temporary local test certificate:',
          error.message
        );
      }
      fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
  }
);
