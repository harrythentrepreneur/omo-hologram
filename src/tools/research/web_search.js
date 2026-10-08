// web_search — Momo's external-search hook.
//
// Real call if TAVILY_API_KEY is set; a clean "not configured" response
// if not. Either way the shape is stable so the model can narrate
// honestly ("search isn't hooked up yet — want me to send a research
// agent instead?").
//
// No new npm deps — uses Node 20 built-in fetch. 10s timeout, graceful
// network errors (returns a shaped object, never throws).

import * as datasets from '../../store/datasets.js';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const REQUEST_TIMEOUT_MS = 10_000;

export const definition = {
  type: 'function',
  name: 'web_search',
  description:
    "Search the open web for current information (news, docs, products, market data). Use when the user asks something that's clearly external or time-sensitive. Returns a dataset id plus top N {title, url, snippet}. If search isn't configured on this server, returns an honest 'not configured' summary — NEVER fabricate results.",
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language search query.',
      },
      max_results: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'How many results to return (default 5).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

export async function run(args = {}) {
  const query = String(args.query || '').trim();
  if (!query) return { error: 'query is required' };
  const max_results = Math.max(1, Math.min(10, args.max_results | 0 || 5));

  if (!process.env.TAVILY_API_KEY) {
    return {
      id: null,
      query,
      results: [],
      configured: false,
      summary:
        'Search is not configured. To enable, set TAVILY_API_KEY in .env — get a free key at https://tavily.com.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let resp, body;
  try {
    resp = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results,
        search_depth: 'basic',
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    return {
      id: null,
      query,
      results: [],
      configured: true,
      error: aborted ? `search timed out after ${REQUEST_TIMEOUT_MS}ms` : `network error: ${err?.message || err}`,
      summary: aborted
        ? `Search for "${query}" timed out.`
        : `Search for "${query}" failed: ${err?.message || 'network error'}.`,
    };
  }
  clearTimeout(timer);

  if (!resp.ok) {
    return {
      id: null,
      query,
      results: [],
      configured: true,
      error: `tavily returned ${resp.status}`,
      summary: `Search for "${query}" failed (HTTP ${resp.status}).`,
    };
  }

  try {
    body = await resp.json();
  } catch (err) {
    return {
      id: null,
      query,
      results: [],
      configured: true,
      error: `tavily returned non-JSON: ${err?.message || err}`,
      summary: `Search for "${query}" failed: upstream returned malformed JSON.`,
    };
  }

  const raw = Array.isArray(body?.results) ? body.results : [];
  const results = raw.slice(0, max_results).map((r) => ({
    title: String(r.title || r.url || '').slice(0, 200),
    url: String(r.url || ''),
    snippet: String(r.content || r.snippet || '').slice(0, 400),
  }));

  const id = datasets.put('web_results', { query, results });

  return {
    id,
    query,
    configured: true,
    results,
    count: results.length,
    summary: results.length
      ? `Found ${results.length} result${results.length === 1 ? '' : 's'} for "${query}".`
      : `No results for "${query}".`,
  };
}
