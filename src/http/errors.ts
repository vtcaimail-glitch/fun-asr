export type ErrorBody = {
  status: "error";
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function toErrorBody(error: HttpError): ErrorBody {
  return {
    status: "error",
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  };
}

