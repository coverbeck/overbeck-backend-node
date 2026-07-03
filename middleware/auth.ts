import type { NextFunction, Request, Response } from 'express';

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authUser = process.env.AUTH_USER;
  const authPass = process.env.AUTH_PASS;
  if (!authUser || !authPass) {
    res.status(500).send('Server auth is not configured');
    return;
  }

  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);
    if (user === authUser && pass === authPass) {
      next();
      return;
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="overbeck"');
  res.status(401).send('Unauthorized');
}
