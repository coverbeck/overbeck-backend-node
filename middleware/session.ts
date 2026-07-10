import { createHmac, timingSafeEqual } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const SESSION_COOKIE_NAME = 'session';
const SESSION_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function expectedSessionValue(): string | undefined {
  const authUser = process.env.AUTH_USER;
  const sessionSecret = process.env.SESSION_SECRET;
  if (!authUser || !sessionSecret) return undefined;
  return createHmac('sha256', sessionSecret).update(authUser).digest('hex');
}

function parseCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    if (part.slice(0, separatorIndex).trim() === name) {
      return decodeURIComponent(part.slice(separatorIndex + 1).trim());
    }
  }
  return undefined;
}

function hasValidSession(req: Request): boolean {
  const expected = expectedSessionValue();
  const actual = parseCookie(req, SESSION_COOKIE_NAME);
  if (!expected || !actual) return false;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(actual);
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export function verifyLogin(username: string, password: string): boolean {
  const authUser = process.env.AUTH_USER;
  const authPass = process.env.AUTH_PASS;
  return Boolean(authUser) && Boolean(authPass) && username === authUser && password === authPass;
}

export function setSessionCookie(res: Response) {
  const value = expectedSessionValue();
  if (!value) return;
  res.cookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

export function requireSession(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'no-store');

  if (!process.env.AUTH_USER || !process.env.SESSION_SECRET) {
    res.status(500).send('Server auth is not configured');
    return;
  }

  if (hasValidSession(req)) {
    next();
    return;
  }

  res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
}
