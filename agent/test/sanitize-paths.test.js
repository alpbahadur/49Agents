import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'path';
import { realpathSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { validateWorkingDirectory } from '../services/sanitize.js';

/**
 * validateWorkingDirectory used to prefix-match the string it was handed
 * without normalising it, so a path that started inside a permitted root and
 * then climbed out passed the check. It now resolves first.
 *
 * Callers that already called resolve() themselves were safe; the ones that did
 * not were the vulnerability. Creating and resuming a tmux session passes a
 * client-supplied working directory straight through (services/tmux.js:371 and
 * :404) and uses the return value as the session's directory, so a traversal
 * path landed a shell outside the boundary.
 */

const HOME = process.env.HOME;
// The validator canonicalises, so expectations have to be canonical too. On
// macOS /tmp is a symlink to /private/tmp; on Linux these are the same string.
const TMP = realpathSync('/tmp');
const REAL_HOME = realpathSync(HOME);

test('a path climbing out of a permitted root is refused', () => {
  // The vulnerability, in the forms it actually takes.
  assert.throws(() => validateWorkingDirectory('/tmp/../etc/shadow'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/tmp/../../etc'), /not allowed/);
  assert.throws(() => validateWorkingDirectory(`${HOME}/../../etc/passwd`), /not allowed/);
  assert.throws(() => validateWorkingDirectory('~/../../etc/passwd'), /not allowed/);
  // Dressed up with a redundant segment, which a naive check on '..' misses.
  assert.throws(() => validateWorkingDirectory('/tmp/./sub/../../etc'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/tmp/a/b/../../../etc'), /not allowed/);
});

test('traversal that lands back inside a root is allowed and normalised', () => {
  // Refusing on the presence of '..' would reject this, which is legitimate.
  assert.equal(validateWorkingDirectory('/tmp/./sub/../ok'), `${TMP}/ok`);
  assert.equal(validateWorkingDirectory('/tmp/a/b/../..'), TMP);
  assert.equal(validateWorkingDirectory(`${HOME}/projects/../projects`), `${REAL_HOME}/projects`);
});

test('an ordinary absolute path inside a root is returned normalised', () => {
  assert.equal(validateWorkingDirectory('/tmp'), TMP);
  assert.equal(validateWorkingDirectory('/tmp/'), TMP);
  assert.equal(validateWorkingDirectory('/tmp//double//slash'), `${TMP}/double/slash`);
  assert.equal(validateWorkingDirectory(HOME), REAL_HOME);
  assert.equal(validateWorkingDirectory(`${HOME}/projects`), `${REAL_HOME}/projects`);
});

test('a root is accepted under its canonical name as well as its own', () => {
  // On macOS /tmp is a symlink to /private/tmp: the same directory under two
  // names, which used to be accepted under one and refused under the other.
  assert.equal(validateWorkingDirectory(`${TMP}/thing`), `${TMP}/thing`);
  assert.equal(validateWorkingDirectory('/tmp/thing'), `${TMP}/thing`);
});

test('a leading tilde expands to home', () => {
  assert.equal(validateWorkingDirectory('~'), REAL_HOME);
  assert.equal(validateWorkingDirectory('~/'), REAL_HOME);
  assert.equal(validateWorkingDirectory('~/projects/x'), `${REAL_HOME}/projects/x`);
});

test('a tilde that is not a home reference stays literal', () => {
  // The old implementation used replace('~', home) with no anchor, so it would
  // rewrite a tilde anywhere in the string — including inside a filename.
  const dir = validateWorkingDirectory(`${HOME}/back~ups`);
  assert.equal(dir, `${REAL_HOME}/back~ups`);
  assert.ok(!dir.includes(HOME + HOME), 'home must not be substituted mid-path');

  // A directory literally named '~foo' is not a home reference either.
  assert.throws(() => validateWorkingDirectory('~foo/bar'), /not allowed/);
});

test('a path outside every permitted root is refused', () => {
  assert.throws(() => validateWorkingDirectory('/etc'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/etc/passwd'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/usr/local/bin'), /not allowed/);
});

test('a sibling directory that merely shares a prefix is refused', () => {
  // '/tmpfoo' starts with '/tmp' as a string but is a different directory, so
  // the check has to be on path segments rather than raw prefixes.
  assert.throws(() => validateWorkingDirectory('/tmpfoo'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('/tmp-other/x'), /not allowed/);
  assert.throws(() => validateWorkingDirectory(`${HOME}-evil/x`), /not allowed/);
});

test('a relative path is refused rather than resolved', () => {
  // Resolving would be against the agent's own working directory, which a
  // caller cannot reason about — and would turn 'foo' from a refusal into an
  // accept whenever the agent happened to run under the user's home.
  assert.throws(() => validateWorkingDirectory('foo'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('./foo'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('../foo'), /not allowed/);
  assert.throws(() => validateWorkingDirectory('projects/thing'), /not allowed/);
});

test('a non-string or empty path is refused', () => {
  // createTerminal defaults to '~', but nothing stops a malformed request.
  assert.throws(() => validateWorkingDirectory(''), /not allowed/);
  assert.throws(() => validateWorkingDirectory(null), /not allowed/);
  assert.throws(() => validateWorkingDirectory(undefined), /not allowed/);
  assert.throws(() => validateWorkingDirectory(42), /not allowed/);
  assert.throws(() => validateWorkingDirectory({}), /not allowed/);
});

test('the error names the path the caller gave, not the resolved one', () => {
  // The caller needs to recognise what it asked for in the message.
  try {
    validateWorkingDirectory('/tmp/../etc/shadow');
    assert.fail('should have thrown');
  } catch (e) {
    assert.match(e.message, /\/tmp\/\.\.\/etc\/shadow/);
  }
});

test('a symlink pointing out of a permitted root is refused', () => {
  // The escape the boundary would otherwise leave open: a link inside home or
  // /tmp granting access to whatever it points at.
  const dir = realpathSync(mkdtempSync(join('/tmp', 'sanitize-link-')));
  try {
    symlinkSync('/etc', join(dir, 'escape'));
    assert.throws(() => validateWorkingDirectory(join(dir, 'escape')), /not allowed/);
    assert.throws(() => validateWorkingDirectory(join(dir, 'escape', 'passwd')), /not allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a symlink pointing within a permitted root is followed and allowed', () => {
  const dir = realpathSync(mkdtempSync(join('/tmp', 'sanitize-link-')));
  try {
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'inside'));
    // Resolved to the target rather than left as the link.
    assert.equal(validateWorkingDirectory(join(dir, 'inside')), join(dir, 'real'));
    assert.equal(validateWorkingDirectory(join(dir, 'inside', 'f.txt')), join(dir, 'real', 'f.txt'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a path that does not exist yet is still checked', () => {
  // An upload destination or a directory about to be created. realpath fails
  // outright on these, so the nearest existing ancestor is canonicalised and
  // the missing tail appended.
  const dir = realpathSync(mkdtempSync(join('/tmp', 'sanitize-missing-')));
  try {
    assert.equal(
      validateWorkingDirectory(join(dir, 'no', 'such', 'dir', 'file.txt')),
      join(dir, 'no', 'such', 'dir', 'file.txt'),
    );
    // And a missing tail cannot be used to slip past the boundary.
    assert.throws(() => validateWorkingDirectory(join(dir, 'a', '..', '..', '..', 'etc')), /not allowed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing tail under a symlink that escapes is refused', () => {
  // The combination: the tail does not exist, and the part that does is a link
  // out of the boundary.
  const dir = realpathSync(mkdtempSync(join('/tmp', 'sanitize-link-')));
  try {
    symlinkSync('/etc', join(dir, 'escape'));
    assert.throws(
      () => validateWorkingDirectory(join(dir, 'escape', 'nope', 'file.txt')),
      /not allowed/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validating an already-resolved path is idempotent', () => {
  // Most callers resolve before calling, and several call it on paths that came
  // back from an earlier validation. Doing it twice must not change anything.
  const once = validateWorkingDirectory(`${REAL_HOME}/projects/x`);
  assert.equal(validateWorkingDirectory(once), once);
  assert.equal(validateWorkingDirectory(resolve(once)), once);
});

test('the return value is safe to use as a working directory', () => {
  // tmux passes this straight to `new-session -c`, so it has to be absolute
  // and free of traversal segments.
  for (const input of ['~', '~/projects', '/tmp/a/b/../c', `${HOME}//x`]) {
    const out = validateWorkingDirectory(input);
    assert.ok(out.startsWith('/'), `${input} -> ${out} must be absolute`);
    assert.ok(!out.includes('/../'), `${input} -> ${out} must be normalised`);
    assert.ok(!out.endsWith('/..'), `${input} -> ${out} must be normalised`);
    assert.ok(!out.includes('//'), `${input} -> ${out} must be normalised`);
  }
});
