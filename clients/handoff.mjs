// Handoff API client for JavaScript (Node 20+ and browsers). One file, no packages.
//
//   import { Handoff } from './handoff.mjs';
//   const h = new Handoff('https://claude.example.com', 'hk_...');   // or HANDOFF_URL / HANDOFF_KEY
//   const turn = await h.chat('What changed in my last commit?');    // waits for the answer
//   console.log(turn.text);
//   for await (const piece of h.stream('/chat', { prompt: 'Explain this repo' })) if (piece.event === 'text') process.stdout.write(piece.data.text);
//
// Every method returns the API's JSON (see /api/v1/docs). Failures throw HandoffError (code, message, status).
const env = typeof process !== 'undefined' ? process.env : {};

export class HandoffError extends Error {
  constructor(status, code, message, body) { super(message); this.status = status; this.code = code; this.body = body; }
}

// a file to attach: { name, data (base64) } from a Buffer, a Uint8Array or a string
export function file(name, content) {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const b64 = typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : btoa(String.fromCharCode(...bytes));
  return { name, data: b64 };
}

export class Handoff {
  constructor(url = env.HANDOFF_URL, key = env.HANDOFF_KEY) {
    if (!url || !key) throw new Error('Handoff needs its address and an API key (or HANDOFF_URL and HANDOFF_KEY).');
    this.base = String(url).replace(/\/+$/, '').replace(/\/api\/v1$/, '') + '/api/v1';
    this.key = key;
  }

  async request(method, path, body) {
    const r = await fetch(this.base + path, {
      method, headers: { Authorization: `Bearer ${this.key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) throw new HandoffError(r.status, json?.error?.code || 'http_error', json?.error?.message || `${r.status} ${r.statusText}`, json);
    return json;
  }

  // waits for a turn (or a comparison) to finish, polling while the API says "still working" (202)
  async finish(first, what = 'turns') {
    let t = first;
    while (t && (t.status === 'queued' || t.status === 'running' || t.status === 'waiting_for_approval' || t.status === 'waiting_for_answer')) {
      t = await this.request('GET', `/${what}/${t.id}?wait=60`);
    }
    return t;
  }

  // ----- sending (opts: session, project, model, effort, mode, tools, files, images, plain, language, length, ...) -----
  async chat(prompt, opts = {}) { return this.finish(await this.request('POST', '/chat', { prompt, ...opts })); }
  async newSession(prompt, opts = {}) { return this.finish(await this.request('POST', '/sessions', { prompt, ...opts })); }
  async send(sessionId, prompt, opts = {}) { return this.finish(await this.request('POST', `/sessions/${sessionId}/messages`, { prompt, ...opts })); }
  async ask(sessionId, prompt, opts = {}) { return this.finish(await this.request('POST', `/sessions/${sessionId}/ask`, { prompt, ...opts })); }
  async compare(prompt, models, opts = {}) { return this.finish(await this.request('POST', '/compare', { prompt, models, ...opts }), 'compare'); }

  // Server-Sent Events of a send: yields { event, data } (text pieces, steps, approvals, done)
  async *stream(path, body) {
    const r = await fetch(this.base + path, { method: 'POST', headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new HandoffError(r.status, j.error?.code || 'http_error', j.error?.message || r.statusText, j); }
    const reader = r.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = (/^event: (.*)$/m.exec(block) || [])[1];
        const data = (/^data: (.*)$/m.exec(block) || [])[1];
        if (event && data && event !== 'ping') yield { event, data: JSON.parse(data) };
      }
    }
  }

  // ----- reading -----
  me() { return this.request('GET', '/me'); }
  models() { return this.request('GET', '/models'); }
  projects() { return this.request('GET', '/projects'); }
  sessions(params = {}) { return this.request('GET', `/sessions?${new URLSearchParams(params)}`); }
  session(id) { return this.request('GET', `/sessions/${id}`); }
  messages(id, params = {}) { return this.request('GET', `/sessions/${id}/messages?${new URLSearchParams(params)}`); }
  search(q) { return this.request('GET', `/search?${new URLSearchParams({ q })}`); }
  turn(id, wait = 0) { return this.request('GET', `/turns/${id}?wait=${wait}`); }
  turns(params = {}) { return this.request('GET', `/turns?${new URLSearchParams(params)}`); }
  usage(days = 30) { return this.request('GET', `/usage?days=${days}`); }

  // ----- picking a session, approvals, stopping -----
  select(sessionId) { return sessionId ? this.request('PUT', '/selection', { session: sessionId }) : this.request('DELETE', '/selection'); }
  selection() { return this.request('GET', '/selection'); }
  approvals() { return this.request('GET', '/approvals'); }
  approve(id, allow = true, opts = {}) { return this.request('POST', `/approvals/${id}`, { allow, ...opts }); }
  cancel(turnId) { return this.request('DELETE', `/turns/${turnId}`); }
  interrupt(sessionId) { return this.request('POST', `/sessions/${sessionId}/interrupt`); }
  stop(sessionId) { return this.request('POST', `/sessions/${sessionId}/stop`); }
}
