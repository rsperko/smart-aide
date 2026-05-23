import { streamChat } from './provider';
import { resolveModelRef, SmartAideSettings } from './settings';
import { ChatSession, ChatStorage } from './storage';
import { MessageEntry } from './types';
import { messageText } from './view-helpers';

/**
 * After the first user/assistant exchange completes, generate a 4-8 word title
 * via a cheap call and persist it as a session_info entry. Idempotent — only
 * runs when no session_info entry exists yet.
 */
export async function maybeAutoTitle(opts: {
	session: ChatSession;
	settings: SmartAideSettings;
	storage: ChatStorage;
	onTitled: (title: string) => void;
}): Promise<void> {
	const { session, settings, storage, onTitled } = opts;

	if (session.entries.some((e) => e.type === 'session_info')) return;

	const hasUser = session.entries.some((e) => e.type === 'message' && e.message.role === 'user');
	const hasAssistant = session.entries.some((e) => e.type === 'message' && e.message.role === 'assistant');
	if (!hasUser || !hasAssistant) return;

	const { endpoint, slug } = resolveModelRef(settings, settings.titleModelRef);
	if (!endpoint.apiKey) return;

	try {
		const firstUser = session.entries.find(
			(e) => e.type === 'message' && e.message.role === 'user',
		) as MessageEntry | undefined;
		const firstAsst = session.entries.find(
			(e) => e.type === 'message' && e.message.role === 'assistant',
		) as MessageEntry | undefined;
		if (!firstUser || !firstAsst) return;

		const userText = messageText(firstUser.message, ' ');
		const asstText = messageText(firstAsst.message, ' ');

		let title = '';
		for await (const ev of streamChat({
			endpoint,
			model: slug,
			messages: [
				{
					role: 'system',
					content: [
						'Title this conversation in 4-8 words. Reply with ONLY the title — no quotes, no punctuation.',
						'Style: topic-first, descriptive, not "Discussion about X".',
						'Examples: "Finding the weekly review template", "Recipes with miso paste", "Daily note for May 22".',
					].join('\n'),
				},
				{ role: 'user', content: `User: ${userText.slice(0, 400)}\n\nAssistant: ${asstText.slice(0, 400)}` },
			],
		})) {
			if (ev.type === 'text-delta' && ev.textDelta) title += ev.textDelta;
			if (ev.type === 'error') return;
		}
		title = title.trim().replace(/^["']|["']$/g, '').replace(/\.$/, '');
		if (!title) return;

		const entry = storage.makeTitleEntry(title, session.leafId);
		await storage.appendEntry(session, entry);
		session.title = title;
		onTitled(title);
	} catch (e) {
		console.warn('smart-aide: auto-title failed', e);
	}
}
