import type { Problem } from './types.ts';

export type XyteProblem = Required<Pick<Problem, 'type' | 'status' | 'title'>> & {
  detail?: string;
};

/**
 * A Zyte API error response (RFC 7807 problem). `status` and `type` use the values Zyte uses
 * (https://docs.zyte.com/zyte-api/usage/errors.html), so code written against Zyte keeps working.
 */
export class XyteError extends Error {
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail?: string;

  constructor(problem: XyteProblem, options?: { cause?: unknown }) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title, options);
    this.name = 'XyteError';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
  }

  /** Worth retrying later, the same way Zyte's own clients retry. */
  get retryable(): boolean {
    return this.status === 429 || this.status === 503 || this.status === 520 || this.status === 500;
  }

  toJSON(): XyteProblem {
    return { type: this.type, status: this.status, title: this.title, detail: this.detail };
  }
}

export const invalidRequest = (detail: string): XyteError =>
  new XyteError({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail });

/**
 * A retryable failure an upstream Zyte-compatible API answered with its own problem (a 520 ban,
 * a 429). Retried like any download error; if it is the last one, that problem is returned as is.
 */
export class UpstreamProblem extends Error {
  override name = 'UpstreamProblem';
  readonly problem: XyteProblem;

  constructor(problem: XyteProblem) {
    super(`${problem.status} ${problem.type}${problem.detail ? `: ${problem.detail}` : ''}`);
    this.problem = problem;
  }
}

/** A well-formed request whose parameters can't be combined (or that asks for nothing): Zyte's 422. */
export const unprocessable = (detail: string): XyteError =>
  new XyteError({ status: 422, type: '/request/unprocessable', title: 'Unprocessable Request', detail });

export const unsupported = (detail: string): XyteError =>
  new XyteError({
    status: 400,
    type: '/request/invalid',
    title: 'Unsupported Request',
    detail: `${detail} (not supported by xyte)`,
  });

/** A ban (Zyte's `/download/website-ban`), or a proxy/network failure, that retries could not get past. */
export const temporaryDownloadError = (
  detail: string,
  options: { ban?: boolean; cause?: unknown } = {},
): XyteError =>
  new XyteError(
    {
      status: 520,
      type: options.ban ? '/download/website-ban' : '/download/temporary-error',
      title: options.ban ? 'Website Ban' : 'Temporary Download Error',
      detail,
    },
    { cause: options.cause },
  );

/** Misconfiguration on this side (e.g. a missing optional dependency): retrying will not help. */
export const serverError = (detail: string, cause?: unknown): XyteError =>
  new XyteError({ status: 500, type: '/server/internal', title: 'Internal Server Error', detail }, { cause });

export const domainUnreachable = (detail: string, cause?: unknown): XyteError =>
  new XyteError(
    { status: 421, type: '/website/domain-unreachable', title: 'Domain Unreachable', detail },
    { cause },
  );
