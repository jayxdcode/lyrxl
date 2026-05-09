import fetch from 'cross-fetch';

const DEBUG = !!process.env.DEBUG_RENDER_SERVER;

function collectKeysFromEnv() {
	const envKeys = Object.keys(process.env)
		.filter(k => /^GOOGLE_API_KEY(?:_?\d+)?$/i.test(k));

	envKeys.sort((a, b) => {
		const aNum = (a.match(/\d+$/) || ['1'])[0] | 0;
		const bNum = (b.match(/\d+$/) || ['1'])[0] | 0;
		return aNum - bNum;
	});

	return envKeys.map(k => process.env[k]).filter(Boolean);
}

const KEYS = collectKeysFromEnv();
if (KEYS.length === 0) {
	console.warn('[googleAI] No provider keys found via GOOGLE_API_KEY* environment variables.');
}

const DEFAULT_MODELS = ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const PROVIDER_MODELS = (process.env.MODEL_FALLBACK
	? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean)
	: DEFAULT_MODELS);

let keyIndex = 0;
const keyCooldownUntil = KEYS.map(() => 0);
const provider404Until = {};
const now = () => Date.now();

function nextKey() {
	if (KEYS.length === 0) return null;
	for (let i = 0; i < KEYS.length; i++) {
		const idx = (keyIndex + i) % KEYS.length;
		if (keyCooldownUntil[idx] <= now()) {
			keyIndex = (idx + 1) % KEYS.length;
			return { key: KEYS[idx], idx };
		}
	}
	return { key: KEYS[keyIndex], idx: keyIndex };
}

function markKeyCooldown(idx, ms) {
	if (typeof idx !== 'number' || idx < 0 || idx >= keyCooldownUntil.length) return;
	keyCooldownUntil[idx] = now() + ms;
}

function markProvider404(model, cooldownMs = 5 * 60 * 1000) {
	provider404Until[model] = now() + cooldownMs;
}

function isProviderHealthy(model) {
	return now() > (provider404Until[model] || 0);
}

function sleep(ms) {
	return new Promise(r => setTimeout(r, ms));
}

async function callModel({ model, apiKey, prompt, timeoutMs = 12000 }) {
	const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`;
	const body = {
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: {
			responseMimeType: 'application/json'
		}
	};

	const controller = new AbortController();
	const id = setTimeout(() => controller.abort(), timeoutMs);

	try {
		return await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal
		});
	} finally {
		clearTimeout(id);
	}
}

function stripFences(text) {
	return text
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/i, '')
		.trim();
}

function parseJsonFromText(text) {
	if (!text || typeof text !== 'string') return null;

	let cleaned = stripFences(text);

	for (let i = 0; i < 4; i++) {
		try {
			const parsed = JSON.parse(cleaned);
			if (typeof parsed === 'string') {
				cleaned = parsed.trim();
				continue;
			}
			return parsed;
		} catch {}

		const objectStart = cleaned.indexOf('{');
		const objectEnd = cleaned.lastIndexOf('}');
		if (objectStart >= 0 && objectEnd > objectStart) {
			cleaned = cleaned.slice(objectStart, objectEnd + 1).trim();
			continue;
		}

		break;
	}

	return null;
}

export async function callProviders({ prompt, modelFallbackList = PROVIDER_MODELS, maxRetries = 3 }) {
	let lastErr = null;
	const initialBackoff = Number(process.env.INITIAL_BACKOFF_MS || 200);
	const multiplier = Number(process.env.BACKOFF_MULTIPLIER || 2);

	for (const model of modelFallbackList) {
		if (!isProviderHealthy(model)) {
			if (DEBUG) console.warn(`[googleAI] skipping model ${model} (recent 404 cooldown)`);
			continue;
		}

		let attempt = 0;
		let backoff = initialBackoff;

		while (attempt <= maxRetries) {
			attempt++;
			const picked = nextKey();
			if (!picked?.key) {
				lastErr = new Error('No API keys available (no process.env GOOGLE_API_KEY*)');
				break;
			}

			try {
				if (DEBUG) console.log(`[googleAI] calling model=${model} attempt=${attempt}`);
				const res = await callModel({
					model,
					apiKey: picked.key,
					prompt,
					timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 12000)
				});

				if (res.status === 404) {
					markProvider404(model);
					lastErr = new Error(`model ${model} returned 404`);
					break;
				}

				if (res.status === 429) {
					markKeyCooldown(picked.idx, backoff * 5 + 1000);
					lastErr = new Error(`model ${model} rate limited (429)`);
					if (attempt <= maxRetries) {
						await sleep(backoff);
						backoff *= multiplier;
						continue;
					}
					break;
				}

				const bodyText = await res.text().catch(() => '<no-body>');
				if (!res.ok) {
					lastErr = new Error(`model ${model} returned ${res.status}: ${bodyText}`);
					break;
				}

				let json = null;
				try {
					json = JSON.parse(bodyText);
				} catch {
					json = null;
				}

				const content = json?.candidates?.flatMap(candidate => candidate?.content?.parts || [])
					?.map(part => part?.text ?? '')
					.join('') ?? '';

				const parsed = parseJsonFromText(content || bodyText);
				if (!parsed) {
					lastErr = new Error(`model ${model} returned unparsable content`);
					if (DEBUG) {
						console.log('[debug:critical]', JSON.stringify({ model, status: res.status, bodyText, content }, null, 2));
					}
					break;
				}

				return { model, parsed };
			} catch (err) {
				lastErr = err;
				if (attempt <= maxRetries) {
					await sleep(backoff);
					backoff *= multiplier;
					continue;
				}
				break;
			}
		}
	}

	throw lastErr || new Error('All models failed');
}

export function getProviderModels() {
	return PROVIDER_MODELS.slice();
}
