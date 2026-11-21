import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown;
}

export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void => {
  const statusCode = err.statusCode ?? 500;
  const code = err.code ?? 'INTERNAL_ERROR';

  // Mongoose validation error
  if (err instanceof mongoose.Error.ValidationError) {
    res.status(400).json({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: Object.values(err.errors).map((e) => ({
        field: e.path,
        message: e.message,
      })),
    });
    return;
  }

  // Mongoose duplicate key error
  if ((err as NodeJS.ErrnoException).name === 'MongoServerError' && (err as { code?: number }).code === 11000) {
    res.status(409).json({
      code: 'DUPLICATE_KEY',
      message: 'A record with this value already exists',
      details: (err as { keyValue?: unknown }).keyValue,
    });
    return;
  }

  // Log stack in dev
  if (env.NODE_ENV === 'development') {
    console.error('💥 Error:', err.stack);
  } else {
    console.error(`Error [${code}]:`, err.message);
  }

  res.status(statusCode).json({
    code,
    message: err.message || 'An unexpected error occurred',
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
    ...(err.details !== undefined && { details: err.details }),
  });
};

// Factory for creating AppErrors
export const createError = (
  statusCode: number,
  message: string,
  code?: string,
  details?: unknown,
): AppError => {
  const err: AppError = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  err.details = details;
  return err;
};
