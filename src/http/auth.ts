import type { Request, Response, NextFunction } from "express";
import { config } from "../config";
import { HttpError } from "./errors";

export function bearerAuth(req: Request, _res: Response, next: NextFunction) {
  if (!config.requireAuth) return next();

  const header = req.header("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  if (!token) return next(new HttpError(401, "unauthorized", "Missing Bearer token"));
  if (token !== config.bearerToken) return next(new HttpError(403, "forbidden", "Invalid token"));
  next();
}

