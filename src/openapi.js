// The API's OpenAPI 3.1 description (GET /api/v1/openapi.json) and its Swagger UI page
// (GET /api/v1/docs). Both are public: no secrets are in them, and every call still needs a key.
// Swagger UI loads in the viewer's browser from jsDelivr at a fixed version; nothing is downloaded
// onto this computer, and the page gets its own Content-Security-Policy allowing just that.
const SWAGGER = 'https://cdn.jsdelivr.net/npm/swagger-ui-dist@5.17.14';

const ref = name => ({ $ref: `#/components/schemas/${name}` });
const ok = (schema, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = { 400: { $ref: '#/components/responses/Error' }, 401: { $ref: '#/components/responses/Error' }, 403: { $ref: '#/components/responses/Error' }, 404: { $ref: '#/components/responses/Error' }, 429: { $ref: '#/components/responses/Error' } };
const id = { name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }, description: 'Session id' };
const turnId = { name: 'turnId', in: 'path', required: true, schema: { type: 'string' } };
const qp = (name, schema, description) => ({ name, in: 'query', schema, description });
const body = (schema, multipart = false) => ({ required: true, content: { 'application/json': { schema }, ...(multipart ? { 'multipart/form-data': { schema: { type: 'object', properties: { prompt: { type: 'string' }, json: { type: 'string', description: 'Any other fields, as JSON' }, file: { type: 'string', format: 'binary' } } } } } : {}) } });
const turnResponses = { 200: ok(ref('Turn'), 'Finished in time'), 202: ok(ref('Turn'), 'Still working: poll the Location, GET /turns/{turnId}?wait=60'), 402: { $ref: '#/components/responses/Error' }, ...errors };
const op = (tag, summary, extra = {}) => ({ tags: [tag], summary, ...extra });

