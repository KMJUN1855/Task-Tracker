import { Router } from 'express';
import { all } from '../db.js';
import { wrap, badRequest, HttpError, requireString, parseTimeZone } from '../http.js';

/**
 * Bulk task entry via Gemini.
 *
 * This router is deliberately self-contained and fails soft: no API key, a rate
 * limit, or Google being down affects only these two endpoints. Nothing else in
 * the app calls it, and the UI hides the button when /status says it is off.
 *
 * It never writes to the database - it returns suggestions, and the browser
 * creates tasks through the ordinary POST /api/tasks after the user has
 * reviewed them.
 */
const router = Router();

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
/**
 * An alias rather than a pinned version: Google retires numbered models (2.5-flash
 * is already refused for new keys even though ListModels still advertises it),
 * and the alias always points at the current flash.
 */
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const MAX_INPUT_CHARS = 8000;
const MAX_ITEMS = 50;
const TIMEOUT_MS = 30000;
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 700;

const apiKey = () => process.env.GEMINI_API_KEY?.trim() || null;

/** Model ids change over time; remember whichever one worked. */
let resolvedModel = null;

/** GET /api/ai/status - lets the UI hide the feature instead of failing later. */
router.get('/status', (req, res) => {
  res.json({ configured: Boolean(apiKey()), model: resolvedModel ?? DEFAULT_MODEL });
});

/**
 * POST /api/ai/parse-tasks  { text, tz? }
 * Returns suggestions only: [{ name, category_id, category_name, due_date }]
 * where due_date is a plain YYYY-MM-DD or null. Turning that into a UTC
 * timestamp is the browser's job, as with every other date in this app.
 */
router.post(
  '/parse-tasks',
  wrap(async (req, res) => {
    const key = apiKey();
    if (!key) {
      throw new HttpError(
        503,
        'AI bulk add is not configured. Set GEMINI_API_KEY on the server to enable it.',
      );
    }

    const text = requireString(req.body ?? {}, 'text', { max: MAX_INPUT_CHARS });
    const timeZone = parseTimeZone(req.body?.tz);

    const categories = await all(
      'SELECT id, name FROM categories WHERE archived_at IS NULL ORDER BY sort_order, id',
    );
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const raw = await callGemini(key, buildPrompt(text, categories, today, timeZone));
    const items = normalise(raw, categories);
    if (items.length === 0) {
      throw badRequest('The AI could not find any tasks in that text. Try adding more detail.');
    }
    res.json({ model: resolvedModel, count: items.length, items });
  }),
);

/* ------------------------------------------------------------------ prompt */

function buildPrompt(text, categories, today, timeZone) {
  return `You split pasted notes into individual tasks for a personal task tracker.

Today is ${today} (${timeZone}).

Available categories - use one of these EXACT names, or null if none fits:
${categories.map((c) => `- ${c.name}`).join('\n')}

Rules:
- The text may be a hierarchy of bullets or indented lines. Turn the actionable
  leaf items into separate tasks. A parent line that is only a heading or
  grouping is NOT a task by itself; a parent line with no children IS.
- When a child item's name would be ambiguous alone, prefix it with its parent,
  e.g. "PHYS 381 - problem set 4".
- Keep each name short and imperative-ish; do not invent work that is not there.
- due_date: only when the text actually implies a date. Resolve relative hints
  ("tomorrow", "next Friday", "by the 20th") against today's date and return
  YYYY-MM-DD. If there is no date hint at all, return null. Never guess.
- Return at most ${MAX_ITEMS} tasks.

Text to split:
"""
${text}
"""`;
}

/* ------------------------------------------------------------------- Gemini */

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      category: { type: 'STRING', nullable: true },
      due_date: { type: 'STRING', nullable: true },
    },
    required: ['name'],
  },
};

async function generate(key, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API_ROOT}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Models that exist but cannot do what we want: images, audio, robotics, and
 * the long-running research ones. ListModels advertises all of them.
 */
const NOT_TEXT_CHAT =
  /image|tts|audio|robotics|lyria|veo|imagen|embedding|computer-use|nano-banana|deep-research|omni/;

/**
 * A 404 is not fatal: ask which models this key can actually use and retry.
 * Note that ListModels lies by omission - it still lists models that
 * generateContent refuses ("no longer available to new users") - so the model
 * that just failed is excluded, and aliases are preferred over pinned versions
 * because they keep working as versions are retired.
 */
