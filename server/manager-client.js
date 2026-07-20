/* ============================================================
   Txform.ph — server/manager-client.js

   Authenticated HTTP client for Manager Server. Zero dependencies:
   node:http / node:https only, matching the choice already made for
   smtp-mailer.js so the git-pull deploy stays install-free.

   This replaced a Playwright driver. Manager needs no browser — its
   login is an ordinary two-step form POST with no CSRF token, and
   everything the provisioner does is reachable over plain HTTP:

     POST /login                     Username         -> 302 /login-password?<enc>
     POST /login-password?<enc>      Password, Issuer -> 302 + Set-Cookie: session
     POST /api4/business             {"name"}            create books
     GET  /user-form                 (new user form)
     POST /user-form                 Name, EmailAddress, Username, Password,
                                     Type=Restricted|Administrator,
                                     Businesses=<base64(name)> (repeatable)

   Access to a business IS the Businesses multi-select on the user form.
   There is no separate permissions page, so granting and revoking are
   the same operation: re-post the form with the selection edited.

   Sessions expire. Every call goes through `request`, which detects a
   bounce back to /login and re-authenticates once before giving up, so
   callers never have to think about session lifetime.
   ============================================================ */
'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

// Manager identifies a business by NAME; the user form's option values
// are base64 of that name. Not a GUID — it has never had one.
function businessOptionValue(businessName) {
  return Buffer.from(String(businessName), 'utf8').toString('base64');
}

// application/x-www-form-urlencoded. Array values repeat the key, which
// is how a multi-select submits — that's what carries Businesses.
function encodeForm(fields) {
  const parts = [];
  Object.keys(fields || {}).forEach(function (k) {
    const v = fields[k];
    if (v === undefined || v === null) return;
    const list = Array.isArray(v) ? v : [v];
    list.forEach(function (item) {
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(String(item)));
    });
  });
  return parts.join('&');
}

// Keep only the name=value of each Set-Cookie, joined for the Cookie header.
function mergeCookies(existing, setCookieHeaders) {
  const jar = Object.assign({}, existing);
  (setCookieHeaders || []).forEach(function (line) {
    const pair = String(line).split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });
  return jar;
}

function cookieHeader(jar) {
  return Object.keys(jar).map(function (k) { return k + '=' + jar[k]; }).join('; ');
}

function createClient(opts) {
  const base = new URL(opts.baseUrl);
  const transport = base.protocol === 'https:' ? https : http;
  const username = opts.username;
  const password = opts.password;
  const timeoutMs = opts.timeoutMs || 20000;
  let jar = {};

  // One raw request. Never follows redirects — the 302 Location is
  // meaningful here (it is how the login flow advances, and how a dead
  // session announces itself), so callers inspect it themselves.
  function raw(method, path, body, headers) {
    return new Promise(function (resolve, reject) {
      const url = new URL(path, base);
      const req = transport.request({
        method: method,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        headers: Object.assign({
          'Cookie': cookieHeader(jar),
          'Content-Length': body ? Buffer.byteLength(body) : 0,
        }, headers || {}),
        timeout: timeoutMs,
      }, function (res) {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', function (c) { data += c; });
        res.on('end', function () {
          jar = mergeCookies(jar, res.headers['set-cookie']);
          resolve({ status: res.statusCode, location: res.headers.location || null, body: data });
        });
      });
      req.on('timeout', function () { req.destroy(new Error('Manager request timed out after ' + timeoutMs + 'ms')); });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  function postForm(path, fields) {
    return raw('POST', path, encodeForm(fields), { 'Content-Type': 'application/x-www-form-urlencoded' });
  }

  function postJson(path, obj) {
    return raw('POST', path, JSON.stringify(obj), { 'Content-Type': 'application/json', 'Accept': 'application/json' });
  }

  // Two-step login. The username step returns a 302 whose Location
  // carries the encoded username; the password step must go there.
  async function login() {
    jar = {};
    await raw('GET', '/login', null, null);

    const step1 = await postForm('/login', { Username: username });
    if (!step1.location || step1.location.indexOf('/login-password') === -1) {
      throw new Error('Manager login rejected the username (no password step offered)');
    }

    const step2 = await postForm(step1.location, { Password: password, Issuer: '' });
    // A failed password bounces back to /login rather than erroring, so
    // check where we landed — not merely that we got a 302.
    if (!jar.session || (step2.location && step2.location.indexOf('/login') === 0)) {
      throw new Error('Manager login failed — check MANAGER_ADMIN_USER / MANAGER_ADMIN_PASS');
    }
    return true;
  }

  // Did this response mean "your session is gone"?
  function isSignedOut(res) {
    if (res.status === 401) return true;
    return res.status === 302 && typeof res.location === 'string' && res.location.indexOf('/login') === 0;
  }

  // Every authenticated call goes through here: run it, and if the
  // session has lapsed, log in once and run it again. Exactly one retry,
  // so bad credentials fail fast instead of looping.
  async function request(method, path, opts2) {
    const o = opts2 || {};
    const send = function () {
      if (o.json) return postJson(path, o.json);
      if (o.form) return postForm(path, o.form);
      return raw(method, path, null, o.headers);
    };

    if (!jar.session) await login();
    let res = await send();
    if (isSignedOut(res)) {
      await login();
      res = await send();
      if (isSignedOut(res)) throw new Error('Manager rejected the session twice for ' + method + ' ' + path);
    }
    return res;
  }

  return {
    login: login,
    request: request,
    get: function (path) { return request('GET', path, {}); },
    postForm: function (path, fields) { return request('POST', path, { form: fields }); },
    postJson: function (path, obj) { return request('POST', path, { json: obj }); },
    // exposed for tests / diagnostics only
    _jar: function () { return Object.assign({}, jar); },
  };
}

module.exports = { createClient, encodeForm, mergeCookies, cookieHeader, businessOptionValue };