export function openapiSpec({ version, server }) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Handoff API', version,
      description: 'Use the Claude Code on your computer from your own programs: send prompts and get answers, pick sessions and continue them with their context, attach photos and files, approve what Claude wants to do, and more. Works while the computer and Handoff are running. Keys: the web app (menu → API access) or `node scripts/api-key.js create`. Guide: https://github.com/mmehran/handoff/blob/main/docs/api.md'
    },
    servers: [{ url: server }],
    security: [{ bearer: [] }, { apiKey: [] }],
    tags: [{ name: 'Basics' }, { name: 'Sessions' }, { name: 'Sending' }, { name: 'Turns' }, { name: 'Approvals' }, { name: 'Files' }, { name: 'Git' }, { name: 'OpenAI-compatible' }],
    paths: {
      '/health': { get: op('Basics', 'Is the computer up?', { security: [], responses: { 200: ok({ type: 'object', properties: { ok: { type: 'boolean' }, version: { type: 'string' }, claudeSignedIn: { type: ['boolean', 'null'] } } }) } }) },
      '/me': { get: op('Basics', 'This key: its permissions, limits, defaults, today\'s use and selected session', { responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/usage': { get: op('Basics', 'Turns, tokens and cost per day', { parameters: [qp('days', { type: 'integer', default: 30, maximum: 90 })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/models': { get: op('Basics', 'Models (with their effort levels), as the installed Claude Code reports them; the OpenAI list shape', { responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/projects': { get: op('Sessions', 'Project folders this key can see', { responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions': {
        get: op('Sessions', 'Every session across projects, newest first, paged', { parameters: [qp('project', { type: 'string' }, 'A project key, full path or unique name'), qp('q', { type: 'string' }, 'Words in the title'), qp('live', { type: 'boolean' }), qp('via', { type: 'string', enum: ['api'] }), qp('limit', { type: 'integer', default: 50, maximum: 200 }), qp('before', { type: 'number' }, 'The `next` cursor of the previous page')], responses: { 200: ok({ type: 'object', properties: { sessions: { type: 'array', items: ref('Session') }, next: { type: ['number', 'null'] } } }), ...errors } }),
        post: op('Sending', 'Start a session', { requestBody: body(ref('Send'), true), responses: turnResponses })
      },
      '/sessions/{id}': { get: op('Sessions', 'One session: status, waiting approvals or question, activity summary', { parameters: [id], responses: { 200: ok(ref('Session')), ...errors } }) },
      '/sessions/{id}/messages': {
        get: op('Sessions', 'The conversation, newest last, paged backwards', { parameters: [id, qp('format', { type: 'string', enum: ['chat', 'events'], default: 'chat' }), qp('limit', { type: 'integer', default: 100, maximum: 500 }), qp('before', { type: 'integer' }, 'The `before` cursor of the previous page')], responses: { 200: ok({ type: 'object' }), ...errors } }),
        post: op('Sending', 'Send a prompt to a session (continues it, with its context)', { parameters: [id], requestBody: body(ref('Send'), true), responses: turnResponses })
      },
      '/sessions/{id}/ask': { post: op('Sending', 'Ask without a trace: an unsaved copy answers; the session is left as it is', { parameters: [id], requestBody: body(ref('Send'), true), responses: turnResponses }) },
      '/sessions/{id}/activity': { get: op('Sessions', 'To-dos, plan, files changed, commands, sub-agents', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/search': { get: op('Sessions', 'Search inside one session', { parameters: [id, qp('q', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/interrupt': { post: op('Sending', 'Stop what Claude is doing now; the session stays open', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/stop': { post: op('Sending', 'End the session\'s process; its queued turns are cancelled', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/answer': { post: op('Approvals', 'Answer a question in a session open on the computer', { parameters: [id], requestBody: body({ type: 'object', properties: { picks: { type: 'array', items: { type: 'integer' } }, text: { type: 'string' } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/search': { get: op('Sessions', 'Search every session', { parameters: [qp('q', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/chat': { post: op('Sending', 'The simple one: continues the selected session, or starts one', { requestBody: body({ allOf: [ref('Send'), { type: 'object', properties: { session: { type: 'string', description: 'A session id, "new" or "latest"; without it, the selected session (or a new one)' }, select: { type: 'boolean' } } }] }, true), responses: turnResponses }) },
      '/selection': {
        get: op('Sending', 'The session /chat continues', { responses: { 200: ok({ type: 'object' }), ...errors } }),
        put: op('Sending', 'Pick the session /chat continues', { requestBody: body({ type: 'object', required: ['session'], properties: { session: { type: 'string', format: 'uuid' } } }), responses: { 200: ok({ type: 'object' }), ...errors } }),
        delete: op('Sending', 'Forget the selection', { responses: { 200: ok({ type: 'object' }), ...errors } })
      },
      '/turns': { get: op('Turns', 'This key\'s recent turns, newest first', { parameters: [qp('session', { type: 'string' }), qp('status', { type: 'string' }), qp('limit', { type: 'integer', default: 50 })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/turns/{turnId}': {
        get: op('Turns', 'A turn; waits up to `wait` seconds for it to finish or change', { parameters: [turnId, qp('wait', { type: 'integer', default: 60, maximum: 90 }), qp('format', { type: 'string', enum: ['json', 'text'] })], responses: { 200: ok(ref('Turn')), 202: ok(ref('Turn'), 'Still working'), ...errors } }),
        delete: op('Turns', 'Cancel a queued turn, or interrupt the running one', { parameters: [turnId], responses: { 200: ok(ref('Turn')), ...errors } })
      },
      '/turns/{turnId}/stream': { get: op('Turns', 'The turn\'s events (Server-Sent Events): status, text, message, tool, tool_result, approval, done, error, ping', { parameters: [turnId], responses: { 200: { description: 'text/event-stream' }, ...errors } }) },
      '/approvals': { get: op('Approvals', 'Tool requests waiting in sessions this key can see', { responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/approvals/{approvalId}': { post: op('Approvals', 'Allow or deny a request', { parameters: [{ name: 'approvalId', in: 'path', required: true, schema: { type: 'string' } }], requestBody: body({ type: 'object', required: ['allow'], properties: { allow: { type: 'boolean' }, message: { type: 'string' }, alwaysMode: { type: 'string', description: 'Allow, and switch the session to this mode (one of the key\'s modes)' } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/compare': { post: op('Sending', 'One prompt to 2-3 models, answers side by side (nothing saved)', { requestBody: body({ allOf: [ref('Send'), { type: 'object', required: ['models'], properties: { models: { type: 'array', minItems: 2, maxItems: 3, items: { oneOf: [{ type: 'string' }, { type: 'object', properties: { model: { type: 'string' }, effort: { type: 'string' } } }] } }, session: { type: 'string', format: 'uuid' } } }] }), responses: { 200: ok({ type: 'object' }), 202: ok({ type: 'object' }), ...errors } }) },
      '/compare/{compareId}': { get: op('Sending', 'A comparison; waits like a turn', { parameters: [{ name: 'compareId', in: 'path', required: true, schema: { type: 'string' } }, qp('wait', { type: 'integer', default: 60 })], responses: { 200: ok({ type: 'object' }), 202: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/files': { get: op('Files', 'A folder in the session\'s project (scope files)', { parameters: [id, qp('path', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/file': { get: op('Files', 'A file\'s text', { parameters: [id, qp('path', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/download': { get: op('Files', 'Download a file', { parameters: [id, qp('path', { type: 'string' })], responses: { 200: { description: 'The file' }, ...errors } }) },
      '/sessions/{id}/find': { get: op('Files', 'Find files by name', { parameters: [id, qp('q', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/changes': { get: op('Files', 'Uncommitted git changes', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/diff': { get: op('Files', 'One file\'s diff', { parameters: [id, qp('path', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/folders': {
        get: op('Files', 'The computer\'s drives and folders (keys with every project)', { parameters: [qp('path', { type: 'string' })], responses: { 200: ok({ type: 'object' }), ...errors } }),
        post: op('Files', 'Make a new project folder', { requestBody: body({ type: 'object', properties: { parent: { type: 'string' }, name: { type: 'string' }, git: { type: 'boolean' } } }), responses: { 200: ok({ type: 'object' }), ...errors } })
      },
      '/sessions/{id}/commit-message': { post: op('Git', 'Claude writes a commit message for the changes', { parameters: [id], requestBody: body({ type: 'object', properties: { paths: { type: 'array', items: { type: 'string' } } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/commit': { post: op('Git', 'Commit (all changes, or these paths)', { parameters: [id], requestBody: body({ type: 'object', required: ['message'], properties: { message: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/push': { post: op('Git', 'Push the branch', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/discard': { post: op('Git', 'Discard one file\'s changes (a copy is kept)', { parameters: [id], requestBody: body({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/sessions/{id}/worktree/remove': { post: op('Git', 'Remove the session\'s worktree (its branch stays)', { parameters: [id], responses: { 200: ok({ type: 'object' }), ...errors } }) },
      '/chat/completions': { post: op('OpenAI-compatible', 'OpenAI chat completions. Continues a conversation by its last reply; X-Handoff-Session picks a session', { requestBody: body({ type: 'object', required: ['messages'], properties: { model: { type: 'string' }, messages: { type: 'array', items: { type: 'object' } }, stream: { type: 'boolean' }, reasoning_effort: { type: 'string' }, response_format: { type: 'object' } } }), responses: { 200: ok({ type: 'object' }), ...errors } }) }
    },
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer', description: 'Authorization: Bearer hk_…' },
        apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key' }
      },
      responses: { Error: { description: 'An error', content: { 'application/json': { schema: ref('Error') } } } },
      schemas: {
        Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } } } } },
        Send: {
          type: 'object',
          properties: {
            prompt: { type: 'string', maxLength: 100000 },
            model: { type: 'string', description: 'From GET /models, e.g. opus, sonnet, haiku, or a full claude-… id' },
            effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
            mode: { type: 'string', enum: ['manual', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] },
            project: { type: 'string', description: 'New sessions: a project key, full path or unique name' },
            worktree: { oneOf: [{ type: 'boolean' }, { type: 'string' }], description: 'New sessions: their own git worktree and branch' },
            fork: { type: 'boolean' }, save: { type: 'boolean', description: 'false: a one-off, nothing saved' },
            tools: { type: 'string', enum: ['all', 'readOnly', 'none'], description: 'New sessions, forks and one-offs only' },
            system: { type: 'string' }, schema: { type: 'object', description: 'A JSON Schema; the answer then has `json`' }, maxBudgetUsd: { type: 'number' },
            language: { type: 'string' }, length: { type: 'string', enum: ['brief', 'normal', 'detailed'] }, plain: { type: 'boolean' },
            images: { type: 'array', items: { type: 'object', properties: { media_type: { type: 'string' }, data: { type: 'string', description: 'base64' } } } },
            files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, data: { type: 'string', description: 'base64' } } } },
            ifBusy: { type: 'string', enum: ['queue', 'interrupt', 'fail'] }, ifLaptop: { type: 'string', enum: ['send', 'fork'] },
            timeout: { type: 'integer', maximum: 7200 }, webhook: { type: 'string', format: 'uri' },
            wait: { type: 'integer', default: 60, maximum: 90 }, stream: { type: 'boolean' }, format: { type: 'string', enum: ['json', 'text'] }
          }
        },
        Turn: {
          type: 'object',
          properties: {
            id: { type: 'string' }, sessionId: { type: ['string', 'null'] },
            status: { type: 'string', enum: ['queued', 'running', 'waiting_for_approval', 'waiting_for_answer', 'done', 'error', 'interrupted'] },
            text: { type: 'string' }, messages: { type: 'array', items: { type: 'string' } }, json: {},
            model: { type: 'string' }, effort: { type: ['string', 'null'] }, delivered: { type: ['string', 'null'], enum: ['new', 'handoff', 'fork', 'laptop', null] },
            usage: { type: ['object', 'null'] }, durationMs: { type: 'integer' }, steps: { type: 'array', items: { type: 'object' } },
            filesChanged: { type: 'array', items: { type: 'string' } }, pending: { type: ['object', 'null'] }, warnings: { type: 'array', items: { type: 'string' } },
            queue: { type: ['object', 'null'] }, error: { type: ['object', 'null'] }, webUrl: { type: ['string', 'null'] }
          }
        },
        Session: {
          type: 'object',
          properties: { id: { type: 'string' }, title: { type: 'string' }, project: { type: ['object', 'null'] }, cwd: { type: ['string', 'null'] }, updatedAt: { type: ['string', 'null'] }, status: { type: 'string', enum: ['laptop', 'running', 'waiting', 'idle', 'saved'] }, via: { type: ['object', 'null'] }, webUrl: { type: ['string', 'null'] } }
        }
      }
    }
  };
}

export const DOCS_CSP = `default-src 'none'; script-src 'self' ${SWAGGER}/; style-src 'unsafe-inline' ${SWAGGER}/; img-src 'self' data: ${SWAGGER}/; font-src ${SWAGGER}/; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

export const docsPage = () => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Handoff API</title>
<link rel="stylesheet" href="${SWAGGER}/swagger-ui.css" crossorigin="anonymous">
<meta name="color-scheme" content="light">
<style>:root { color-scheme: light; } body { margin: 0; background: #fff; color: #3b4151; } .swagger-ui .topbar { display: none; }</style>
</head>
<body>
<div id="swagger-ui"></div>
<script src="${SWAGGER}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
<script src="/api/v1/docs.js"></script>
</body>
</html>
`;

export const docsScript = () => `window.ui = SwaggerUIBundle({ url: '/api/v1/openapi.json', dom_id: '#swagger-ui', deepLinking: true, persistAuthorization: false, defaultModelsExpandDepth: 0 });\n`;
