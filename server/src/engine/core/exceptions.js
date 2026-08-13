// Migrated from backend/core/exceptions.py

/**
 * Unified error handling module.
 *
 * Design principles:
 * - Single responsibility: only defines and handles exceptions
 * - No special cases: every error has a clear HTTP status code
 * - Concise: minimum code to provide complete error handling
 *
 * Desktop version uses Chinese directly; t() returns the original Chinese key (no i18n framework dependency).
 */

// ---------------------------------------------------------------------------
// Minimal i18n: desktop version uses Chinese only, returning key as-is
// ---------------------------------------------------------------------------

/**
 * Return Chinese copy. If key contains {} placeholders, replace them sequentially with args.
 *
 * @param {string} key
 * @param {...*} args
 * @returns {string}
 */
function t(key, ...args) {
  let result = key;
  for (const arg of args) {
    result = result.replace('{}', String(arg));
  }
  return result;
}

// ---------------------------------------------------------------------------
// HTTP status constants (mapped from Python fastapi.status)
// ---------------------------------------------------------------------------
export const HTTP_STATUS = Object.freeze({
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  UNPROCESSABLE_ENTITY: 422,
  INTERNAL_SERVER_ERROR: 500,
});

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

/**
 * Base API error class (equivalent to Python BaseAPIError / HTTPException).
 *
 * Carries structured detail to match Python response format:
 * { success: false, message: string, detail: object }
 */
export class BaseAPIError extends Error {
  /**
   * @param {string} message Chinese message (key passed to t())
   * @param {number} statusCode HTTP status code
   * @param {Object} [detail={}] extra detail
   */
  constructor(message, statusCode, detail = {}) {
    const translatedMessage = t(message);
    super(translatedMessage);
    this.name = new.target.name;
    this.statusCode = statusCode;
    /** Align with Python HTTPException.detail structure */
    this.detail = {
      success: false,
      message: translatedMessage,
      detail: detail || {},
    };
  }
}

// ---------------------------------------------------------------------------
// Specific exception classes
// ---------------------------------------------------------------------------

/** Authentication error (401) */
export class AuthenticationError extends BaseAPIError {
  constructor(message = '认证失败', detail = undefined) {
    super(message, HTTP_STATUS.UNAUTHORIZED, detail);
  }
}

/** Authorization error (403) */
export class AuthorizationError extends BaseAPIError {
  constructor(message = '权限不足', detail = undefined) {
    super(message, HTTP_STATUS.FORBIDDEN, detail);
  }
}

/** Validation error (400) */
export class ValidationError extends BaseAPIError {
  constructor(message = '参数验证失败', detail = undefined) {
    super(message, HTTP_STATUS.BAD_REQUEST, detail);
  }
}

/** Not-found error (404) */
export class NotFoundError extends BaseAPIError {
  constructor(message = '资源不存在', detail = undefined) {
    super(message, HTTP_STATUS.NOT_FOUND, detail);
  }
}

/** Business logic error (422) */
export class BusinessError extends BaseAPIError {
  constructor(message = '业务逻辑错误', detail = undefined) {
    super(message, HTTP_STATUS.UNPROCESSABLE_ENTITY, detail);
  }
}

/** Server error (500) */
export class ServiceError extends BaseAPIError {
  constructor(message = '服务端错误', detail = undefined) {
    super(message, HTTP_STATUS.INTERNAL_SERVER_ERROR, detail);
  }
}

/**
 * Informational business response (validation notice, returns HTTP 200).
 *
 * Used for business rule checks; this is neither an error nor a success action.
 * Response format matches successResponse. Frontend uses _isInfoResponse to decide whether to continue.
 *
 * Usage examples:
 *   throw new BusinessInfoResponse('You are already a member of this project');
 *   throw new BusinessInfoResponse('Invitation link has expired');
 */
export class BusinessInfoResponse extends Error {
  /**
   * @param {string} [message='Business informational message']
   * @param {Object|null} [data=null]
   */
  constructor(message = '业务信息提示', data = null) {
    super(t(message));
    this.name = 'BusinessInfoResponse';
    this.response = {
      success: true,
      message: t(message),
      data: data || {},
      detail: {},
      _isInfoResponse: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Convenience factories (matches Python module-level functions)
// ---------------------------------------------------------------------------

/** Create authentication error */
export function authError(message = '认证失败', detail = undefined) {
  return new AuthenticationError(message, detail);
}

/** Create authorization error */
export function permissionError(message = '权限不足', detail = undefined) {
  return new AuthorizationError(message, detail);
}

/** Create validation error */
export function validationError(message = '参数验证失败', detail = undefined) {
  return new ValidationError(message, detail);
}

/** Create business logic error */
export function businessError(message = '业务逻辑错误', detail = undefined) {
  return new BusinessError(message, detail);
}

/** Create service error */
export function serviceError(message = '服务端错误', detail = undefined) {
  return new ServiceError(message, detail);
}
