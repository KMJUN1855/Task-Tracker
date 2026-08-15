import { Router } from 'express';
import { all } from '../db.js';
import { wrap, badRequest, HttpError, requireString, parseTimeZone } from '../http.js';

/**
 * Bulk task entry via Groq (OpenAI-compatible chat completions).
 *
 * This router is deliberately self-contained and fails soft: no API key, a rate
 * limit, or the provider being down affects only these two endpoints. Nothing
 * else in the app calls it, and the UI hides the button when /status says it is
 * off.
 *
 * It never writes to the database - it returns suggestions, and the browser
 * creates tasks through the ordinary POST /api/tasks after the user has
 * reviewed them.
 */
const router = Router();

const API_ROOT = 'https://api.groq.com/openai/v1';
const DEFAULT_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_INPUT_CHARS = 8000;
const MAX_ITEMS = 50;
const TIMEOUT_MS = 30000;
const TRANSIENT_RETRIES = 2;
const RETRY_DELAY_MS = 700;

const apiKey = () => process.env.GROQ_API_KEY?.trim() || null;

/** Model ids come and go; remember whichever one worked. */
let resolvedModel = null;

/**
 * GET /api/ai/status - lets the UI hide the feature instead of failing later.
 * `retries` also makes it possible to tell which build is live without spending
 * an API call.
 */
router.get('/status', (req, res) => {
  res.json({
    configured: Boolean(apiKey()),
    provider: 'groq',
    model: resolvedModel ?? DEFAULT_MODEL,
    retries: TRANSIENT_RETRIES,
  });
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
        'AI bulk add is not configured. Set GROQ_API_KEY on the server to enable it.',
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

    const raw = await callGroq(key, buildPrompt(text, categories, today, timeZone));
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
- Use the leaf item's own wording as the name. Do NOT prefix it with its parent
  heading - the heading is usually just a grouping and the category already
  records it. Only add context when the item alone would be meaningless, e.g.
  a bare "chapter 7" under "PHYS 381" becomes "PHYS 381 - read chapter 7".
- Keep each name short and imperative-ish; do not invent work that is not there.
- due_date: only when the text actually implies a date. Resolve relative hints
  ("tomorrow", "next Friday", "by the 20th") against today's date and return
  YYYY-MM-DD. If there is no date hint at all, return null. Never guess.
- Return at most ${MAX_ITEMS} tasks.

Return json in exactly this shape:
{"tasks": [{"name": "string", "category": "string or null", "due_date": "YYYY-MM-DD or null"}]}

Text to split:
"""
${text}
"""`;
}

/* --------------------------------------------------------------------- api */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function generate(key, model, prompt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(`${API_ROOT}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Models that exist on Groq but cannot do chat: speech, TTS, safety classifiers. */
const NOT_CHAT = /whisper|orpheus|prompt-guard|safeguard|tts|distil/;

/** Ask which models this key can use, skipping the one that just failed. */
async function discoverModel(key, failedModel) {
  const res = await fetch(`${API_ROOT}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) return null;
  const body = await res.json();

  const usable = (body.data ?? [])
    .filter((m) => m.active !== false && Number(m.context_window ?? 0) >= 8192)
    .map((m) => String(m.id))
    .filter((id) => id !== failedModel && !NOT_CHAT.test(id));

  return (
    usable.find((id) => /llama-3\.3-70b/.test(id)) ??
    usable.find((id) => /gpt-oss-120b/.test(id)) ??
    usable.find((id) => /llama.*versatile/.test(id)) ??
    usable.find((id) => /instant/.test(id)) ??
    usable[0] ??
    null
  );
}

/**
 * A 5xx or a dropped connection is retried here rather than handed to the user
 * as "try again". 429 is deliberately NOT retried: that is a rate limit, and
 * hammering it makes it worse.
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
      console.warn(`[ai] ${timedOut ? 'timeout' : 'network error'} on ${model} (attempt ${attempt + 1})`);
      if (attempt < TRANSIENT_RETRIES) {
        await sleep(RETRY_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new HttpError(
        502,
        timedOut
          ? 'Groq took too long to answer. Please try again.'
          : 'Could not reach Groq. Check the connection and try again.',
      );
    }

    if (res.status < 500) return res;

    lastRes = res;
    lastBody = await res.text().catch(() => '');
    // Keep the upstream detail in the server log; the user gets the short line.
    console.warn(`[ai] Groq ${res.status} on ${model} (attempt ${attempt + 1}): ${lastBody.slice(0, 200)}`);
    if (attempt < TRANSIENT_RETRIES) await sleep(RETRY_DELAY_MS * (attempt + 1));
  }

  throw upstreamError(lastRes, lastBody);
}

async function callGroq(key, prompt) {
  let model = resolvedModel ?? DEFAULT_MODEL;
  let res = await generateWithRetry(key, model, prompt);

  // An unknown or retired model id comes back as 404, or 400 "model_not_found".
  if (res.status === 404 || res.status === 400) {
    const body = await res.text().catch(() => '');
    if (/model/i.test(body) && /not.?found|decommission|does not exist/i.test(body)) {
      const discovered = await discoverModel(key, model);
      if (discovered) {
        console.warn(`[ai] ${model} unavailable; falling back to ${discovered}`);
        model = discovered;
        res = await generateWithRetry(key, model, prompt);
      } else {
        throw upstreamError(res, body);
      }
    } else {
      throw upstreamError(res, body);
    }
  }

  if (!res.ok) throw upstreamError(res, await res.text().catch(() => ''));
  resolvedModel = model;

  const body = await res.json();
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new HttpError(502, 'Groq returned an empty response. Try again.');

  try {
    return JSON.parse(content);
  } catch {
    throw new HttpError(502, 'Groq returned something that was not valid JSON. Try again.');
  }
}

/** Upstream failures become messages a person can act on. */
function upstreamError(res, bodyText) {
  let detail = '';
  try {
    detail = JSON.parse(bodyText)?.error?.message ?? '';
  } catch {
    detail = String(bodyText).slice(0, 200);
  }

  if (res?.status === 429) {
    return new HttpError(
      429,
      'Groq rate limit reached. Please wait a moment and try again - everything else in the app still works.',
    );
  }
  if (res?.status === 401 || res?.status === 403) {
    return new HttpError(502, `Groq rejected the API key. Check GROQ_API_KEY. ${detail}`.trim());
  }
  if (res?.status === 404 || res?.status === 400) {
    return new HttpError(
      502,
      `Groq could not use model "${resolvedModel ?? DEFAULT_MODEL}". Set GROQ_MODEL to one your key supports. ${detail}`.trim(),
    );
  }
  if (!res || res.status >= 500) {
    return new HttpError(
      502,
      `Groq is having trouble right now - already retried ${TRANSIENT_RETRIES + 1} times. Please try again shortly.`,
    );
  }
  return new HttpError(502, `Groq request failed (${res.status}). ${detail}`.trim());
}

/* --------------------------------------------------------------- normalise */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Never trust the model's shape: clamp, trim and map onto real category ids. */
function normalise(raw, categories) {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.tasks)
      ? raw.tasks
      : Array.isArray(raw?.items)
        ? raw.items
        : [];
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
