import type { Endpoint } from '../types';
import { anthropicProvider } from './anthropic';
import { openAICompatProvider } from './openai-compat';
import type { Provider } from './types';

/**
 * Resolve the provider for an endpoint. Dispatches on endpoint.protocol —
 * undefined / 'openai-compat' uses the OpenAI-compatible chat-completions
 * code path; 'anthropic' uses Anthropic's native /v1/messages API.
 */
export function providerFor(endpoint: Endpoint): Provider {
	if (endpoint.protocol === 'anthropic') return anthropicProvider;
	return openAICompatProvider;
}

export type {
	AssembledTurn,
	ImageResolver,
	Provider,
	ProviderCapabilities,
	StreamCallbacks,
	StreamEvent,
	ToolCall,
	ToolDescriptor,
	TurnRequest,
	TurnUsage,
} from './types';
