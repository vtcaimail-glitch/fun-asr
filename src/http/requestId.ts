import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const existing = req.header("x-request-id");
  const requestId = existing && existing.trim() ? existing : crypto.randomUUID();
  res.setHeader("x-request-id", requestId);
  (req as unknown as { requestId: string }).requestId = requestId;
  next();
}

export function getRequestId(req: Request): string {
  return (req as unknown as { requestId?: string }).requestId ?? "unknown";
}

