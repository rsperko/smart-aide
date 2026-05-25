import { describe, expect, it } from 'vitest';
import { streamSplit } from '../src/providers/sse';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < chunks.length) {
				controller.enqueue(encoder.encode(chunks[i++]));
			} else {
				controller.close();
			}
		},
	});
}

async function collect(stream: ReadableStream<Uint8Array>, delim: string): Promise<string[]> {
	const out: string[] = [];
	for await (const chunk of streamSplit(stream, delim)) out.push(chunk);
	return out;
}

describe('streamSplit', () => {
	it('yields each line for a properly terminated stream', async () => {
		const got = await collect(streamOf(['a\nb\nc\n']), '\n');
		expect(got).toEqual(['a', 'b', 'c']);
	});

	it('yields the final remnant when the stream ends without the delimiter', async () => {
		// This is the bug the helper fixes: lenient SSE proxies drop the final \n,
		// so a trailing usage / finish_reason chunk would otherwise be lost.
		const got = await collect(streamOf(['a\nb\nfinal-without-newline']), '\n');
		expect(got).toEqual(['a', 'b', 'final-without-newline']);
	});

	it('handles chunk boundaries that fall inside a line', async () => {
		const got = await collect(streamOf(['data: par', 'tial\nnext\n']), '\n');
		expect(got).toEqual(['data: partial', 'next']);
	});

	it('handles a chunk boundary that falls inside a multibyte character', async () => {
		// "café" — é is two UTF-8 bytes. Splitting the bytes mid-codepoint must
		// not produce a replacement char or duplicate output.
		const encoder = new TextEncoder();
		const bytes = encoder.encode('café\nnext\n');
		const cut = 4; // splits the é (bytes 3-4)
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(bytes.slice(0, cut));
				controller.enqueue(bytes.slice(cut));
				controller.close();
			},
		});
		const got = await collect(stream, '\n');
		expect(got).toEqual(['café', 'next']);
	});

	it('splits by \\n\\n for event-block-delimited SSE', async () => {
		const got = await collect(
			streamOf(['event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3']),
			'\n\n',
		);
		expect(got).toEqual([
			'event: a\ndata: 1',
			'event: b\ndata: 2',
			'event: c\ndata: 3',
		]);
	});

	it('does not yield an empty final remnant when the stream ends on a delimiter', async () => {
		const got = await collect(streamOf(['a\nb\n']), '\n');
		expect(got).toEqual(['a', 'b']);
	});
});
