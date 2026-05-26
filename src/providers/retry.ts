/**
 * fetchWithRetry — exponential-backoff wrapper around fetch for transient errors.
 *
 * Retries on HTTP 429 (rate-limit), 503 (overloaded), 529 (Anthropic overloaded),
 * and network-level errors (TypeError). Honors `Retry-After` (seconds or
 * HTTP-date) when present; otherwise uses exponential backoff with jitter.
 * AbortError is propagated immediately — user-initiated cancellation should
 * never be retried.
 */

const RETRYABLE_STATUS = new Set([429, 503, 529]);

export interface RetryOptions {
	fetch?: typeof fetch;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	jitter?: () => number;
	maxAttempts?: number;
	baseBackoffMs?: number;
	maxBackoffMs?: number;
}

const DEFAULTS = {
	maxAttempts: 3,
	baseBackoffMs: 500,
	maxBackoffMs: 30_000,
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

export function parseRetryAfter(value: string | null | undefined, now: () => number = Date.now): number | null {
	if (!value) return null;
	const secs = Number(value);
	if (Number.isFinite(secs)) {
		return Math.max(0, secs * 1000);
	}
	const ts = Date.parse(value);
	if (Number.isFinite(ts)) {
		return Math.max(0, ts - now());
	}
	return null;
}

export async function fetchWithRetry(
	url: string,
	init: RequestInit = {},
	opts: RetryOptions = {},
): Promise<Response> {
	const doFetch = opts.fetch ?? fetch;
	const sleep = opts.sleep ?? defaultSleep;
	const jitter = opts.jitter ?? Math.random;
	const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
	const baseBackoffMs = opts.baseBackoffMs ?? DEFAULTS.baseBackoffMs;
	const maxBackoffMs = opts.maxBackoffMs ?? DEFAULTS.maxBackoffMs;
	const signal = init.signal ?? undefined;

	let lastResponse: Response | null = null;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let response: Response;
		try {
			response = await doFetch(url, init);
		} catch (e) {
			const err = e as Error;
			if (err.name === 'AbortError') throw err;
			if (attempt === maxAttempts) throw err;
			await sleep(computeBackoff(attempt, baseBackoffMs, maxBackoffMs, jitter), signal);
			continue;
		}

		if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
			return response;
		}

		lastResponse = response;
		if (attempt === maxAttempts) return response;

		const ra = parseRetryAfter(response.headers.get('Retry-After'));
		const delay = ra !== null
			? Math.min(ra, maxBackoffMs)
			: computeBackoff(attempt, baseBackoffMs, maxBackoffMs, jitter);
		await sleep(delay, signal);
	}
	return lastResponse as Response;
}

function computeBackoff(
	attempt: number,
	baseMs: number,
	maxMs: number,
	jitter: () => number,
): number {
	const expo = baseMs * 2 ** (attempt - 1);
	const jit = jitter() * baseMs;
	return Math.min(maxMs, expo + jit);
}
