import { SignJWT } from 'jose';
import { nanoid } from 'nanoid';
import { config } from '../config.js';

/**
 * Shared JWT primitives used across the auth system (session cookies for the
 * single shared cloud-hosted/local-mode identity, agent tokens, cloud-callback
 * relay tokens). Split out from the old github.js OAuth module so these
 * survive OAuth removal.
 */

export function getSecretKey() {
  return new TextEncoder().encode(config.jwt.secret);
}

export async function issueAccessToken(user) {
  return new SignJWT({
    sub: user.id,
    github_login: user.github_login,
    tier: user.tier,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.jwt.userTtl)
    .setJti(nanoid())
    .sign(getSecretKey());
}

export async function issueRefreshToken(user) {
  return new SignJWT({
    sub: user.id,
    type: 'refresh',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(config.jwt.refreshTtl)
    .setJti(nanoid())
    .sign(getSecretKey());
}

export function setAuthCookies(res, accessToken, refreshToken) {
  const isProduction = config.nodeEnv === 'production';
  const cookieOpts = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  };

  res.cookie('tc_access', accessToken, {
    ...cookieOpts,
    maxAge: 60 * 60 * 1000, // 1 hour
  });

  res.cookie('tc_refresh', refreshToken, {
    ...cookieOpts,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

export function clearAuthCookies(res) {
  res.clearCookie('tc_access', { path: '/' });
  res.clearCookie('tc_refresh', { path: '/' });
}
