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

   The Businesses multi-select on the user form decides WHICH books a
   user can open, and granting/revoking there is the same operation:
   re-post the form with the selection edited.

   It is not the whole story. Each business also keeps its own User
   Permissions record deciding what that user may DO inside — see
   manager-permissions.js. An earlier version of this comment claimed no
   such page existed, which is why provisioned staff could open a
   client's books and not work in them.

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

// Manager's URL query keys are NOT the same encoding as those option
// values, which is an easy and expensive thing to get wrong. They are a
// protobuf-style envelope — field tag 0x0a, then a length, then the utf8
// bytes — in unpadded base64url:
//
//   /login-password?Cgtwcm92aXNpb25lcg   -> 0a 0b "provisioner"
//   /api4/tabs?q=ogYNRGVtbyBCdXNpbmVzcw  -> a2 06 0d "Demo Business"
//
// Addressing /user-form with plain base64 does not error — it quietly
// serves a BLANK new-user form, so a read-modify-write against it reads
// an empty user and writes nonsense. Verified against Manager 26.7.10.
function managerKeyParam(value, tag) {
  const bytes = Buffer.from(String(value), 'utf8');
  if (bytes.length > 127) throw new Error('managerKeyParam: value too long to length-prefix');
  const envelope = Buffer.concat([Buffer.from([tag || 0x0a, bytes.length]), bytes]);
  return envelope.toString('base64url').replace(/=+$/, '');
}

// ── The general form of the same envelope ─────────────────────────────
// managerKeyParam above handles the single-field, low-tag case (/login,
// /api4/tabs). Business-scoped screens use several fields and tag
// numbers above 15, which need multi-byte varint keys:
//
//   /user-permissions-form?<100:business><101:referrer><200:guid><250:0>
//
// Field 250 is a DELETE flag — see the warning in manager-permissions.js.
// Nothing in this codebase should ever set it; the default of omitting it
// is deliberate, and callers follow Manager's own links for record URLs
// rather than assembling them here.
function varint(n) {
  const out = [];
  let v = n;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
}

function tag(field, wire) {
  return varint((field << 3) | wire);
}

// A .NET Guid as Manager stores it: the first three groups little-endian,
// the last eight bytes as written, then split into two fixed64 fields of
// a nested message. Getting the endianness wrong addresses a DIFFERENT
// record, which is worse than an error.
function guidMessage(uuid) {
  const hex = String(uuid).replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error('guidMessage: not a uuid: ' + uuid);
  const b = Buffer.from(hex, 'hex');
  const mixed = Buffer.concat([
    Buffer.from([b[3], b[2], b[1], b[0]]),
    Buffer.from([b[5], b[4]]),
    Buffer.from([b[7], b[6]]),
    b.slice(8),
  ]);
  return Buffer.concat([tag(1, 1), mixed.slice(0, 8), tag(2, 1), mixed.slice(8)]);
}

// parts: [{ field, string }] | [{ field, varint }] | [{ field, guid }]
function managerKey(parts) {
  const chunks = [];
  (parts || []).forEach(function (p) {
    if (typeof p.string === 'string') {
      const bytes = Buffer.from(p.string, 'utf8');
      chunks.push(tag(p.field, 2), varint(bytes.length), bytes);
    } else if (typeof p.varint === 'number') {
      chunks.push(tag(p.field, 0), varint(p.varint));
    } else if (p.guid) {
      const msg = guidMessage(p.guid);
      chunks.push(tag(p.field, 2), varint(msg.length), msg);
    } else {
      throw new Error('managerKey: field ' + p.field + ' has no value');
    }
  });
  return Buffer.concat(chunks).toString('base64url').replace(/=+$/, '');
}

// multipart/form-data. Manager's Vue-backed forms post exactly one field
// (the JSON model), but this stays general.
function encodeMultipart(fields, boundary) {
  const parts = [];
  Object.keys(fields || {}).forEach(function (k) {
    parts.push(Buffer.from(
      '--' + boundary + '\r\n'
      + 'Content-Disposition: form-data; name="' + k + '"\r\n\r\n'
      + String(fields[k]) + '\r\n', 'utf8'));
  });
  parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
  return Buffer.concat(parts);
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

  // A JSON body under any method. `headers` lets a caller add request headers
  // Manager needs beyond the JSON content type — notably `Manager-Business`,
  // which is how api4 scopes a business-data write to the right books (see
  // manager-extension.js). PUT is used for the bulk `-batch` upserts that copy
  // a chart of accounts between businesses (see manager-coa.js).
  function jsonRequest(method, path, obj, headers) {
    return raw(method, path, JSON.stringify(obj),
      Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' }, headers || {}));
  }

  function postMultipart(path, fields) {
    const boundary = '----txform' + Date.now().toString(16) + Math.random().toString(16).slice(2);
    return raw('POST', path, encodeMultipart(fields, boundary),
      { 'Content-Type': 'multipart/form-data; boundary=' + boundary });
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
  //
  // Books does NOT redirect an unauthenticated request to /login — it
  // sends it to the site root, as an ABSOLUTE url:
  //
  //   GET /user-form  ->  302  Location: http://127.0.0.1:5000/
  //
  // An earlier version only matched a relative '/login' prefix, so it
  // never recognised the real thing. The client then failed to
  // re-authenticate and reported the redirect as a mystery — a live
  // offboarding job burned all its retries on
  // "could not open the user form (http 302)" and left someone's access
  // in place, which is the one direction that must not fail quietly.
  //
  // Matched on the PATH, so the host and scheme are irrelevant.
  function isSignedOut(res) {
    if (res.status === 401) return true;
    if (res.status !== 302 || typeof res.location !== 'string') return false;
    let path;
    try {
      path = new URL(res.location, base).pathname;
    } catch (e) {
      path = res.location;
    }
    return path === '/' || path.indexOf('/login') === 0;
  }

  // Every authenticated call goes through here: run it, and if the
  // session has lapsed, log in once and run it again. Exactly one retry,
  // so bad credentials fail fast instead of looping.
  async function request(method, path, opts2) {
    const o = opts2 || {};
    const send = function () {
      if (o.json) return jsonRequest(method, path, o.json, o.headers);
      if (o.form) return postForm(path, o.form);
      if (o.multipart) return postMultipart(path, o.multipart);
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
    get: function (path, headers) { return request('GET', path, { headers: headers }); },
    postForm: function (path, fields) { return request('POST', path, { form: fields }); },
    postJson: function (path, obj, headers) { return request('POST', path, { json: obj, headers: headers }); },
    putJson: function (path, obj, headers) { return request('PUT', path, { json: obj, headers: headers }); },
    postMultipart: function (path, fields) { return request('POST', path, { multipart: fields }); },
    // exposed for tests / diagnostics only
    _jar: function () { return Object.assign({}, jar); },
    _isSignedOut: isSignedOut,
  };
}

module.exports = {
  createClient, encodeForm, mergeCookies, cookieHeader, businessOptionValue,
  managerKeyParam, managerKey, guidMessage, encodeMultipart,
};
