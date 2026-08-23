import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateHost } from '../src/updater.js';

/**
 * The updater downloads a tarball, extracts it and runs it, so refusing plain
 * HTTP from a public host is worth doing: a network attacker who can rewrite
 * that download owns the machine.
 *
 * The reason this predicate has to be generous is that plain HTTP is a
 * first-class configuration here, not a mistake. The installer emits ws:// for
 * any non-secure request (cloud/src/routes/download.js), start.sh prompts for a
 * cloud URL using ws://192.168.1.10:1071 as its example, and 49-agent.js builds
 * ws://host:port. A check that only exempted localhost would leave every
 * LAN-hosted agent permanently unable to update itself — which is why these
 * cases are pinned rather than left to judgement.
 */

test('loopback is private', () => {
  for (const h of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('the RFC1918 ranges are private', () => {
  for (const h of ['10.0.0.1', '10.255.255.255', '192.168.1.10', '192.168.0.1', '172.16.0.1', '172.31.255.254']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('the edges of 172.16.0.0/12 are handled', () => {
  // The range is 172.16–172.31, not all of 172.
  assert.equal(isPrivateHost('172.16.0.1'), true);
  assert.equal(isPrivateHost('172.31.0.1'), true);
  assert.equal(isPrivateHost('172.15.0.1'), false);
  assert.equal(isPrivateHost('172.32.0.1'), false);
  assert.equal(isPrivateHost('172.0.0.1'), false);
});

test('link-local addresses are private', () => {
  assert.equal(isPrivateHost('169.254.1.1'), true);
  assert.equal(isPrivateHost('fe80::1'), true);
});

test('IPv6 unique-local addresses are private', () => {
  assert.equal(isPrivateHost('fc00::1'), true);
  assert.equal(isPrivateHost('fd12:3456::1'), true);
  // Brackets survive from a URL host in some forms and must not defeat the match.
  assert.equal(isPrivateHost('[::1]'), true);
});

test('mDNS and private suffixes are private', () => {
  for (const h of ['myserver.local', 'nas.internal', 'box.lan', 'thing.home.arpa']) {
    assert.equal(isPrivateHost(h), true, h);
  }
});

test('a single-label hostname is private', () => {
  // No public TLD to resolve against, so it can only come from local DNS or
  // mDNS. 'ws://myserver:1071' is a configuration people actually use.
  assert.equal(isPrivateHost('myserver'), true);
  assert.equal(isPrivateHost('build-box'), true);
});

test('public hosts are not private', () => {
  for (const h of ['49agents.com', 'cloud.49agents.com', 'example.co.uk', '8.8.8.8', '1.1.1.1', '203.0.113.5']) {
    assert.equal(isPrivateHost(h), false, h);
  }
});

test('a public host dressed up to look private is still public', () => {
  // The suffix check has to be anchored, or an attacker-controlled domain
  // ending in something that merely contains '.local' would be exempted.
  assert.equal(isPrivateHost('local.example.com'), false);
  assert.equal(isPrivateHost('notlocal.com'), false);
  assert.equal(isPrivateHost('192.168.1.10.example.com'), false);
  assert.equal(isPrivateHost('evil.com.local.attacker.net'), false);
});

test('absent or empty input is not private', () => {
  // Fail closed: an unparseable host must require HTTPS rather than be waved
  // through as local.
  assert.equal(isPrivateHost(''), false);
  assert.equal(isPrivateHost(null), false);
  assert.equal(isPrivateHost(undefined), false);
});
