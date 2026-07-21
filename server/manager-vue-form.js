/* ============================================================
   Txform.ph — server/manager-vue-form.js

   The machinery shared by every Vue-backed screen in Manager Server.
   Two of them matter to the provisioner so far — User Permissions and
   Tabs — and they work identically:

     GET  the page       → the state is a JS literal, not form fields
     parseVueModel()     → that literal as an object
     mutate it
     POST it back        → multipart, one field, MODEL_FIELD, JSON

   These pages have NO name attributes on their inputs. Everything is
   `v-model`-bound, and htmx-extensions/form.js swaps the placeholder in
   the single hidden field for JSON.stringify(app.$data) at submit time.
   So there is nothing to scrape into a urlencoded post, and a partial
   post is not possible — Manager takes what arrives as the record's
   COMPLETE new state. Always read, mutate, write back whole.

   ── The URL hazard, once, for both callers ──
   Manager addresses these records with a protobuf-style envelope where
   field 250 is a destructive flag. On the permissions form it is Delete;
   on the tabs form it is Reset. Either way the safe URL and the
   destructive one differ by a single bit:

     Update  …EfLQDwA     (250 = 0)
     Reset   …EfLQDwE     (250 = 1)

   Nothing in this codebase constructs that field. Callers build the
   simplest possible key (the business name alone) and then FOLLOW
   Manager's own hrefs, which already carry a correct, flag-zero
   envelope. See managerKey in manager-client.js.
   ============================================================ */
'use strict';

// The one multipart field these forms post. Hardcoded in Manager's own
// resources/htmx-extensions/form.js — a fixed constant, not a per-render
// nonce. Verified by reading that file on 26.7.10.3654.
const MODEL_FIELD = 'febb4049-dcdb-4c7a-a395-4b71da72a85b';

// Manager writes some hrefs as `href ="..."` — note the space before the
// equals. Match loosely rather than on the exact attribute spelling.
function findHref(html, pathPrefix) {
  const re = /href\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    if (m[1].indexOf(pathPrefix) === 0) return m[1];
  }
  return null;
}

// Pull the model out of `app = new Vue({ ... data: {...}, methods:`.
//
// Brace-counted and string-aware rather than regex-matched. The models
// legitimately contain `{}` (Namespaces on the permissions form) and the
// business name may contain anything at all. A non-greedy regex stops at
// the first `}` and returns a TRUNCATED object — which would then be
// posted back as the record's complete new state, silently blanking
// every field that fell off the end.
function parseVueModel(html) {
  const anchor = /new\s+Vue\s*\(\s*\{[\s\S]*?\bdata\s*:\s*\{/.exec(html || '');
  if (!anchor) throw new Error('no Vue model found on the form');
  const start = anchor.index + anchor[0].length - 1;   // at the opening '{'
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (e) {
          throw new Error('could not parse the form model: ' + e.message);
        }
      }
    }
  }
  throw new Error('form model is truncated (unbalanced braces)');
}

// The body of a submit: one field, the whole model, as JSON.
function modelPayload(model) {
  return { [MODEL_FIELD]: JSON.stringify(model) };
}

module.exports = { MODEL_FIELD, findHref, parseVueModel, modelPayload };
