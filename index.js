// Lorebook Forge v1.3 — gera/atualiza entradas de World Info a partir do chat,
// usando a conexão/modelo JÁ configurados no SillyTavern.
// Nenhuma API key ou LLM embutido. Com índice anti-duplicata entre lorebooks
// e parser robusto (JSON cortado, aspas quebradas, texto extra).

import * as WI from '../../../world-info.js';

const MODULE = 'lorebook_forge';
const META_KEY = 'lorebook_forge';
const LOG = '[Lorebook Forge]';
const SETTINGS_VERSION = 3;

const defaultSettings = Object.freeze({
    settingsVersion: SETTINGS_VERSION,
    mode: 'single',
    target: 'chat',
    specificBook: '',
    newBookName: '',
    range: 'new',
    lastN: 60,
    preview: true,
    updateSingle: true,
    activateNewBook: true,
    chunkChars: 14000,
    responseLength: 0,          // 0 = usar o limite configurado no próprio ST
    quietFallback: true,
    maxEntries: 12,
    useSchema: false,
    extraInstructions: '',
    autoEnabled: false,
    autoEvery: 20,
    autoMode: 'single',
    // anti-duplicata
    indexScope: 'active',       // active | all | target
    indexChars: 16000,
    dupCheck: true,
    autoSkipDuplicates: true,
});

const LORE_PROPS = Object.freeze({
    position: 0,            // Before Char Defs
    selectiveLogic: 0,      // AND ANY
    selective: true,
    excludeRecursion: true, // Non-recursable
    ignoreBudget: true,
    order: 100,
    constant: false,
    disable: false,
    addMemo: true,
});

const JSON_SCHEMA = {
    name: 'LorebookEntries',
    strict: true,
    value: {
        $schema: 'http://json-schema.org/draft-04/schema#',
        type: 'object',
        properties: {
            entries: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'string' },
                        comment: { type: 'string' },
                        key: { type: 'array', items: { type: 'string' } },
                        content: { type: 'string' },
                    },
                    required: ['id', 'comment', 'key', 'content'],
                    additionalProperties: false,
                },
            },
        },
        required: ['entries'],
        additionalProperties: false,
    },
};

let busy = false;

// ───────────────────────── Helpers ─────────────────────────

const ctx = () => SillyTavern.getContext();

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = structuredClone(defaultSettings);
    const s = extensionSettings[MODULE];
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, k)) s[k] = defaultSettings[k];
    }
    if ((s.settingsVersion ?? 1) < 2 && Number(s.responseLength) === 2048) s.responseLength = 0;
    s.settingsVersion = SETTINGS_VERSION;
    return s;
}

const saveSettings = () => ctx().saveSettingsDebounced();

function getMeta() {
    const c = ctx();
    if (!c.chatMetadata) return { lastIndex: -1, single: null };
    if (!c.chatMetadata[META_KEY]) c.chatMetadata[META_KEY] = { lastIndex: -1, single: null };
    return c.chatMetadata[META_KEY];
}

function worldNames() {
    const c = ctx();
    if (typeof c.getWorldInfoNames === 'function') return c.getWorldInfoNames();
    return Array.isArray(WI.world_names) ? [...WI.world_names] : [];
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const sanitizeFileName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_').replace(/_{2,}/g, '_').trim().substring(0, 64);
const metaKey = () => WI.METADATA_KEY ?? 'world_info';

function uniqueName(base, names) {
    let name = base, i = 2;
    while (names.includes(name)) name = `${base} (${i++})`;
    return name;
}

function cleanText(t) {
    return String(t ?? '')
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ───────────────────────── Leitura do chat ─────────────────────────

function collectLines(range, lastN) {
    const c = ctx();
    const chat = c.chat ?? [];
    const meta = getMeta();
    const last = Number.isInteger(meta.lastIndex) ? meta.lastIndex : -1;

    let start = 0;
    if (range === 'new') start = last + 1;
    else if (range === 'last') start = Math.max(0, chat.length - Math.max(1, Number(lastN) || 1));

    const lines = [];
    for (let i = start; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system) continue;
        const text = cleanText(m.mes);
        if (!text) continue;
        const name = m.name || (m.is_user ? c.name1 : c.name2);
        lines.push(`${name}: ${text}`);
    }
    return { lines, lastIndex: chat.length - 1 };
}

function chunkLines(lines, maxChars) {
    const max = Math.max(2000, Number(maxChars) || 14000);
    const out = [];
    let cur = [], len = 0;
    for (let line of lines) {
        if (line.length > max) line = line.slice(0, max);
        if (len + line.length > max && cur.length) {
            out.push(cur.join('\n\n'));
            cur = []; len = 0;
        }
        cur.push(line);
        len += line.length + 2;
    }
    if (cur.length) out.push(cur.join('\n\n'));
    return out;
}

// ───────────────────────── Índice de lorebooks (anti-duplicata) ─────────────────────────

const filenameOf = (ch) => String(ch?.avatar ?? '').replace(/\.[^/.]+$/, '');

function activeBookNames(targetBook) {
    const c = ctx();
    const names = worldNames();
    const set = new Set();
    const add = (n) => { if (n && names.includes(n)) set.add(n); };

    add(targetBook);
    add(c.chatMetadata?.[metaKey()]);                                                    // lorebook do chat
    (Array.isArray(WI.selected_world_info) ? WI.selected_world_info : []).forEach(add); // globais
    add(c.powerUserSettings?.persona_description_lorebook);                              // persona

    const chars = [];
    if (c.groupId) {
        const g = (c.groups ?? []).find(x => x.id === c.groupId);
        for (const av of g?.members ?? []) {
            const ch = (c.characters ?? []).find(x => x.avatar === av);
            if (ch) chars.push(ch);
        }
    } else if (c.characterId !== undefined && c.characters?.[c.characterId]) {
        chars.push(c.characters[c.characterId]);
    }
    const charLore = Array.isArray(WI.world_info?.charLore) ? WI.world_info.charLore : [];
    for (const ch of chars) {
        add(ch?.data?.extensions?.world);                                // principal
        const extra = charLore.find(e => e.name === filenameOf(ch));
        (extra?.extraBooks ?? []).forEach(add);                          // extras
    }
    return [...set];
}

async function loadKnown(targetBook, scope, targetData) {
    const c = ctx();
    let books;
    if (scope === 'all') books = [...new Set([targetBook, ...worldNames()])];
    else if (scope === 'target') books = [targetBook];
    else books = activeBookNames(targetBook);
    if (!books.includes(targetBook)) books.unshift(targetBook);

    const known = [];
    for (const b of books) {
        let data = null;
        if (b === targetBook) data = targetData;
        else {
            try { data = await c.loadWorldInfo(b); } catch (e) { console.warn(LOG, `Falha ao ler "${b}"`, e); }
        }
        for (const e of Object.values(data?.entries ?? {})) {
            if (!e || e.disable || !String(e.content ?? '').trim()) continue;
            known.push({
                book: b,
                uid: e.uid,
                comment: String(e.comment || '').trim(),
                key: Array.isArray(e.key) ? e.key.map(String).filter(Boolean) : [],
                content: String(e.content),
                isTarget: b === targetBook,
            });
        }
    }
    return { books, known };
}

function buildKnowledgeBlock(working, others, s, priorityId) {
    const budget = Math.max(3000, Number(s.indexChars) || 16000);
    const fullBudget = Math.floor(budget * 0.65);
    let used = 0;

    const ordered = [...working].sort((a, b) =>
        (Number(b.id === priorityId) - Number(a.id === priorityId)) ||
        (Number(b.status !== 'existing') - Number(a.status !== 'existing')));

    const full = [], compactTarget = [];
    for (const w of ordered) {
        const obj = { id: w.id, comment: w.comment, key: w.key, content: w.content };
        const len = JSON.stringify(obj).length;
        if (used + len <= fullBudget || w.id === priorityId) {
            full.push(obj); used += len; w.editable = true;
        } else {
            w.editable = false; compactTarget.push(w);
        }
    }

    const line = (e, withBook) =>
        `- ${withBook ? `[${e.book}] ` : ''}"${e.comment || '(untitled)'}" | keys: ${e.key.join(', ') || '-'} | ${e.content.replace(/\s+/g, ' ').slice(0, 140)}`;

    let truncated = false, sent = full.length;
    const targetCompact = [], otherLines = [];
    for (const w of compactTarget) {
        const l = line(w, false);
        if (used + l.length > budget) { truncated = true; continue; }
        targetCompact.push(l); used += l.length; sent++;
    }
    for (const e of others) {
        const l = line(e, true);
        if (used + l.length > budget) { truncated = true; continue; }
        otherLines.push(l); used += l.length; sent++;
    }
    return { full, targetCompact, otherLines, truncated, sent, total: working.length + others.length };
}

// ───── Checagem local de duplicatas ─────

const STOP = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'com', 'em', 'no', 'na', 'para', 'por', 'the', 'of', 'and']);
function tokens(s) {
    return new Set(norm(s).replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(t => t.length >= 3 && !STOP.has(t)));
}
function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let i = 0;
    for (const x of a) if (b.has(x)) i++;
    return i / (a.size + b.size - i);
}
function sharedKeys(a, b) {
    const B = (b ?? []).map(norm).filter(Boolean);
    const out = [];
    for (const k of a ?? []) {
        const nk = norm(k);
        if (!nk) continue;
        if (B.some(x => x === nk || (nk.length >= 4 && x.length >= 4 && (x.includes(nk) || nk.includes(x))))) out.push(k);
    }
    return out;
}
function findDuplicates(item, pool) {
    const t = tokens(item.comment);
    const hits = [];
    for (const e of pool) {
        const sk = sharedKeys(item.key, e.key);
        const ts = jaccard(t, tokens(e.comment));
        if (sk.length >= 2 || (sk.length >= 1 && ts >= 0.5) || ts >= 0.75) {
            hits.push({ book: e.book, comment: e.comment, shared: sk, score: sk.length + ts });
        }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, 3);
}
const dupText = (d) => d.map(x => `"${x.comment || '(sem título)'}" [${x.book}]${x.shared.length ? ` — palavras em comum: ${x.shared.join(', ')}` : ''}`).join('; ');

