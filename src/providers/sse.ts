/**
 * Read a ReadableStream and yield chunks split by `delimiter`. Yields the
 * trailing remnant after the underlying stream closes, even when the server
 * didn't terminate with the delimiter — local servers and lenient proxies
 * sometimes drop the final newline, which would otherwise lose the last
 * usage / finish_reason event.
 *
 * `\n` yields line-delimited SSE (OpenAI, Gemini).
 * `\n\n` yields event-block-delimited SSE (Anthropic).
 */
export async function* streamSplit(
	body: ReadableStream<Uint8Array>,
	delimiter: string,
): AsyncGenerator<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		const parts = buffer.split(delimiter);
		buffer = parts.pop() ?? '';
		for (const part of parts) yield part;
	}
	buffer += decoder.decode();
	if (buffer.length > 0) yield buffer;
}
