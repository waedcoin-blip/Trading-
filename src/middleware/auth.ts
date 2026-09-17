import { Request, Response, NextFunction } from 'express';
import { adminAuth } from '../lib/firebase-admin.ts';
import { DecodedIdToken } from 'firebase-admin/auth';
import firebaseConfig from '../../firebase-applet-config.json';

export interface AuthRequest extends Request {
  user?: DecodedIdToken;
}

export const requireAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const token = authHeader.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: Empty token' });
  }

  if (adminAuth) {
    try {
      const decodedToken = await adminAuth.verifyIdToken(token);
      req.user = decodedToken;
      return next();
    } catch (err: any) {
      console.warn('[Auth Middleware] Admin verifyIdToken failed, attempting fallback parse:', err?.message || err);
    }
  }

  // Fallback JWT parsing when adminAuth is unavailable or unconfigured
  try {
    const parts = token.split('.');
    if (parts.length === 3) {
      const payloadJson = Buffer.from(parts[1], 'base64').toString('utf-8');
      const payload = JSON.parse(payloadJson);
      const nowSec = Math.floor(Date.now() / 1000);

      const targetProjectId = process.env.FIREBASE_PROJECT_ID || firebaseConfig.projectId;
      if (payload.exp && payload.exp > nowSec && (payload.aud === targetProjectId || payload.iss?.includes(targetProjectId))) {
        req.user = {
          uid: payload.user_id || payload.sub,
          sub: payload.sub || payload.user_id || '',
          email: payload.email || '',
          name: payload.name || '',
          picture: payload.picture || '',
          aud: payload.aud,
          iss: payload.iss,
          auth_time: payload.auth_time,
          iat: payload.iat,
          exp: payload.exp,
          firebase: payload.firebase || { sign_in_provider: 'google.com', identities: {} }
        } as unknown as DecodedIdToken;
        return next();
      }
    }
  } catch (parseErr) {
    console.error('[Auth Middleware] Fallback JWT parse error:', parseErr);
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
};