// ───────────────────────── Prompts ─────────────────────────

function buildSystemPrompt() {
    return [
        'You are an expert Lorebook (World Info) archivist for the SillyTavern roleplay engine.',
        'You read roleplay chat logs and distill them into compact, high-signal long-term memory entries that will be injected into future prompts.',
        'You maintain a consistent knowledge base: you NEVER create duplicate or overlapping entries.',
        '',
        'STRICT OUTPUT FORMAT:',
        '- Reply with ONE valid JSON object and NOTHING else: no markdown, no code fences, no explanations.',
        '- Keep any internal reasoning brief; the final answer must be the JSON object.',
        '- Shape: {"entries":[{"id":"","comment":"...","key":["...","...","..."],"content":"- ...\\n- ..."}]}',
        '- Use double quotes. Inside strings, escape double quotes as \\" and line breaks as \\n. No trailing commas.',
        '',
        'FIELD RULES:',
        '- "id": the id of the existing entry you are updating (from section A), or "" for a new entry.',
        '- "comment": short, descriptive title in Brazilian Portuguese (PT-BR), max 60 characters.',
        '- "key": array with 3 to 4 strategic trigger keywords in Brazilian Portuguese (PT-BR). Prefer proper names, nicknames, places, objects and distinctive terms likely to reappear in future messages. Avoid generic words (e.g. "amor", "conversa", "dia").',
        '- "content": written in ENGLISH as short, objective bullet points. Each line starts with "- ". One fact per bullet.',
        '  Focus on relationship evolution, milestones, turning points, secrets/revelations, promises, conflicts and current status.',
        '  Always use explicit names (never an unnamed "he"/"she"). No flowery prose, no speculation, no meta commentary.',
        '- Record only what actually happened in the chat. Preserve important specifics (names, places, dates, numbers, exact promises).',
    ].join('\n');
}

function knowledgeSection(kb) {
    const out = ['KNOWLEDGE BASE — entries ALREADY stored. Read it before writing, to avoid duplicates.'];
    out.push('', 'A) EDITABLE entries in the target lorebook (full text). To update one, return it with the SAME "id" and a fully merged "content" (keep still-valid facts, fix outdated ones, add new ones):');
    out.push(kb.full.length ? JSON.stringify(kb.full) : '(none)');
    if (kb.targetCompact.length) {
        out.push('', 'B) Other entries in the target lorebook (summary only, READ-ONLY: never return them):', ...kb.targetCompact);
    }
    if (kb.otherLines.length) {
        out.push('', 'C) Entries in OTHER lorebooks (READ-ONLY: these subjects are already covered):', ...kb.otherLines);
    }
    if (kb.truncated) out.push('', '(Note: the knowledge base was truncated; a few stored entries are not listed.)');
    out.push('', 'ANTI-DUPLICATION RULES:',
        '- One subject = one entry across ALL lorebooks. Never create an entry whose subject is already covered in A, B or C.',
        '- Subject already in A -> update it via its "id" instead of creating a new entry.',
        '- Subject already in B or C -> skip it. Only if the chat reveals something genuinely new that does not belong there, create a narrowly scoped entry (e.g. "Segredo de Kael revelado") with DISTINCT keywords, without repeating stored facts.',
        '- Never reuse the exact keywords of another stored entry for a different entry.',
        '- New entries use "id": "".');
    return out;
}

