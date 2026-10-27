import type { Problem } from './types.ts';

/** A Zyte error body (an RFC 7807 problem): `type`, `status`, `title` and an optional `detail`. */
export type XyteProblem = Required<Pick<Problem, 'type' | 'status' | 'title'>> & {
  detail?: string;
};

/**
 * A Zyte API error response (RFC 7807 problem). `status` and `type` use the values Zyte uses
 * (https://docs.zyte.com/zyte-api/usage/errors.html), so code written against Zyte keeps working.
 */
export class XyteError extends Error {
  /** The HTTP status Zyte answers with: 400, 422, 429, 500, 520, 521… */
  readonly status: number;
  /** The problem type, the stable thing to branch on: `/download/website-ban`, `/request/invalid`… */
  readonly type: string;
  /** A short human-readable summary of the type. */
  readonly title: string;
  /** What went wrong for this request, when there's more to say. */
  readonly detail?: string;
  readonly #retryable?: boolean;

  /** `retryable` overrides the status-based rule (a misconfiguration's 500 is not). */
  constructor(problem: XyteProblem, options?: { cause?: unknown; retryable?: boolean }) {
    super(problem.detail ? `${problem.title}: ${problem.detail}` : problem.title, options);
    this.#retryable = options?.retryable;
    this.name = 'XyteError';
    this.status = problem.status;
    this.type = problem.type;
    this.title = problem.title;
    this.detail = problem.detail;
  }

  /** Worth retrying later, the same way Zyte's own clients retry. */
  get retryable(): boolean {
    return this.#retryable ?? (this.status === 429 || this.status === 503 || this.status === 520 || this.status === 500);
  }

  /** The problem as Zyte's error body; what `xyte serve` answers with. */
  toJSON(): XyteProblem {
    return { type: this.type, status: this.status, title: this.title, detail: this.detail };
  }
}

export const invalidRequest = (detail: string): XyteError =>
  new XyteError({ status: 400, type: '/request/invalid', title: 'Invalid Request', detail });

/**
 * A failure an upstream Zyte-compatible API answered with its own problem (a 520 ban, a 429, a
 * suspended account). Retried like any download error; if it is the last one, that problem is
 * returned as is.
 */
export class UpstreamProblem extends Error {
  /** Always `UpstreamProblem`. */
  override name = 'UpstreamProblem';
  /** The upstream's problem, returned to the caller as is if no retry succeeds. */
  readonly problem: XyteProblem;
  /**
   * The provider can't serve any request until someone fixes it (a bad key, a suspended account):
   * inside a combinator the request moves on and the provider isn't tried again for it; alone, the
   * problem is the answer, with no retries.
   */
  readonly fatal: boolean;
  /** What the upstream reported about its own attempts (another xyte server's `X-Xyte-Attempts`). */
  readonly upstream?: UpstreamInfo;

  constructor(problem: XyteProblem, options: { fatal?: boolean; upstream?: UpstreamInfo } = {}) {
    super(`${problem.status} ${problem.type}${problem.detail ? `: ${problem.detail}` : ''}`);
    this.problem = problem;
    this.fatal = options.fatal ?? false;
    this.upstream = options.upstream;
  }
}

/** An upstream xyte server's report of a request, from its `X-Xyte-*` headers. */
export interface UpstreamInfo {
  /** Its attempts, in order: `provider` is its leaf (`oxylabs-residential`), `result` its verdict. */
  attempts: { provider: string; result: string }[];
  /** Bytes its attempts moved (`X-Xyte-Transfer-Bytes`). */
  transferBytes?: number;
  /** Its request id (`X-Xyte-Request-Id`), to find the request in its logs. */
  requestId?: string;
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
  new XyteError({ status: 500, type: '/server/internal', title: 'Internal Server Error', detail }, { cause, retryable: false });

export const domainUnreachable = (detail: string, cause?: unknown): XyteError =>
  new XyteError(
    { status: 421, type: '/website/domain-unreachable', title: 'Domain Unreachable', detail },
    { cause },
  );
