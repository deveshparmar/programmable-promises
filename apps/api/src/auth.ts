import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { hashToken, tokensMatch } from "./money.js";
import { findPromiseById, findUserByEmail, findUserById } from "./repos/promises.js";
import type { PromiseRow, UserRow } from "./repos/promises.js";

export interface AuthPayload {
  sub: string;
  email: string;
}

export function signUser(user: UserRow): string {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, { expiresIn: "12h" });
}

export async function login(email: string): Promise<{ token: string; email: string; name: string }> {
  const user = await findUserByEmail(email.toLowerCase());
  if (!user) throw new HttpError(401, "UNKNOWN_PAYER", "That email is not a demo payer.");
  return { token: signUser(user), email: user.email, name: user.name };
}

function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const query = req.query.access_token;
  return typeof query === "string" ? query : undefined;
}

function readJwt(req: Request): AuthPayload | undefined {
  const token = bearerToken(req);
  if (!token) return undefined;
  try {
    const payload = jwt.verify(token, config.jwtSecret) as AuthPayload;
    if (!payload.sub) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export function shareTokenFrom(req: Request): string | undefined {
  const header = req.header("x-share-token")?.trim();
  if (header) return header;
  const query = req.query.token;
  return typeof query === "string" ? query : undefined;
}

export async function requirePayer(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = readJwt(req);
    if (!payload) throw new HttpError(401, "UNAUTHORIZED", "Sign in as a payer.");
    const user = await findUserById(payload.sub);
    if (!user) throw new HttpError(401, "UNAUTHORIZED", "Sign in as a payer.");
    req.payer = user;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requirePayerOrToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const payload = readJwt(req);
    if (payload) {
      const user = await findUserById(payload.sub);
      if (user) {
        req.payer = user;
        next();
        return;
      }
    }
    const token = shareTokenFrom(req);
    if (!token) throw new HttpError(401, "UNAUTHORIZED", "Sign in or open the worker link.");
    const promise = await loadByToken(req.params.id, token);
    req.promiseAuth = promise;
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireToken(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const token = shareTokenFrom(req);
    if (!token) throw new HttpError(401, "UNAUTHORIZED", "This page needs the worker link.");
    req.promiseAuth = await loadByToken(req.params.id, token);
    next();
  } catch (error) {
    next(error);
  }
}

async function loadByToken(id: string, token: string): Promise<PromiseRow> {
  const promise = await findPromiseById(id);
  if (!promise || promise.deadline_at.getTime() < Date.now()) {
    throw new HttpError(401, "UNAUTHORIZED", "This worker link is invalid or expired.");
  }
  if (!tokensMatch(hashToken(token), promise.share_token_hash)) {
    throw new HttpError(401, "UNAUTHORIZED", "This worker link is invalid or expired.");
  }
  return promise;
}

declare global {
  namespace Express {
    interface Request {
      payer?: UserRow;
      promiseAuth?: PromiseRow;
    }
  }
}
