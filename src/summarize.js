// Turns a cleaned email into a chat-sized "gist". Uses Claude when an API key is
// configured; otherwise falls back to the offline heuristics from cleaner.js.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-opus-5-5';

const SYSTEM = `You turn emails into short, chat-style messages for someone who finds long emails hard to read.
Rules:
- Write like a friend texting: plain words, short sentences, no corporate language.
- Drop greetings, pleasantries, sign-offs, disclaimers, marketing fluff and anything repeated.
- Never invent facts. If something is unclear, say so briefly.
- Anything the reader must DO goes in action_items, with the deadline if one is given.
- Every date, time, amount of money, place or reference number that matters must appear somewhere.
- reply_suggestions: up to 3 short replies the reader could send (under 12 words each). Empty for newsletters, receipts and automated mail.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['gist', 'category', 'urgency', 'key_points', 'action_items', 'dates', 'questions', 'reply_suggestions'],
  properties: {
    gist: { type: 'string', description: 'One sentence, max ~15 words, saying what this email is really about.' },
    category: { type: 'string', enum: ['person', 'receipt', 'newsletter', 'promo', 'notification'] },
    urgency: { type: 'string', enum: ['high', 'normal', 'low'] },
    key_points: { type: 'array', items: { type: 'string' }, description: 'At most 4 short bullets of essential info.' },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task', 'due'],
        properties: { task: { type: 'string' }, due: { type: 'string', description: 'Deadline, or empty string.' } },
      },
    },
    dates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['what', 'when'],
        properties: { what: { type: 'string' }, when: { type: 'string' } },
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'Questions the sender asked the reader, rephrased simply.' },
    reply_suggestions: { type: 'array', items: { type: 'string' } },
  },
};

const words = (s) => s.split(/\s+/).length;

// Offline headline: the most informative short sentence (money, dates, numbers win).
function pickGist(cleaned, subject) {
  const candidates = cleaned.keyPoints;
  if (!candidates.length) return subject || '(no text)';
  const score = (s) =>
    (/[£$€]\s?\d/.test(s) ? 3 : 0) +
    (cleaned.dates.some((d) => s.includes(d)) ? 2 : 0) +
    (/\d/.test(s) ? 1 : 0) -
    (words(s) > 25 ? 3 : 0) -
    candidates.indexOf(s) * 0.5;
  const best = [...candidates].sort((a, b) => score(b) - score(a))[0];
  return words(best) > 30 ? `${best.split(/\s+/).slice(0, 25).join(' ')}…` : best;
}

function heuristicSummary(cleaned, subject) {
  const gist = pickGist(cleaned, subject);
  return {
    source: 'offline',
    gist,
    category: cleaned.category,
    urgency: cleaned.urgency,
    key_points: cleaned.keyPoints.filter((p) => p !== gist && !gist.startsWith(p.slice(0, 40))),
    action_items: cleaned.actions.slice(0, 4).map((task) => ({ task, due: '' })),
    dates: cleaned.dates.slice(0, 4).map((when) => ({ what: '', when })),
    questions: cleaned.questions.slice(0, 4),
    reply_suggestions: cleaned.category === 'person' ? ['Thanks, got it 👍', 'Will do', 'Can we talk about this?'] : [],
  };
}

async function aiSummary(apiKey, email, cleaned) {
  const client = new Anthropic({ apiKey });
  const attachments = (email.attachments || []).map((a) => a.filename).join(', ') || 'none';
  const prompt = `From: ${email.from?.name || ''} <${email.from?.address || ''}>
Subject: ${email.subject || ''}
Date: ${email.date || ''}
Attachments: ${attachments}

Email (quoted replies and signatures already removed):
"""
${cleaned.body || '(empty)'}
"""`;

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Model declined to summarise this email');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { source: 'ai', ...JSON.parse(text) };
}

/**
 * @returns {Promise<object>} summary; never throws, falls back to offline mode.
 */
async function summarize({ apiKey, email, cleaned }) {
  if (!apiKey || !cleaned.body) return heuristicSummary(cleaned, email.subject);
  try {
    return await aiSummary(apiKey, email, cleaned);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ...heuristicSummary(cleaned, email.subject), error: 'Claude API key was rejected — using offline mode.' };
    }
    return { ...heuristicSummary(cleaned, email.subject), error: `AI summary failed: ${err.message}` };
  }
}

module.exports = { summarize, heuristicSummary };
