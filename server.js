import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

let createClient;
try {
	const module = await import('@libsql/client');
	createClient = module.createClient;
} catch {
	const module = await import('@libsql/client/web');
	createClient = module.createClient;
}

import { getCached, setCached } from './cache.js';
import { callProviders, getProviderModels } from './lib/googleAI.mjs';

const app = express();
const port = Number(process.env.LRX_BACKEND_PORT || 3000);

const serverConfig = {
	defaultIns: `
You are an LRC romanizer and translator.
Your response must be a single valid JSON object with exactly two keys: "rom" and "transl". Each value is a string of properly formatted LRC lines. Output only the JSON object, no markdown or any extra formatting.
Rules:
1. Preserve all metadata/tag lines (like [ti:], [ar:], [al:], credits) exactly as-is in both "rom" and "transl".
2. Preserve every timestamp (e.g. [00:05.00]) exactly.
3. For any line whose lyrics are entirely in English or any other Latin-alphabet script: In "rom" and "transl", output only the timestamp (e.g. "[00:12.34]") with no text following.
4. For any instrumental or musical marker lines: Output only the timestamp in both "rom" and "transl".
5. For non-English or generally non-Latin scripts: In "rom", romanize as sung (performance-style phonetics).
6. For non-English lines: In "transl", provide a natural, human-sounding English translation.
7. Mixed Latin + non-Latin on the same line: romanize every syllable (leave Latin words unchanged but remember to just return the timestamp if it is fully English or generally Latin script alphabet).
8. Escape newlines inside JSON strings as "\\n".
9. Do not add any explanation — return only the raw JSON object.
NOTE: If a line is mixed English and other language, do romanize and translate it.
Example output: {"rom":"[00:01.00] konnichiwa\\n[00:02.00]","transl":"[00:01.00] Hello\\n[00:02.00]"}
--
Handling a purely English line:
Original: [00:10.00] I don't care if it hurts
rom: [00:10.00]
transl: [00:10.00]
--
Also check the title as it may be present in the translation of non English songs that has English title.
`.trim(),

	humanTrIns: `
You are an expert LRC file formatter. You will be given an original LRC file and a pre-existing English translation.
Your task is to combine these into a single valid JSON object with two keys: "rom" (romanization) and "transl" (the provided translation, aligned).
Your response must be a single valid JSON object. Output only the JSON object, no markdown or any extra formatting.

Rules for "rom" (Romanization):
1. From the original LRC, romanize any non-Latin script lyrics as they are sung (performance-style phonetics).
2. If a line in the original LRC is entirely in English or other Latin script, output only the timestamp for that line (e.g., "[00:12.34]").
3. For mixed Latin + non-Latin lines, romanize the non-Latin parts and keep the Latin parts as they are.
4. Preserve all metadata ([ti:]) and timestamps exactly as they appear in the original LRC.
5. For instrumental lines, output only the timestamp.

Rules for "transl" (Translation Alignment):
1. Use the "Pre-existing English Translation" provided below. Your main job is to ALIGN its phrases with the timestamps from the original LRC.
2. If a line in the original LRC has no translatable content (e.g., it's instrumental or already English), output only the timestamp for that line in "transl".
3. Preserve all metadata ([ti:]) and timestamps exactly as they appear in the original LRC.

General Rules:
- Escape newlines inside JSON strings as "\\n".
- Do not add any explanation — return only the raw JSON object.
`.trim()
};

const tp = process.env.TRUST_PROXY;
if (tp !== undefined) {
	if (tp === 'true') app.set('trust proxy', true);
	else if (tp === 'false') app.set('trust proxy', false);
	else if (!Number.isNaN(Number(tp))) app.set('trust proxy', Number(tp));
	else app.set('trust proxy', tp);
} else {
	app.set('trust proxy', true);
}

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '50kb' }));

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
	throw new Error('FATAL_ERROR: Turso database URL or auth token is not defined.');
}

const db = createClient({
	url: process.env.TURSO_DATABASE_URL,
	authToken: process.env.TURSO_AUTH_TOKEN
});

const translationModels = process.env.MODEL_FALLBACK
	? process.env.MODEL_FALLBACK.split(',').map(s => s.trim()).filter(Boolean)
	: getProviderModels();

const MASTER_API_KEY = process.env.SERVER_MASTER_API_KEY || '';
const CLIENT_API_KEYS = (process.env.SERVER_API_KEYS || '')
	.split(',')
	.map(k => k.trim())
	.filter(Boolean);

const apiLimiter = rateLimit({
	windowMs: 1 * 60 * 1000,
	limit: 10,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: 'Too many requests from this IP. Current limits: 10 req/min'
});

