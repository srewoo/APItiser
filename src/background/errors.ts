export type ErrorStage = 'scan' | 'parse' | 'generation' | 'validation' | 'packaging' | 'download';

interface BaseErrorContext {
  stage: ErrorStage;
  contextId?: string;
  repo?: string;
}

export interface ScanErrorContext extends BaseErrorContext {
  stage: 'scan';
}

export interface ParseErrorContext extends BaseErrorContext {
  stage: 'parse';
}

export interface GenerationErrorContext extends BaseErrorContext {
  stage: 'generation';
  endpointId?: string;
  batchIndex?: number;
  provider?: string;
}

export interface ValidationErrorContext extends BaseErrorContext {
  stage: 'validation';
  endpointId?: string;
  testTitle?: string;
}

export interface PackagingErrorContext extends BaseErrorContext {
  stage: 'packaging';
}

export interface DownloadErrorContext extends BaseErrorContext {
  stage: 'download';
  artifactId?: string;
}

export type ErrorContext =
  | ScanErrorContext
  | ParseErrorContext
  | GenerationErrorContext
  | ValidationErrorContext
  | PackagingErrorContext
  | DownloadErrorContext;

export class ScanError extends Error {
  readonly context: ScanErrorContext;
  constructor(message: string, context: Omit<ScanErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'ScanError';
    this.context = { ...context, stage: 'scan' };
  }
}

export class ParseError extends Error {
  readonly context: ParseErrorContext;
  constructor(message: string, context: Omit<ParseErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'ParseError';
    this.context = { ...context, stage: 'parse' };
  }
}

export class GenerationError extends Error {
  readonly context: GenerationErrorContext;
  constructor(message: string, context: Omit<GenerationErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'GenerationError';
    this.context = { ...context, stage: 'generation' };
  }
}

export class ValidationError extends Error {
  readonly context: ValidationErrorContext;
  constructor(message: string, context: Omit<ValidationErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'ValidationError';
    this.context = { ...context, stage: 'validation' };
  }
}

export class PackagingError extends Error {
  readonly context: PackagingErrorContext;
  constructor(message: string, context: Omit<PackagingErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'PackagingError';
    this.context = { ...context, stage: 'packaging' };
  }
}

export class DownloadError extends Error {
  readonly context: DownloadErrorContext;
  constructor(message: string, context: Omit<DownloadErrorContext, 'stage'> = {}) {
    super(message);
    this.name = 'DownloadError';
    this.context = { ...context, stage: 'download' };
  }
}

export const isApitiserError = (error: unknown): error is ScanError | ParseError | GenerationError | ValidationError | PackagingError | DownloadError =>
  error instanceof ScanError
  || error instanceof ParseError
  || error instanceof GenerationError
  || error instanceof ValidationError
  || error instanceof PackagingError
  || error instanceof DownloadError;
