// Use-case layer standard error: throw new ApiError(msg, status), and transport layer wraps it as fail envelope.
// Replaces legacy handler pattern: return fail(res, msg, status).
export class ApiError extends Error {
  constructor(message, status = 400, code = status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