function buildUserPrompt({ mode, transcript, part, total, kb, s, priorityId }) {
    const c = ctx();
    const user = c.name1 || 'User';
    const char = c.name2 || 'Character';
    const p = [];

    if (mode === 'single') {
        p.push(`TASK: Return EXACTLY ONE lorebook entry summarizing the roleplay chat log below between ${user} (the user) and ${char}: evolution of their relationship, key milestones, secrets and current status. Use 6 to 15 bullets.`);
        if (priorityId) p.push(`The entry with id "${priorityId}" in section A is the running summary of this chat: UPDATE it (return the same id), merging the new events into it.`);
        else if (s.updateSingle) p.push(`If an entry in section A already summarizes the ${user} & ${char} relationship, UPDATE it (same id). Otherwise create a new entry with "id": "".`);
        else p.push('Create a NEW entry ("id": "") covering only events that are not already stored in the knowledge base.');
    } else {
        p.push(`TASK: Build or extend a COMPLETE lorebook from the roleplay chat log below (main characters: ${user} and ${char}).`);
        p.push('Cover, in SEPARATE focused entries, every relevant subject NOT yet covered (and update covered ones in A when the chat adds information):');
        p.push('1. Each important character (identity, role, traits shown, relationship to others) — one entry per character.');
        p.push(`2. The core relationship(s) (e.g. ${user} & ${char}): evolution, milestones, current status.`);
        p.push('3. Important locations, factions/organizations and key items.');
        p.push('4. Major events/turning points and secrets/revelations (one entry per major arc or secret).');
        p.push(`Return at most ${s.maxEntries} entries (new + updated) in this reply. Do NOT return entries that need no change. Each entry: 3 to 12 bullets.`);
    }

    p.push('', ...knowledgeSection(kb));

    if (s.extraInstructions?.trim()) p.push('', 'ADDITIONAL USER INSTRUCTIONS:', s.extraInstructions.trim());

    p.push('', `CHAT LOG${total > 1 ? ` (part ${part}/${total})` : ''}:`, '<<<', transcript, '>>>');
    p.push('', 'Return ONLY the JSON object.');
    return p.join('\n');
}

// ───────────────────────── LLM ─────────────────────────

const isEmptyError = (e) => /no message generated/i.test(String(e?.message ?? e ?? ''));

async function callRaw(systemPrompt, prompt, s, responseLength) {
    const c = ctx();
    if (typeof c.generateRaw !== 'function') throw new Error('generateRaw() indisponível nesta versão do SillyTavern.');
    const opts = { systemPrompt, prompt };
    if (responseLength > 0) opts.responseLength = responseLength;
    if (s.useSchema) opts.jsonSchema = JSON_SCHEMA;
    const res = String(await c.generateRaw(opts) ?? '');
    if (!res.trim()) throw new Error('No message generated');
    return res;
}

async function callQuiet(systemPrompt, prompt, responseLength) {
    const c = ctx();
    if (typeof c.generateQuietPrompt !== 'function') throw new Error('No message generated');
    const opts = { quietPrompt: `${systemPrompt}\n\n${prompt}`, skipWIAN: true, removeReasoning: true };
    if (responseLength > 0) opts.responseLength = responseLength;
    const res = String(await c.generateQuietPrompt(opts) ?? '');
    if (!res.trim()) throw new Error('No message generated');
    return res;
}

async function callLLM(systemPrompt, prompt, s, onStatus) {
    const base = Math.max(0, Number(s.responseLength) || 0);
    const budgets = [base];
    for (const b of [8192, 16384]) if (base === 0 || b > base) budgets.push(b);

    let lastErr;
    for (let i = 0; i < budgets.length; i++) {
        try {
            if (i > 0) onStatus?.(`Resposta vazia. Tentando de novo com mais tokens (${budgets[i]})…`);
            return await callRaw(systemPrompt, prompt, s, budgets[i]);
        } catch (e) {
            lastErr = e;
            console.warn(LOG, `generateRaw falhou (tokens=${budgets[i] || 'ST'}):`, e);
            if (!isEmptyError(e)) throw e;
        }
    }
    if (s.quietFallback) {
        try {
            onStatus?.('Tentando pelo pipeline principal do chat (plano B)…');
            return await callQuiet(systemPrompt, prompt, budgets[budgets.length - 1]);
        } catch (e) {
            lastErr = e;
            console.warn(LOG, 'generateQuietPrompt falhou:', e);
            if (!isEmptyError(e)) throw e;
        }
    }
    if (isEmptyError(lastErr)) {
        throw new Error('O modelo devolveu resposta vazia mesmo com mais tokens. Aumente "Max Response Length" no ST, reduza o "Reasoning Effort", ou diminua "Máx. caracteres por bloco"/"Máx. caracteres do índice" nas configs da extensão.');
    }
    throw lastErr;
}

// ───────────────────────── Parsing ─────────────────────────

function escapeNewlinesInStrings(src) {
    let out = '', inStr = false, esc = false;
    for (const ch of src) {
        if (inStr) {
            if (esc) { esc = false; out += ch; continue; }
            if (ch === '\\') { esc = true; out += ch; continue; }
            if (ch === '"') { inStr = false; out += ch; continue; }
            if (ch === '\n') { out += '\\n'; continue; }
            if (ch === '\r') continue;
            if (ch === '\t') { out += '\\t'; continue; }
            out += ch;
        } else {
            if (ch === '"') inStr = true;
            out += ch;
        }
    }
    return out;
}

function tryParse(str) {
    const attempts = [str, str.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1')];
    attempts.push(escapeNewlinesInStrings(attempts[1]));
    attempts.push(escapeNewlinesInStrings(str));
    for (const a of attempts) {
        try { return JSON.parse(a); } catch { /* próxima */ }
    }
    return undefined;
}

function normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
    const id = String(e.id ?? '').trim();
    const comment = String(e.comment ?? e.title ?? e.titulo ?? '').trim().slice(0, 100);

    let keys = e.key ?? e.keys ?? e.keywords ?? [];
    if (typeof keys === 'string') keys = keys.split(',');
    keys = [...new Set((Array.isArray(keys) ? keys : []).map(k => String(k).trim()).filter(Boolean))].slice(0, 4);

    let content = e.content ?? e.summary ?? '';
    if (Array.isArray(content)) content = content.join('\n');
    content = String(content).replace(/\\n/g, '\n')
        .split('\n').map(l => l.trim()).filter(Boolean)
        .map(l => '- ' + l.replace(/^[-•*]\s*/, ''))
        .join('\n');

    if (!comment || !content || !keys.length) return null;
    return { id, comment, key: keys, content };
}

