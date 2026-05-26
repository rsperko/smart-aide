import { describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, parseRetryAfter } from '../src/providers/retry';

function makeResponse(
	status: number,
	body: string = '',
	headers: Record<string, string> = {},
): Response {
	return new Response(body, { status, headers });
}

describe('parseRetryAfter', () => {
	it('returns ms from a numeric seconds value', () => {
		expect(parseRetryAfter('2', () => 0)).toBe(2000);
		expect(parseRetryAfter('0.5', () => 0)).toBe(500);
	});

	it('returns ms from an HTTP-date relative to now', () => {
		const now = Date.parse('2026-05-26T10:00:00Z');
		const future = new Date(now + 3000).toUTCString();
		expect(parseRetryAfter(future, () => now)).toBe(3000);
	});

	it('returns null for unparseable values', () => {
		expect(parseRetryAfter('not-a-date', () => 0)).toBeNull();
		expect(parseRetryAfter('', () => 0)).toBeNull();
	});

	it('clamps negative durations to 0', () => {
		const now = Date.parse('2026-05-26T10:00:00Z');
		const past = new Date(now - 5000).toUTCString();
		expect(parseRetryAfter(past, () => now)).toBe(0);
	});
});

describe('fetchWithRetry', () => {
	it('returns the response immediately on 2xx (no retry, no sleep)', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(200, 'ok'));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchWithRetry('https://x', { method: 'GET' }, { fetch: fetchMock, sleep });
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries on 429 and returns the eventual 200', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(429, 'rate limit', { 'Retry-After': '0' }))
			.mockResolvedValueOnce(makeResponse(200, 'ok'));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep });
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('retries on 503 and 529', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(503))
			.mockResolvedValueOnce(makeResponse(529))
			.mockResolvedValueOnce(makeResponse(200, 'ok'));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep });
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('honors Retry-After header from the response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(429, '', { 'Retry-After': '2' }))
			.mockResolvedValueOnce(makeResponse(200));
		const sleeps: number[] = [];
		const sleep = vi.fn().mockImplementation(async (ms: number) => {
			sleeps.push(ms);
		});
		await fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep });
		expect(sleeps).toEqual([2000]);
	});

	it('uses exponential backoff when Retry-After is missing', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(503))
			.mockResolvedValueOnce(makeResponse(503))
			.mockResolvedValueOnce(makeResponse(200));
		const sleeps: number[] = [];
		const sleep = vi.fn().mockImplementation(async (ms: number) => {
			sleeps.push(ms);
		});
		await fetchWithRetry(
			'https://x',
			{},
			{ fetch: fetchMock, sleep, baseBackoffMs: 100, jitter: () => 0 },
		);
		// 100ms, 200ms (exponential).
		expect(sleeps).toEqual([100, 200]);
	});

	it('caps total attempts at maxAttempts and returns the last error response', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(makeResponse(503, 'still overloaded'));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchWithRetry(
			'https://x',
			{},
			{ fetch: fetchMock, sleep, maxAttempts: 3, baseBackoffMs: 1, jitter: () => 0 },
		);
		expect(res.status).toBe(503);
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it('does NOT retry on 4xx errors other than 429', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(401, 'unauthorized'));
		const sleep = vi.fn();
		const res = await fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep });
		expect(res.status).toBe(401);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('does NOT retry on non-retryable 5xx (e.g. 500)', async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(500));
		const sleep = vi.fn();
		const res = await fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep });
		expect(res.status).toBe(500);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('propagates AbortError immediately without retrying', async () => {
		const abortErr = Object.assign(new Error('aborted'), { name: 'AbortError' });
		const fetchMock = vi.fn().mockRejectedValueOnce(abortErr);
		const sleep = vi.fn();
		await expect(
			fetchWithRetry('https://x', {}, { fetch: fetchMock, sleep }),
		).rejects.toThrow('aborted');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(sleep).not.toHaveBeenCalled();
	});

	it('retries on network errors (TypeError) up to maxAttempts', async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new TypeError('NetworkError'))
			.mockResolvedValueOnce(makeResponse(200));
		const sleep = vi.fn().mockResolvedValue(undefined);
		const res = await fetchWithRetry(
			'https://x',
			{},
			{ fetch: fetchMock, sleep, baseBackoffMs: 1, jitter: () => 0 },
		);
		expect(res.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('aborts the sleep when the signal fires between attempts', async () => {
		const ctrl = new AbortController();
		const fetchMock = vi.fn().mockResolvedValueOnce(makeResponse(503));
		const sleep = vi.fn().mockImplementation(async (_ms: number, signal?: AbortSignal) => {
			// Simulate signal arriving during sleep.
			ctrl.abort();
			if (signal?.aborted) {
				throw Object.assign(new Error('aborted'), { name: 'AbortError' });
			}
		});
		await expect(
			fetchWithRetry(
				'https://x',
				{ signal: ctrl.signal },
				{ fetch: fetchMock, sleep, baseBackoffMs: 1, jitter: () => 0 },
			),
		).rejects.toThrow('aborted');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('caps Retry-After at maxBackoffMs to avoid wedging the UI', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(makeResponse(429, '', { 'Retry-After': '600' }))
			.mockResolvedValueOnce(makeResponse(200));
		const sleeps: number[] = [];
		const sleep = vi.fn().mockImplementation(async (ms: number) => {
			sleeps.push(ms);
		});
		await fetchWithRetry(
			'https://x',
			{},
			{ fetch: fetchMock, sleep, maxBackoffMs: 30_000 },
		);
		expect(sleeps).toEqual([30_000]);
	});
});
