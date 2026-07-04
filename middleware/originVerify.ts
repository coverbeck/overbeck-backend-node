import type { NextFunction, Request, Response } from 'express';

export function requireOriginSecret(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.ORIGIN_VERIFY_SECRET;
  if (!secret) {
    next();
    return;
  }

  if (req.headers['x-origin-verify'] === secret) {
    next();
    return;
  }

  res.status(403).send('Forbidden');
}