const inFlightRequests = new Map();
const responseCacheTtlMs = Number(process.env.TRANSLATION_CACHE_TTL_MS || 15 * 60 * 1000);

const TABLES = {
	plain: 'plain_results',
	synced: 'synced_results'
};

function apiKeyMiddleware(req, res, next) {
	const key = req.headers['x-api-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
	if (!MASTER_API_KEY) return next();
	if (!key) return res.status(401).json({ error: 'API key required' });
	if (key === MASTER_API_KEY || CLIENT_API_KEYS.includes(key)) return next();
	return res.status(403).json({ error: 'Invalid API key' });
}

function sha256(text) {
	return crypto.createHash('sha256').update(text).digest('hex');
}

function normalizeBool(value) {
	return value === true || value === 'true' || value === 1 || value === '1';
}

function toIntId(value) {
	const n = Number(value);
	return Number.isInteger(n) ? n : null;
}

function cleanText(value) {
	if (typeof value !== 'string') return '';
	return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function normalizeModelOutput(parsed) {
	const rom = typeof parsed?.rom === 'string'
		? parsed.rom
		: typeof parsed?.synced === 'string'
			? parsed.synced
			: '';

	const transl = typeof parsed?.transl === 'string'
		? parsed.transl
		: typeof parsed?.plain === 'string'
			? parsed.plain
			: '';

	if (!rom && !transl) {
		throw new Error('Model response missing rom/transl fields');
	}

	return {
		rom,
		transl
	};
}

function buildPrompt({ title, artist, lrcText, humanTr }) {
	const prefix = humanTr ? serverConfig.humanTrIns : serverConfig.defaultIns;
	const parts = [
		`Title: ${title || ''}`,
		`Artist: ${artist || ''}`,
		`LRC:\n${lrcText}`
	];

	if (humanTr) {
		parts.push(`Translation:\n${humanTr}`);
	}

	return `${prefix}\n\n${parts.join('\n')}`;
}

function buildCachedKeys(textHash, plainFlag) {
	const mode = plainFlag ? 'plain' : 'synced';
	return {
		hashKey: `hash:${mode}:${textHash}`,
		idKey: `lrclib:${mode}:`
	};
}

function toApiResponse(lrclibId, row, plainFlag) {
	const rom = row?.rom ?? null;
	const transl = row?.transl ?? null;

	return plainFlag
		? {
				lrclib_id: lrclibId,
				plain: transl,
				synced: null,
				rom,
				transl
			}
		: {
				lrclib_id: lrclibId,
				plain: null,
				synced: rom,
				rom,
				transl
			};
}

function toCachePayload(lrclibId, row, plainFlag) {
	const api = toApiResponse(lrclibId, row, plainFlag);
	return {
		lrclib_id: api.lrclib_id,
		plain: api.plain,
		synced: api.synced,
		rom: api.rom,
		transl: api.transl
	};
}

async function initSchema() {
	await db.execute(`
		CREATE TABLE IF NOT EXISTS translations (
			text_hash TEXT PRIMARY KEY,
			lrclib_id INTEGER,
			hasPlain INTEGER NOT NULL DEFAULT 0,
			hasSynced INTEGER NOT NULL DEFAULT 0
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS song_metadata (
			lrclib_id INTEGER PRIMARY KEY NOT NULL,
			text_hash TEXT NOT NULL
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS plain_results (
			lrclib_id INTEGER PRIMARY KEY NOT NULL,
			rom TEXT,
			transl TEXT,
			createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
			updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);

	await db.execute(`
		CREATE TABLE IF NOT EXISTS synced_results (
			lrclib_id INTEGER PRIMARY KEY NOT NULL,
			rom TEXT,
			transl TEXT,
			createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
			updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
		)
	`);

	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_song_metadata_text_hash
		ON song_metadata(text_hash)
	`);

	await db.execute(`
		CREATE INDEX IF NOT EXISTS idx_translations_lrclib_id
		ON translations(lrclib_id)
	`);
}

async function upsertTranslationIndex(textHash, lrclibId, plainFlag) {
	const hasPlain = plainFlag ? 1 : 0;
	const hasSynced = plainFlag ? 0 : 1;

	await db.execute({
		sql: `
			INSERT INTO translations (text_hash, lrclib_id, hasPlain, hasSynced)
			VALUES (?, ?, ?, ?)
			ON CONFLICT(text_hash) DO UPDATE SET
				lrclib_id = excluded.lrclib_id,
				hasPlain = CASE
					WHEN excluded.hasPlain = 1 THEN 1
					ELSE translations.hasPlain
				END,
				hasSynced = CASE
					WHEN excluded.hasSynced = 1 THEN 1
					ELSE translations.hasSynced
				END
		`,
		args: [textHash, lrclibId, hasPlain, hasSynced]
	});
}

async function upsertSongMetadata(lrclibId, textHash) {
	await db.execute({
		sql: `
			INSERT INTO song_metadata (lrclib_id, text_hash)
			VALUES (?, ?)
			ON CONFLICT(lrclib_id) DO UPDATE SET
				text_hash = excluded.text_hash
		`,
		args: [lrclibId, textHash]
	});
}

async function storeContentRow(lrclibId, plainFlag, row) {
	const table = plainFlag ? TABLES.plain : TABLES.synced;

	await db.execute({
		sql: `
			INSERT INTO ${table} (lrclib_id, rom, transl)
			VALUES (?, ?, ?)
			ON CONFLICT(lrclib_id) DO UPDATE SET
				rom = excluded.rom,
				transl = excluded.transl,
				updatedAt = CURRENT_TIMESTAMP
		`,
		args: [lrclibId, row.rom ?? null, row.transl ?? null]
	});
}

async function fetchContentRowById(lrclibId, plainFlag) {
	const table = plainFlag ? TABLES.plain : TABLES.synced;

	const result = await db.execute({
		sql: `
			SELECT lrclib_id, rom, transl
			FROM ${table}
			WHERE lrclib_id = ?
			LIMIT 1
		`,
		args: [lrclibId]
	});

	if (!result.rows.length) return null;
	return {
		lrclib_id: Number(result.rows[0].lrclib_id),
		rom: result.rows[0].rom ?? null,
		transl: result.rows[0].transl ?? null
	};
}

async function fetchAnySourceRowByHash(textHash, plainFlag) {
	const table = plainFlag ? TABLES.plain : TABLES.synced;
	const indexResult = await db.execute({
		sql: `
			SELECT lrclib_id
			FROM song_metadata
			WHERE text_hash = ?
			ORDER BY lrclib_id ASC
		`,
		args: [textHash]
	});

	for (const metaRow of indexResult.rows) {
		const candidateId = Number(metaRow.lrclib_id);
		if (!Number.isInteger(candidateId)) continue;

		const row = await fetchContentRowById(candidateId, plainFlag);
		if (row) return row;
	}

	const directResult = await db.execute({
		sql: `
			SELECT lrclib_id, rom, transl
			FROM ${table}
			WHERE lrclib_id = (
				SELECT lrclib_id
				FROM translations
				WHERE text_hash = ?
				LIMIT 1
			)
			LIMIT 1
		`,
		args: [textHash]
	});

	if (!directResult.rows.length) return null;

	return {
		lrclib_id: Number(directResult.rows[0].lrclib_id),
		rom: directResult.rows[0].rom ?? null,
		transl: directResult.rows[0].transl ?? null
	};
}

async function fetchCachedTranslationByHash(textHash, plainFlag) {
	const { hashKey } = buildCachedKeys(textHash, plainFlag);
	const hot = getCached(hashKey);
	if (hot) return hot;

	const result = await db.execute({
		sql: `
			SELECT text_hash, lrclib_id, hasPlain, hasSynced
			FROM translations
			WHERE text_hash = ?
			LIMIT 1
		`,
		args: [textHash]
	});

	if (!result.rows.length) return null;

	const row = result.rows[0];
	const hasType = plainFlag ? Number(row.hasPlain) === 1 : Number(row.hasSynced) === 1;
	if (!hasType) return null;

	const sourceRow = await fetchAnySourceRowByHash(textHash, plainFlag);
	if (!sourceRow) return null;

	const payload = toCachePayload(Number(row.lrclib_id ?? sourceRow.lrclib_id), sourceRow, plainFlag);
	setCached(hashKey, payload, responseCacheTtlMs);
	return payload;
}

async function fetchCachedTranslationById(lrclibId) {
	const plainHot = getCached(`id:plain:${lrclibId}`);
	if (plainHot) return plainHot;

	const syncedHot = getCached(`id:synced:${lrclibId}`);
	if (syncedHot) return syncedHot;

	const meta = await db.execute({
		sql: `
			SELECT text_hash
			FROM song_metadata
			WHERE lrclib_id = ?
			LIMIT 1
		`,
		args: [lrclibId]
	});

	if (!meta.rows.length) return null;

	const [plainRow, syncedRow] = await Promise.all([
		fetchContentRowById(lrclibId, true),
		fetchContentRowById(lrclibId, false)
	]);

	if (!plainRow && !syncedRow) return null;

	const payload = {
		lrclib_id: Number(lrclibId),
		plain: plainRow?.transl ?? null,
		synced: syncedRow?.rom ?? null
	};

	setCached(`id:plain:${lrclibId}`, payload, responseCacheTtlMs);
	setCached(`id:synced:${lrclibId}`, payload, responseCacheTtlMs);

	return payload;
}

async function translateWithModel({ title, artist, lrcText, humanTr }) {
	const prompt = buildPrompt({ title, artist, lrcText, humanTr });
	const { parsed } = await callProviders({
		prompt,
		modelFallbackList: translationModels,
		maxRetries: Number(process.env.MODEL_MAX_RETRIES || 2)
	});

	return normalizeModelOutput(parsed);
}

app.post('/api/translate', apiKeyMiddleware, apiLimiter, async (req, res) => {
	const body = req.body ?? {};
	const lrclibId = toIntId(body.lrclib_id);
	const title = typeof body.title === 'string' ? body.title : '';
	const artist = typeof body.artist === 'string' ? body.artist : '';
	const lrcText = typeof body.lrcText === 'string' ? body.lrcText : '';
	const plainFlag = normalizeBool(body.plain);
	const humanTr = typeof body.humanTr === 'string' ? body.humanTr : '';

	if (lrclibId === null) return res.status(400).json({ error: 'lrclib_id is required and must be an integer.' });
	if (!lrcText) return res.status(400).json({ error: 'lrcText is required.' });

	const normalizedLrc = cleanText(lrcText);
	const textHash = sha256(normalizedLrc);
	const flightKey = `${plainFlag ? 'plain' : 'synced'}:${textHash}`;

	if (inFlightRequests.has(flightKey)) {
		try {
			return res.json(await inFlightRequests.get(flightKey));
		} catch {
			return res.status(500).json({ error: 'Request failed' });
		}
	}

	const work = (async () => {
		const cached = await fetchCachedTranslationByHash(textHash, plainFlag);
		if (cached) {
			await upsertSongMetadata(lrclibId, textHash);
			await upsertTranslationIndex(textHash, lrclibId, plainFlag);
			await storeContentRow(lrclibId, plainFlag, cached);

			const response = toApiResponse(lrclibId, cached, plainFlag);
			setCached(`id:${plainFlag ? 'plain' : 'synced'}:${lrclibId}`, response, responseCacheTtlMs);
			setCached(`hash:${plainFlag ? 'plain' : 'synced'}:${textHash}`, response, responseCacheTtlMs);
			return response;
		}

		const translated = await translateWithModel({
			title,
			artist,
			lrcText: normalizedLrc,
			humanTr
		});

		const storedRow = {
			rom: cleanText(translated.rom),
			transl: cleanText(translated.transl)
		};

		await upsertSongMetadata(lrclibId, textHash);
		await upsertTranslationIndex(textHash, lrclibId, plainFlag);
		await storeContentRow(lrclibId, plainFlag, storedRow);

		const response = toApiResponse(lrclibId, storedRow, plainFlag);
		setCached(`id:${plainFlag ? 'plain' : 'synced'}:${lrclibId}`, response, responseCacheTtlMs);
		setCached(`hash:${plainFlag ? 'plain' : 'synced'}:${textHash}`, response, responseCacheTtlMs);
		return response;
	})();

	inFlightRequests.set(flightKey, work);

	try {
		return res.json(await work);
	} catch (err) {
		console.error(err.stack || err);
		return res.status(503).json({ error: 'Translation service unavailable' });
	} finally {
		inFlightRequests.delete(flightKey);
	}
});

async function cachedHandler(req, res) {
	const lrclibId = toIntId(req.params.lrclib_id);
	if (lrclibId === null) return res.sendStatus(400);

	try {
		const cached = await fetchCachedTranslationById(lrclibId);
		if (!cached) return res.sendStatus(404);
		return res.json(cached);
	} catch (err) {
		console.error('Cache lookup failed:', err);
		return res.status(500).json({ error: 'Failed to fetch cached translation' });
	}
}

app.get('/api/cached/:lrclib_id', cachedHandler);
app.get('/cached/:lrclib_id', cachedHandler);

app.get('/status', (req, res) => {
	res.json({
		status: 'ok',
		uptime: process.uptime(),
		memory: process.memoryUsage(),
		database: 'Turso'
	});
});

app.get('/debug-ip', (req, res) => {
	res.json({
		'your-real-ip': req.ip,
		'forwarded-for-header': req.headers['x-forwarded-for']
	});
});

app.get('/', (req, res) => res.send('LRC Proxy & Translation Server'));

await initSchema();

const server = app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	console.log('Connected to Turso DB.');
});

process.on('SIGINT', () => {
	server.close(() => {
		db.close();
		process.exit(0);
	});
});