// Fim de um objeto/array balanceado (respeitando strings). -1 = cortado.
function balancedEnd(t, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const ch = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{' || ch === '[') depth++;
        else if (ch === '}' || ch === ']') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

function itemsFrom(obj) {
    let arr = [];
    if (Array.isArray(obj)) arr = obj;
    else if (obj && Array.isArray(obj.entries)) arr = obj.entries;
    else if (obj && typeof obj === 'object' && (obj.comment || obj.content)) arr = [obj];
    return arr.map(normalizeEntry).filter(Boolean);
}

// Procura JSON em qualquer lugar do texto. Se o JSON externo estiver cortado,
// aproveita as entradas internas que vieram completas.
function scanJson(t) {
    const loose = [];
    let truncated = false;
    for (let i = 0; i < t.length; i++) {
        const ch = t[i];
        if (ch !== '{' && ch !== '[') continue;
        const end = balancedEnd(t, i);
        if (end === -1) { truncated = true; continue; }
        const obj = tryParse(t.slice(i, end + 1));
        if (obj === undefined) continue;
        const items = itemsFrom(obj);
        if (Array.isArray(obj) || Array.isArray(obj?.entries)) {
            if (items.length) return { items, truncated: false };
            continue;
        }
        if (items.length) { loose.push(...items); i = end; }
    }
    return { items: loose, truncated };
}

// Último recurso: extrai campo por campo (tolera aspas sem escape dentro do texto).
function lenientEntries(t) {
    const unesc = (v) => v.replace(/\\n/g, '\n').replace(/\\t/g, ' ').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const starts = [...t.matchAll(/"(?:comment|title)"\s*:\s*"/g)].map(m => m.index);
    const out = [];
    for (let i = 0; i < starts.length; i++) {
        const from = Math.max(0, t.lastIndexOf('{', starts[i]));
        const to = i + 1 < starts.length ? Math.max(from + 1, t.lastIndexOf('{', starts[i + 1])) : t.length;
        const seg = t.slice(from, to);
        const str = (names) => {
            const m = seg.match(new RegExp(`"(?:${names})"\\s*:\\s*"([\\s\\S]*?)"\\s*(?=,\\s*"[A-Za-z_]+"\\s*:|\\})`));
            return m ? unesc(m[1]) : '';
        };
        const km = seg.match(/"(?:key|keys|keywords)"\s*:\s*\[([\s\S]*?)\]/);
        const key = km ? [...km[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => unesc(x[1])) : [];
        const n = normalizeEntry({ id: str('id'), comment: str('comment|title'), key, content: str('content|summary') });
        if (n) out.push(n);
    }
    return out;
}

function parseEntries(raw) {
    const t = String(raw)
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^[\s\S]*<\/(?:think|thinking|reasoning)>/i, '')
        .trim();

    const texts = [];
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) texts.push(fence[1]);
    texts.push(t);

    let truncated = false;
    for (const text of texts) {
        const r = scanJson(text);
        if (r.items.length) {
            r.items.partial = r.truncated;
            return r.items;
        }
        truncated ||= r.truncated;
    }

    const lenient = lenientEntries(t);
    if (lenient.length) return lenient;

    const preview = t.replace(/\s+/g, ' ').slice(0, 160);
    const err = new Error(truncated
        ? 'A resposta do modelo veio CORTADA antes do JSON terminar (limite de tokens de saída).'
        : `Resposta do modelo não é um JSON válido.${preview ? ` Início da resposta: "${preview}…"` : ' (a resposta veio vazia depois de remover o raciocínio)'}`);
    err.truncated = truncated;
    throw err;
}

async function askWithRetry(sys, prompt, s, onStatus) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
        let p = prompt;
        if (attempt > 0) {
            if (lastErr?.truncated) {
                p += '\n\nIMPORTANT: Your previous reply was CUT OFF before the JSON ended (output limit). This time return FEWER and SHORTER entries (in full-lorebook mode at most 4 entries; at most 8 short bullets per entry) and keep any reasoning minimal. Reply with ONLY the raw JSON object.';
                onStatus?.(`Resposta cortada. Pedindo uma versão mais curta… (tentativa ${attempt + 1}/3)`);
            } else {
                p += '\n\nIMPORTANT: Your previous reply was NOT valid JSON. Reply with ONLY the raw JSON object, starting with { and ending with }. Inside strings, escape double quotes as \\" and line breaks as \\n.';
                onStatus?.(`JSON inválido. Pedindo de novo ao modelo… (tentativa ${attempt + 1}/3)`);
            }
        }
        const raw = await callLLM(sys, p, s, onStatus);
        console.log(LOG, `Resposta bruta (tentativa ${attempt + 1}):`, raw);
        try {
            const items = parseEntries(raw);
            if (items.partial) {
                toastr.warning(`A resposta veio cortada. ${items.length} entrada(s) completas foram aproveitadas; rode de novo para completar o resto.`, 'Lorebook Forge');
            }
            return items;
        } catch (e) {
            lastErr = e;
            console.warn(LOG, e.message);
        }
    }
    if (lastErr?.truncated) {
        lastErr.message += ' Aumente o "Max Response Length" no SillyTavern, reduza "Máx. entradas por bloco" nas configs da extensão, ou use o modo "Entrada única".';
    }
    throw lastErr;
}

// ───────────────────────── Lorebook (World Info) ─────────────────────────

function resolveTarget(s) {
    const c = ctx();
    const names = worldNames();

    switch (s.target) {
        case 'chat': {
            const cur = c.chatMetadata?.[metaKey()];
            if (cur && names.includes(cur)) return { book: cur, create: false };
            const name = uniqueName(sanitizeFileName(`Chat Book ${c.getCurrentChatId()}`), names);
            return { book: name, create: true, bindChat: true };
        }
        case 'character': {
            const w = c.characters?.[c.characterId]?.data?.extensions?.world;
            if (w && names.includes(w)) return { book: w, create: false };
            throw new Error('O personagem atual não tem um lorebook principal vinculado. Escolha outro destino.');
        }
        case 'editor': {
            const txt = $('#world_editor_select option:selected').text().trim();
            if (txt && names.includes(txt)) return { book: txt, create: false };
            throw new Error('Nenhum lorebook aberto no editor de World Info.');
        }
        case 'specific': {
            if (s.specificBook && names.includes(s.specificBook)) return { book: s.specificBook, create: false };
            throw new Error('Selecione um lorebook existente.');
        }
        case 'new': {
            const date = new Date().toISOString().slice(0, 10);
            const base = sanitizeFileName(s.newBookName?.trim() || `Lorebook - ${c.name2 || 'Chat'} - ${date}`);
            return { book: uniqueName(base, names), create: true, isNew: true };
        }
        default:
            throw new Error('Destino inválido.');
    }
}

async function createBook(name) {
    const c = ctx();
    if (typeof WI.createNewWorldInfo === 'function') {
        await WI.createNewWorldInfo(name, { interactive: false });
    } else {
        await c.saveWorldInfo(name, { entries: {} }, true);
        await c.updateWorldInfoList?.();
    }
    if (!worldNames().includes(name)) await c.updateWorldInfoList?.();
}

function activateGlobally(name) {
    try {
        const idx = worldNames().indexOf(name);
        const $sel = $('#world_info');
        const $opt = $sel.find(`option[value="${idx}"]`);
        if (idx < 0 || !$opt.length) return;
        $opt.prop('selected', true);
        $sel.trigger('change');
    } catch (e) {
        console.warn(LOG, 'Não foi possível ativar o lorebook globalmente', e);
    }
}

function newEntry(book, data) {
    if (typeof WI.createWorldInfoEntry === 'function') {
        const e = WI.createWorldInfoEntry(book, data);
        if (e) return e;
    }
    const uid = Object.keys(data.entries).map(Number).filter(Number.isFinite).reduce((a, b) => Math.max(a, b), -1) + 1;
    const e = {
        uid, key: [], keysecondary: [], comment: '', content: '',
        constant: false, vectorized: false, selective: true, selectiveLogic: 0, addMemo: true,
        order: 100, position: 0, disable: false, excludeRecursion: true, preventRecursion: false,
        delayUntilRecursion: false, probability: 100, useProbability: true, depth: 4,
        group: '', groupOverride: false, groupWeight: 100, scanDepth: null, caseSensitive: null,
        matchWholeWords: null, useGroupScoring: null, automationId: '', role: null,
        sticky: 0, cooldown: 0, delay: 0, displayIndex: uid, ignoreBudget: true,
    };
    data.entries[uid] = e;
    return e;
}

function applyProps(entry, item) {
    entry.comment = item.comment;
    entry.key = [...item.key];
    if (!Array.isArray(entry.keysecondary)) entry.keysecondary = [];
    entry.content = item.content;
    Object.assign(entry, LORE_PROPS);
}

// ───────────────────────── Pipeline ─────────────────────────

async function forge({ mode, range, lastN, onStatus }) {
    const c = ctx();
    const s = getSettings();
    if (!c.getCurrentChatId?.()) throw new Error('Abra um chat antes de gerar.');

    const { lines, lastIndex } = collectLines(range, lastN);
    if (!lines.length) {
        throw new Error(range === 'new'
            ? 'Nenhuma mensagem nova desde a última execução. Use "Chat inteiro".'
            : 'Nenhuma mensagem para processar.');
    }

    const target = resolveTarget(s);
    const data = target.create ? { entries: {} } : await c.loadWorldInfo(target.book);
    if (!data) throw new Error(`Não foi possível carregar o lorebook "${target.book}".`);

    onStatus?.('Lendo lorebooks existentes…');
    const { books, known } = await loadKnown(target.book, s.indexScope, data);
    const others = known.filter(e => !e.isTarget);
    const working = known.filter(e => e.isTarget).map(e => ({
        id: `T${e.uid}`, uid: e.uid, comment: e.comment, key: [...e.key], content: e.content,
        status: 'existing', editable: false,
    }));

    let priorityId = null;
    if (mode === 'single' && s.updateSingle) {
        const m = getMeta();
        if (m.single?.book === target.book && working.some(w => w.uid === m.single.uid)) priorityId = `T${m.single.uid}`;
    }

    const sys = buildSystemPrompt();
    const chunks = chunkLines(lines, s.chunkChars);
    const stats = { books: books.length, total: known.length, sent: 0, truncated: false };
    let newCounter = 0;

    for (let k = 0; k < chunks.length; k++) {
        onStatus?.(`Gerando com o modelo conectado… parte ${k + 1}/${chunks.length}`);
        const kb = buildKnowledgeBlock(working, others, s, priorityId);
        stats.sent = kb.sent; stats.total = kb.total; stats.truncated ||= kb.truncated;

        const prompt = buildUserPrompt({ mode, s, transcript: chunks[k], part: k + 1, total: chunks.length, kb, priorityId });
        const items = await askWithRetry(sys, prompt, s, onStatus);
        const use = mode === 'single' ? items.slice(0, 1) : items.slice(0, Number(s.maxEntries) || 12);

        for (const it of use) {
            let hit = it.id ? working.find(w => w.id === it.id && w.editable) : null;
            if (!hit) hit = working.find(w => w.editable && norm(w.comment) === norm(it.comment));
            if (!hit && mode === 'single' && priorityId) hit = working.find(w => w.id === priorityId);

            if (hit) {
                hit.comment = it.comment; hit.key = it.key; hit.content = it.content;
                if (hit.status === 'existing') hit.status = 'updated';
            } else {
                hit = { id: `N${++newCounter}`, uid: null, comment: it.comment, key: it.key, content: it.content, status: 'new', editable: true };
                working.push(hit);
            }
            if (mode === 'single') priorityId = hit.id; // próximos blocos atualizam a mesma entrada
        }
    }

    const changes = working.filter(w => w.status !== 'existing');
    if (!changes.length) throw new Error('O modelo não retornou nenhuma entrada nova ou atualizada (talvez tudo já esteja coberto).');

    if (s.dupCheck) {
        const changedUids = new Set(changes.filter(ch => ch.uid !== null).map(ch => ch.uid));
        const basePool = known.filter(e => !(e.isTarget && changedUids.has(e.uid)));
        for (const ch of changes) {
            const pool = [
                ...basePool,
                ...changes.filter(o => o !== ch).map(o => ({ book: target.book, comment: o.comment, key: o.key })),
            ];
            ch.dups = findDuplicates(ch, pool);
        }
    }

    return { target, changes, lastIndex, mode, stats };
}

async function commit(result) {
    const c = ctx();
    const s = getSettings();
    const { target, changes, lastIndex, mode } = result;
    const book = target.book;
    const meta = getMeta();

    if (!changes.length) {
        meta.lastIndex = lastIndex;
        await c.saveMetadata();
        return { book, created: 0, updated: 0 };
    }

    if (target.create && !worldNames().includes(book)) await createBook(book);

    const data = await c.loadWorldInfo(book);
    if (!data) throw new Error(`Falha ao carregar "${book}" para salvar.`);
    data.entries ??= {};

    let created = 0, updated = 0;
    for (const it of changes) {
        let entry = (it.uid !== null && it.uid !== undefined) ? data.entries[it.uid] : null;
        if (!entry) { entry = newEntry(book, data); created++; } else updated++;
        applyProps(entry, it);
        it.uid = entry.uid;
    }

    await c.saveWorldInfo(book, data, true);
    try { c.reloadWorldInfoEditor?.(book, false); } catch { /* editor fechado */ }

    if (target.bindChat) {
        c.chatMetadata[metaKey()] = book;
        $('.chat_lorebook_button').addClass('world_set');
    }
    if (target.isNew) {
        if (s.activateNewBook) activateGlobally(book);
        s.target = 'specific';
        s.specificBook = book;
        saveSettings();
    }

    meta.lastIndex = lastIndex;
    if (mode === 'single' && changes[0]) meta.single = { book, uid: changes[0].uid };
    await c.saveMetadata();

    return { book, created, updated };
}

async function runAndCommit({ mode, range, lastN, onStatus }) {
    if (busy) throw new Error('Já existe uma geração em andamento.');
    busy = true;
    try {
        const s = getSettings();
        const result = await forge({ mode, range, lastN, onStatus });
        let skipped = 0;
        if (s.dupCheck && s.autoSkipDuplicates) {
            const keep = result.changes.filter(ch => !(ch.status === 'new' && ch.dups?.length));
            skipped = result.changes.length - keep.length;
            result.changes = keep;
        }
        const r = await commit(result);
        return { ...r, skipped, truncated: result.stats.truncated };
    } finally {
        busy = false;
    }
}

function resultMessage(r) {
    let msg = `${r.created} nova(s), ${r.updated} atualizada(s)`;
    if (r.skipped) msg += `, ${r.skipped} pulada(s) por suspeita de duplicata`;
    return msg;
}

// ───────────────────────── Modal ─────────────────────────

function modalHtml(s) {
    const names = worldNames();
    const opts = names.map(n => `<option value="${escapeHtml(n)}" ${n === s.specificBook ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('');
    const sel = (v, cur) => (v === cur ? 'selected' : '');
    return `
<div class="lbf-modal">
    <h3><i class="fa-solid fa-book-medical"></i> Lorebook Forge</h3>
    <div class="lbf-grid">
        <label>Modo
            <select id="lbf_m_mode" class="text_pole">
                <option value="single" ${sel('single', s.mode)}>Entrada única (resumo da relação)</option>
                <option value="full" ${sel('full', s.mode)}>Lorebook completo (várias entradas)</option>
            </select>
        </label>
        <label>Destino
            <select id="lbf_m_target" class="text_pole">
                <option value="chat" ${sel('chat', s.target)}>Lorebook do chat (cria se não existir)</option>
                <option value="character" ${sel('character', s.target)}>Lorebook principal do personagem</option>
                <option value="editor" ${sel('editor', s.target)}>Aba aberta no editor de World Info</option>
                <option value="specific" ${sel('specific', s.target)}>Escolher lorebook existente</option>
                <option value="new" ${sel('new', s.target)}>Criar lorebook novo</option>
            </select>
        </label>
        <label class="lbf-only-specific">Lorebook
            <select id="lbf_m_book" class="text_pole">${opts}</select>
        </label>
        <label class="lbf-only-new">Nome do novo lorebook
            <input id="lbf_m_newname" class="text_pole" placeholder="(automático)" value="${escapeHtml(s.newBookName)}">
        </label>
        <label>Mensagens
            <select id="lbf_m_range" class="text_pole">
                <option value="new" ${sel('new', s.range)}>Só novas desde a última execução</option>
                <option value="all" ${sel('all', s.range)}>Chat inteiro</option>
                <option value="last" ${sel('last', s.range)}>Últimas N mensagens</option>
            </select>
        </label>
        <label class="lbf-only-last">N
            <input id="lbf_m_lastn" type="number" min="1" class="text_pole" value="${Number(s.lastN)}">
        </label>
        <label>Evitar duplicatas com
            <select id="lbf_m_scope" class="text_pole">
                <option value="active" ${sel('active', s.indexScope)}>Lorebooks ativos (chat, globais, personagem, persona)</option>
                <option value="all" ${sel('all', s.indexScope)}>TODOS os lorebooks existentes</option>
                <option value="target" ${sel('target', s.indexScope)}>Só o lorebook de destino</option>
            </select>
        </label>
    </div>
    <label class="checkbox_label"><input type="checkbox" id="lbf_m_preview" ${s.preview ? 'checked' : ''}> Pré-visualizar antes de salvar</label>
    <label class="checkbox_label"><input type="checkbox" id="lbf_m_update" ${s.updateSingle ? 'checked' : ''}> Modo único: atualizar a entrada anterior deste chat (em vez de criar outra)</label>
    <div id="lbf_m_info" class="lbf-info"></div>
    <div class="lbf-actions">
        <div id="lbf_m_go" class="menu_button menu_button_icon"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar Resumo para Lorebook</div>
    </div>
    <div id="lbf_m_status" class="lbf-status"></div>
    <div id="lbf_m_preview_area" class="lbf-preview" style="display:none">
        <div id="lbf_m_stats" class="lbf-info"></div>
        <div id="lbf_m_list" class="lbf-list"></div>
        <small>Você pode editar o JSON abaixo antes de salvar (remova itens que não quiser). Não altere os campos "_id".</small>
        <textarea id="lbf_m_json" class="text_pole" rows="14"></textarea>
        <div class="lbf-actions">
            <div id="lbf_m_save" class="menu_button menu_button_icon"><i class="fa-solid fa-floppy-disk"></i> Salvar no Lorebook</div>
            <div id="lbf_m_rmdup" class="menu_button menu_button_icon"><i class="fa-solid fa-filter-circle-xmark"></i> Remover suspeitas de duplicata</div>
            <div id="lbf_m_discard" class="menu_button menu_button_icon"><i class="fa-solid fa-trash"></i> Descartar</div>
        </div>
    </div>
</div>`;
}

async function openModal() {
    const c = ctx();
    const s = getSettings();
    const $el = $(modalHtml(s));
    let pending = null;

    const status = (msg, kind = '') => $el.find('#lbf_m_status').attr('data-kind', kind).text(msg);

    const refreshVisibility = () => {
        $el.find('.lbf-only-specific').toggle(s.target === 'specific');
        $el.find('.lbf-only-new').toggle(s.target === 'new');
        $el.find('.lbf-only-last').toggle(s.range === 'last');
        const meta = getMeta();
        const total = (c.chat ?? []).length;
        const fresh = (c.chat ?? []).filter((m, i) => i > (meta.lastIndex ?? -1) && !m.is_system).length;
        let dest = '';
        try { const t = resolveTarget(s); dest = t.create ? `${t.book} (será criado)` : t.book; } catch (e) { dest = `⚠ ${e.message}`; }
        $el.find('#lbf_m_info').html(
            `Mensagens no chat: <b>${total}</b> · Novas desde a última execução: <b>${fresh}</b><br>Destino: <b>${escapeHtml(dest)}</b>`);
    };

    $el.find('#lbf_m_mode').on('change', function () { s.mode = this.value; saveSettings(); });
    $el.find('#lbf_m_target').on('change', function () { s.target = this.value; saveSettings(); refreshVisibility(); });
    $el.find('#lbf_m_book').on('change', function () { s.specificBook = this.value; saveSettings(); refreshVisibility(); });
    $el.find('#lbf_m_newname').on('input', function () { s.newBookName = this.value; saveSettings(); refreshVisibility(); });
    $el.find('#lbf_m_range').on('change', function () { s.range = this.value; saveSettings(); refreshVisibility(); });
    $el.find('#lbf_m_lastn').on('input', function () { s.lastN = Number(this.value) || 60; saveSettings(); });
    $el.find('#lbf_m_scope').on('change', function () { s.indexScope = this.value; saveSettings(); });
    $el.find('#lbf_m_preview').on('change', function () { s.preview = this.checked; saveSettings(); });
    $el.find('#lbf_m_update').on('change', function () { s.updateSingle = this.checked; saveSettings(); });

    if (s.target === 'specific' && !s.specificBook) s.specificBook = String($el.find('#lbf_m_book').val() ?? '');
    refreshVisibility();

    const renderPreview = () => {
        const r = pending;
        const st = r.stats;
        $el.find('#lbf_m_stats').html(
            `Lorebook de destino: <b>${escapeHtml(r.target.book)}</b><br>` +
            `Índice anti-duplicata: <b>${st.books}</b> lorebook(s), <b>${st.sent}/${st.total}</b> entradas enviadas ao modelo` +
            (st.truncated ? ' — <span class="lbf-warn">⚠ índice cortado (aumente "Máx. caracteres do índice")</span>' : ''));

        const list = r.changes.map(ch => {
            const badge = ch.status === 'new' ? '<span class="lbf-badge new">NOVA</span>' : '<span class="lbf-badge updated">ATUALIZADA</span>';
            const dup = ch.dups?.length
                ? `<div class="lbf-dup">⚠️ POSSÍVEL DUPLICATA de ${ch.dups.map(d =>
                    `<b>${escapeHtml(d.comment || '(sem título)')}</b> <small>(${escapeHtml(d.book)}${d.shared.length ? ` · palavras em comum: ${d.shared.map(escapeHtml).join(', ')}` : ''})</small>`).join('; ')}</div>`
                : '';
            return `<div class="lbf-item${ch.dups?.length ? ' lbf-item-dup' : ''}">${badge} <b>${escapeHtml(ch.comment)}</b> <small>[${ch.key.map(escapeHtml).join(', ')}]</small>${dup}</div>`;
        }).join('');
        $el.find('#lbf_m_list').html(list);

        $el.find('#lbf_m_json').val(JSON.stringify(r.changes.map(ch => {
            const o = { comment: ch.comment, key: ch.key, content: ch.content, _id: ch.id, _status: ch.status };
            if (ch.dups?.length) o._aviso = `Possível duplicata de: ${dupText(ch.dups)}`;
            return o;
        }), null, 2));
        $el.find('#lbf_m_rmdup').toggle(r.changes.some(ch => ch.status === 'new' && ch.dups?.length));
        $el.find('#lbf_m_preview_area').show();
    };

    // Lê o JSON editado e reconstrói pending.changes (uid/status vêm do original pelo _id)
    const readEdited = () => {
        let edited;
        try { edited = JSON.parse(String($el.find('#lbf_m_json').val())); }
        catch { toastr.error('JSON inválido no editor.'); return null; }
        if (!Array.isArray(edited)) { toastr.error('O JSON deve ser um array de entradas.'); return null; }
        const byId = new Map(pending.changes.map(ch => [ch.id, ch]));
        return edited.map(x => {
            const n = normalizeEntry(x);
            if (!n) return null;
            const base = byId.get(x._id);
            return {
                ...n,
                id: base?.id ?? `E${Math.random().toString(36).slice(2, 8)}`,
                uid: base?.uid ?? null,
                status: base?.status ?? 'new',
                dups: base?.dups ?? [],
            };
        }).filter(Boolean);
    };

    $el.find('#lbf_m_go').on('click', async () => {
        if (busy) return;
        busy = true;
        $el.find('#lbf_m_preview_area').hide();
        const handle = c.loader?.show?.({ blocking: false, message: 'Lorebook Forge: gerando…', toastMode: 'static' });
        try {
            const result = await forge({ mode: s.mode, range: s.range, lastN: s.lastN, onStatus: m => status(m) });
            const nDup = result.changes.filter(ch => ch.dups?.length).length;
            if (result.stats.truncated) toastr.warning('Nem todas as entradas existentes couberam no prompt. A checagem local ainda considerou todas.', 'Lorebook Forge');

            if (s.preview) {
                pending = result;
                status(`✔ ${result.changes.length} entrada(s) gerada(s)${nDup ? `, ${nDup} com suspeita de duplicata` : ''}. Revise e salve.`, nDup ? 'warn' : 'ok');
                renderPreview();
            } else {
                let skipped = 0;
                if (s.dupCheck && s.autoSkipDuplicates) {
                    const keep = result.changes.filter(ch => !(ch.status === 'new' && ch.dups?.length));
                    skipped = result.changes.length - keep.length;
                    result.changes = keep;
                }
                const r = await commit(result);
                const msg = resultMessage({ ...r, skipped });
                status(`✔ Salvo em "${r.book}": ${msg}.`, 'ok');
                toastr.success(msg, `Lorebook "${r.book}"`);
                refreshVisibility();
            }
        } catch (e) {
            console.error(LOG, e);
            const msg = e?.message || String(e);
            status(`✖ ${msg}`, 'err');
            toastr.error(msg, 'Lorebook Forge');
        } finally {
            busy = false;
            await handle?.hide?.();
        }
    });

    $el.find('#lbf_m_rmdup').on('click', () => {
        if (!pending) return;
        const changes = readEdited();
        if (!changes) return;
        const before = changes.length;
        pending.changes = changes.filter(ch => !(ch.status === 'new' && ch.dups?.length));
        renderPreview();
        status(`${before - pending.changes.length} entrada(s) suspeita(s) removida(s).`);
    });

    $el.find('#lbf_m_save').on('click', async () => {
        if (!pending || busy) return;
        const changes = readEdited();
        if (!changes) return;
        if (!changes.length) return toastr.warning('Nenhuma entrada válida para salvar.');
        pending.changes = changes;

        busy = true;
        try {
            const r = await commit(pending);
            const msg = resultMessage(r);
            status(`✔ Salvo em "${r.book}": ${msg}.`, 'ok');
            toastr.success(msg, `Lorebook "${r.book}"`);
            $el.find('#lbf_m_preview_area').hide();
            pending = null;
            refreshVisibility();
        } catch (e) {
            console.error(LOG, e);
            toastr.error(e?.message || String(e), 'Lorebook Forge');
        } finally {
            busy = false;
        }
    });

    $el.find('#lbf_m_discard').on('click', () => {
        pending = null;
        $el.find('#lbf_m_preview_area').hide();
        status('Descartado.');
    });

    const popup = new c.Popup($el, c.POPUP_TYPE.TEXT, '', { okButton: 'Fechar', wide: true, allowVerticalScrolling: true });
    await popup.show();
}

// ───────────────────────── Painel de configurações ─────────────────────────

function settingsHtml(s) {
    return `
<div id="lbf_settings" class="lbf-settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-book-medical"></i> Lorebook Forge</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div id="lbf_open" class="menu_button menu_button_icon"><i class="fa-solid fa-wand-magic-sparkles"></i> Abrir Lorebook Forge</div>
            <hr>
            <b>Automático</b>
            <label class="checkbox_label"><input type="checkbox" id="lbf_auto" ${s.autoEnabled ? 'checked' : ''}> Atualizar automaticamente</label>
            <label>A cada N mensagens novas <input type="number" min="2" id="lbf_auto_every" class="text_pole" value="${Number(s.autoEvery)}"></label>
            <label>Modo automático
                <select id="lbf_auto_mode" class="text_pole">
                    <option value="single" ${s.autoMode === 'single' ? 'selected' : ''}>Entrada única</option>
                    <option value="full" ${s.autoMode === 'full' ? 'selected' : ''}>Lorebook completo</option>
                </select>
            </label>
            <small>O modo automático salva sem pré-visualização, no destino escolhido no modal.</small>
            <hr>
            <b>Anti-duplicata</b>
            <label class="checkbox_label"><input type="checkbox" id="lbf_dup" ${s.dupCheck ? 'checked' : ''}> Checar duplicatas (palavras-chave/títulos parecidos)</label>
            <label class="checkbox_label"><input type="checkbox" id="lbf_dupskip" ${s.autoSkipDuplicates ? 'checked' : ''}> Sem pré-visualização/auto: pular entradas NOVAS suspeitas</label>
            <label>Máx. caracteres do índice enviado ao modelo
                <input type="number" min="3000" id="lbf_idx" class="text_pole" value="${Number(s.indexChars)}">
            </label>
            <hr>
            <b>Avançado</b>
            <label>Tamanho máx. da resposta (tokens) — 0 = usar o do SillyTavern
                <input type="number" min="0" id="lbf_resp" class="text_pole" value="${Number(s.responseLength)}">
            </label>
            <label class="checkbox_label"><input type="checkbox" id="lbf_quiet" ${s.quietFallback ? 'checked' : ''}> Plano B: se vier vazio, tentar pelo pipeline principal do chat</label>
            <label>Máx. caracteres por bloco do chat <input type="number" min="2000" id="lbf_chunk" class="text_pole" value="${Number(s.chunkChars)}"></label>
            <label>Máx. entradas por bloco (modo completo) <input type="number" min="1" id="lbf_maxent" class="text_pole" value="${Number(s.maxEntries)}"></label>
            <label class="checkbox_label"><input type="checkbox" id="lbf_schema" ${s.useSchema ? 'checked' : ''}> Usar Structured Output / JSON Schema (só Chat Completion compatível)</label>
            <label class="checkbox_label"><input type="checkbox" id="lbf_activate" ${s.activateNewBook ? 'checked' : ''}> Ativar globalmente lorebooks novos</label>
            <label>Instruções extras para o modelo
                <textarea id="lbf_extra" class="text_pole" rows="3" placeholder="Ex.: ignore cenas de combate; foque no romance…">${escapeHtml(s.extraInstructions)}</textarea>
            </label>
            <div id="lbf_reset" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate-left"></i> Resetar progresso deste chat</div>
        </div>
    </div>
</div>`;
}

function bindSettings(s) {
    const num = (sel, key, def) => $(sel).on('input', function () {
        const v = Number(this.value);
        s[key] = Number.isFinite(v) && this.value !== '' ? v : def;
        saveSettings();
    });
    const chk = (sel, key) => $(sel).on('change', function () { s[key] = this.checked; saveSettings(); });

    $('#lbf_open').on('click', openModal);
    chk('#lbf_auto', 'autoEnabled');
    num('#lbf_auto_every', 'autoEvery', 20);
    $('#lbf_auto_mode').on('change', function () { s.autoMode = this.value; saveSettings(); });
    chk('#lbf_dup', 'dupCheck');
    chk('#lbf_dupskip', 'autoSkipDuplicates');
    num('#lbf_idx', 'indexChars', 16000);
    num('#lbf_resp', 'responseLength', 0);
    chk('#lbf_quiet', 'quietFallback');
    num('#lbf_chunk', 'chunkChars', 14000);
    num('#lbf_maxent', 'maxEntries', 12);
    chk('#lbf_schema', 'useSchema');
    chk('#lbf_activate', 'activateNewBook');
    $('#lbf_extra').on('input', function () { s.extraInstructions = this.value; saveSettings(); });
    $('#lbf_reset').on('click', async () => {
        const c = ctx();
        if (!c.chatMetadata) return;
        c.chatMetadata[META_KEY] = { lastIndex: -1, single: null };
        await c.saveMetadata();
        toastr.info('Progresso do Lorebook Forge resetado para este chat.');
    });
}

// ───────────────────────── Auto + Slash command ─────────────────────────

async function onMessageForAuto() {
    const s = getSettings();
    if (!s.autoEnabled || busy) return;
    const c = ctx();
    if (!c.getCurrentChatId?.()) return;
    const meta = getMeta();
    const last = Number.isInteger(meta.lastIndex) ? meta.lastIndex : -1;
    const fresh = (c.chat ?? []).filter((m, i) => i > last && !m.is_system).length;
    if (fresh < Math.max(2, Number(s.autoEvery) || 20)) return;

    setTimeout(async () => {
        try {
            toastr.info('Atualizando lorebook automaticamente…', 'Lorebook Forge', { timeOut: 2500 });
            const r = await runAndCommit({ mode: s.autoMode, range: 'new' });
            (r.skipped ? toastr.warning : toastr.success)(resultMessage(r), `Lorebook "${r.book}"`);
        } catch (e) {
            console.warn(LOG, 'Auto falhou:', e);
            toastr.warning(e?.message || String(e), 'Lorebook Forge (auto)');
        }
    }, 800);
}

function registerSlashCommand() {
    const c = ctx();
    if (!c.SlashCommandParser || !c.SlashCommand) return;
    try {
        c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
            name: 'lorebook-forge',
            aliases: ['lbforge'],
            helpString: 'Gera/atualiza entradas no lorebook a partir do chat. Ex.: <code>/lorebook-forge mode=full range=all</code>',
            returns: 'resumo da operação',
            namedArgumentList: [
                c.SlashCommandNamedArgument.fromProps({ name: 'mode', description: 'single | full', typeList: [c.ARGUMENT_TYPE.STRING], defaultValue: 'single', enumList: ['single', 'full'] }),
                c.SlashCommandNamedArgument.fromProps({ name: 'range', description: 'new | all | last', typeList: [c.ARGUMENT_TYPE.STRING], defaultValue: 'new', enumList: ['new', 'all', 'last'] }),
                c.SlashCommandNamedArgument.fromProps({ name: 'n', description: 'N para range=last', typeList: [c.ARGUMENT_TYPE.NUMBER], defaultValue: '60' }),
            ],
            callback: async (args) => {
                try {
                    const r = await runAndCommit({
                        mode: String(args.mode || 'single'),
                        range: String(args.range || 'new'),
                        lastN: Number(args.n) || 60,
                    });
                    const msg = `Lorebook "${r.book}": ${resultMessage(r)}.`;
                    toastr.success(msg, 'Lorebook Forge');
                    return msg;
                } catch (e) {
                    toastr.error(e?.message || String(e), 'Lorebook Forge');
                    return '';
                }
            },
        }));
    } catch (e) {
        console.warn(LOG, 'Falha ao registrar slash command', e);
    }
}

// ───────────────────────── Init ─────────────────────────

jQuery(async () => {
    const s = getSettings();
    saveSettings();
    const c = ctx();

    $('#extensions_settings2').append(settingsHtml(s));
    bindSettings(s);

    const $wand = $(`
        <div id="lbf_wand_btn" class="list-group-item flex-container flexGap5" title="Lorebook Forge">
            <div class="fa-solid fa-book-medical extensionsMenuExtensionButton"></div>
            <span>Lorebook Forge</span>
        </div>`);
    $wand.on('click', openModal);
    $('#extensionsMenu').append($wand);

    const ev = c.eventTypes ?? c.event_types;
    c.eventSource.on(ev.CHARACTER_MESSAGE_RENDERED, onMessageForAuto);

    registerSlashCommand();
    console.log(LOG, 'v1.3 carregado.');
});
