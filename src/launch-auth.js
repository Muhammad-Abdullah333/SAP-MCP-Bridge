'use strict';
// How a window or browser tab gets access to the manager's API.
//
// The page itself carries no secret: anything that can open the local address (another
// program, or another user on a shared Windows server) would otherwise receive it. Access
// starts from the launch key instead, a random value kept only in manager.lock in the
// user's own data folder. Whoever opens the manager (the desktop window, the browser
// launcher, a second click on the icon) signs a one-time launch code with that key; the
// manager accepts the code once, within a minute, and answers with an HttpOnly, same-site
// session cookie. Every API call needs that cookie plus a request header that a page from
// another site cannot send without the manager's consent, which it never gives.
const crypto = require('crypto');

const LAUNCH_ROUTE = '/launch';
const COOKIE = 'bridge_session';
const REQUEST_HEADER = 'x-bridge-request';
const CODE_LIFETIME_MS = 60 * 1000;

const sign = (key, nonce) => crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(nonce).digest('hex');

/** A one-time address that opens the manager at baseUrl, signed with the launch key. */
function launchUrl(baseUrl, launchKey, now = Date.now()) {
  const nonce = `${now.toString(36)}.${crypto.randomBytes(16).toString('hex')}`;
  const url = new URL(LAUNCH_ROUTE, baseUrl);
  url.searchParams.set('n', nonce);
  url.searchParams.set('c', sign(launchKey, nonce));
  return url.toString();
}

function equalHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function createLaunchAuth({ now = () => Date.now() } = {}) {
  const launchKey = crypto.randomBytes(32).toString('hex');
  const sessions = new Set();
  const used = new Map();

  function forget(time) {
    for (const [nonce, at] of used) if (time - at > 2 * CODE_LIFETIME_MS) used.delete(nonce);
  }

  return {
    launchKey,
    /** A session id for a valid, unused, fresh launch code; undefined otherwise. */
    redeem(nonce, code) {
      const time = now();
      forget(time);
      if (typeof nonce !== 'string' || typeof code !== 'string' || nonce.length > 200) return undefined;
      const issued = parseInt(nonce.split('.')[0], 36);
      if (!Number.isFinite(issued) || time - issued > CODE_LIFETIME_MS || issued - time > 5000) return undefined;
      if (used.has(nonce) || !equalHex(sign(launchKey, nonce), code)) return undefined;
      used.set(nonce, time);
      const session = crypto.randomBytes(32).toString('hex');
      sessions.add(session);
      return session;
    },
    /** Set-Cookie header value for a session. */
    cookie(session) {
      return `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`;
    },
    /** True when the request carries a live session cookie and the request header. */
    authorised(req) {
      if (req.headers[REQUEST_HEADER] !== '1') return false;
      const session = cookieValue(req.headers.cookie, COOKIE);
      return Boolean(session) && sessions.has(session);
    },
    /** True when the request carries a live session cookie (page loads, no header). */
    hasSession(req) {
      const session = cookieValue(req.headers.cookie, COOKIE);
      return Boolean(session) && sessions.has(session);
    },
  };
}

module.exports = { LAUNCH_ROUTE, REQUEST_HEADER, COOKIE, createLaunchAuth, launchUrl };