async function discoverModel(key, failedModel) {
  const res = await fetch(`${API_ROOT}/models`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) return null;
  const body = await res.json();

  const name = (m) => String(m.name).replace(/^models\//, '');
  const usable = (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
    .map(name)
    .filter((n) => n !== failedModel && !NOT_TEXT_CHAT.test(n));

  return (
    usable.find((n) => n === 'gemini-flash-latest') ??
    usable.find((n) => /flash.*-latest$/.test(n)) ??
    usable.find((n) => /-latest$/.test(n)) ??
    usable.find((n) => /flash/.test(n) && !/preview/.test(n)) ??
    usable.find((n) => /flash/.test(n)) ??
    usable[0] ??
    null
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Gemini returns a transient 5xx often enough to matter - roughly one call in
 * three during testing, on a request that succeeds unchanged moments later. So
 * a 5xx or a dropped connection is retried here rather than handed to the user
 * as "try again"; only a definitive answer (2xx, or a 4xx we should act on)
 * leaves this function.
 *
 * 429 is deliberately NOT retried: that is a quota limit, and hammering it
 * makes it worse. It goes straight back as "wait a moment".
 */
async function generateWithRetry(key, model, prompt) {
  let lastRes = null;
  let lastBody = '';

  for (let attempt = 0; attempt <= TRANSIENT_RETRIES; attempt += 1) {
    let res;
    try {
      res = await generate(key, model, prompt);
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      console.warn(
        `[ai] ${timedOut ? 'timeout' : 'network error'} on ${model} (attempt ${attempt + 1})`,
      );
      if (attempt < TRANSIENT_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new HttpError(
        502,
        timedOut
          ? 'Gemini took too long to answer. Please try again.'
          : 'Could not reach Gemini. Check the connection and try again.',
      );
    }

    if (res.status < 500) return res;

    lastRes = res;
    lastBody = await res.text().catch(() => '');
    // Keep the upstream detail in the server log; the user gets the short line.
    console.warn(
      `[ai] Gemini ${res.status} on ${model} (attempt ${attempt + 1}): ${lastBody.slice(0, 200)}`,
    );
    if (attempt < TRANSIENT_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
  }

  throw upstreamError(lastRes, lastBody);
}

async function callGemini(key, prompt) {
  let model = resolvedModel ?? DEFAULT_MODEL;
  let res = await generateWithRetry(key, model, prompt);

  if (res.status === 404) {
    const discovered = await discoverModel(key, model);
    if (discovered) {
      model = discovered;
      res = await generateWithRetry(key, model, prompt);
    }
  }

  if (!res.ok) throw upstreamError(res, await res.text().catch(() => ''));
  resolvedModel = model;

  const body = await res.json();
  const blocked = body.promptFeedback?.blockReason;
  if (blocked) throw badRequest(`Gemini refused that text (${blocked}).`);

  const parts = body.candidates?.[0]?.content?.parts ?? [];
  const json = parts.map((part) => part.text ?? '').join('').trim();
  if (!json) throw new HttpError(502, 'Gemini returned an empty response. Try again.');

  try {
    return JSON.parse(json);
  } catch {
    throw new HttpError(502, 'Gemini returned something that was not valid JSON. Try again.');
  }
}

/** Upstream failures become messages a person can act on. */
function upstreamError(res, bodyText) {
  let detail = '';
  try {
    detail = JSON.parse(bodyText)?.error?.message ?? '';
  } catch {
    detail = bodyText.slice(0, 200);
  }

  if (res.status === 429) {
    return new HttpError(
      429,
      'Gemini free-tier limit reached. Please wait a moment and try again - everything else in the app still works.',
    );
  }
  if (res.status === 401 || res.status === 403) {
    return new HttpError(502, `Gemini rejected the API key. Check GEMINI_API_KEY. ${detail}`.trim());
  }
  if (res.status === 404) {
    return new HttpError(
      502,
      `No usable Gemini model found for this key. Set GEMINI_MODEL to one your key supports. ${detail}`.trim(),
    );
  }
  if (res.status >= 500) {
    return new HttpError(
      502,
      `Gemini is having trouble right now - already retried ${TRANSIENT_RETRIES + 1} times. Please try again shortly.`,
    );
  }
  return new HttpError(502, `Gemini request failed (${res.status}). ${detail}`.trim());
}

/* --------------------------------------------------------------- normalise */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Never trust the model's shape: clamp, trim and map onto real category ids. */
function normalise(raw, categories) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : [];
  const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c]));

  return list
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const name = String(item?.name ?? '').trim().slice(0, 300);
      if (!name) return null;

      const suggested = item?.category == null ? null : String(item.category).trim().toLowerCase();
      const category = suggested ? byName.get(suggested) ?? null : null;

      const due = item?.due_date == null ? null : String(item.due_date).trim();
      const dueDate = due && DATE_ONLY.test(due) ? due : null;

      return {
        name,
        category_id: category ? Number(category.id) : null,
        category_name: category ? category.name : null,
        due_date: dueDate,
      };
    })
    .filter(Boolean);
}

export default router;
