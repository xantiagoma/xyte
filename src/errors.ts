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

export const unsupported = (detail: string): XyteError =>
  new XyteError({
    status: 400,
    type: '/request/invalid',
    title: 'Unsupported Request',
    detail: `${detail} (not supported by xyte)`,
  });

/** A ban, or a proxy/network failure, that retries could not get past. */
export const temporaryDownloadError = (
  detail: string,
  options: { ban?: boolean; cause?: unknown } = {},
): XyteError =>
  new XyteError(
    {
      status: 520,
      type: '/download/temporary-error',
      title: options.ban ? 'Website Ban' : 'Temporary Download Error',
      detail,
    },
    { cause: options.cause },
  );

export const domainUnreachable = (detail: string, cause?: unknown): XyteError =>
  new XyteError(
    { status: 421, type: '/website/domain-unreachable', title: 'Domain Unreachable', detail },
    { cause },
  );
