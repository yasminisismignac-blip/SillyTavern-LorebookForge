// Lorebook Forge — gera/atualiza entradas de World Info a partir do chat,
// usando a conexão/modelo JÁ configurados no SillyTavern (generateRaw).
// Nenhuma API key ou LLM embutido.

import * as WI from '../../../world-info.js'; // namespace import: não quebra se algum export mudar

const MODULE = 'lorebook_forge';
const META_KEY = 'lorebook_forge';
const LOG = '[Lorebook Forge]';

const defaultSettings = Object.freeze({
    mode: 'single',            // single | full
    target: 'chat',            // chat | character | editor | specific | new
    specificBook: '',
    newBookName: '',
    range: 'new',              // new | all | last
    lastN: 60,
    preview: true,
    updateSingle: true,
    activateNewBook: true,
    chunkChars: 14000,
    responseLength: 2048,
    maxEntries: 12,
    useSchema: false,
    extraInstructions: '',
    autoEnabled: false,
    autoEvery: 20,
    autoMode: 'single',
});

// Propriedades técnicas fixas exigidas
const LORE_PROPS = Object.freeze({
    position: 0,            // world_info_position.before  => "Before Char Defs"
    selectiveLogic: 0,      // world_info_logic.AND_ANY
    selective: true,
    excludeRecursion: true, // Non-recursable
    ignoreBudget: true,     // Ignore budget
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
                        comment: { type: 'string' },
                        key: { type: 'array', items: { type: 'string' } },
                        content: { type: 'string' },
                    },
                    required: ['comment', 'key', 'content'],
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
    for (const k of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE], k)) extensionSettings[MODULE][k] = defaultSettings[k];
    }
    return extensionSettings[MODULE];
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
        if (!m || m.is_system) continue; // ignora mensagens de sistema/ocultas
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

// ───────────────────────── Prompts ─────────────────────────

function buildSystemPrompt() {
    return [
        'You are an expert Lorebook (World Info) archivist for the SillyTavern roleplay engine.',
        'You read roleplay chat logs and distill them into compact, high-signal long-term memory entries that will be injected into future prompts.',
        '',
        'STRICT OUTPUT FORMAT:',
        '- Reply with ONE valid JSON object and NOTHING else: no markdown, no code fences, no explanations, no thinking out loud.',
        '- Shape: {"entries":[{"comment":"...","key":["...","...","..."],"content":"- ...\\n- ..."}]}',
        '- Use double quotes. Escape line breaks inside strings as \\n. No trailing commas.',
        '',
        'FIELD RULES:',
        '- "comment": short, descriptive title in Brazilian Portuguese (PT-BR), max 60 characters.',
        '- "key": array with 3 to 4 strategic trigger keywords in Brazilian Portuguese (PT-BR). Prefer proper names, nicknames, places, objects and distinctive terms likely to reappear in future messages. Avoid generic words (e.g. "amor", "conversa", "dia").',
        '- "content": written in ENGLISH as short, objective bullet points. Each line starts with "- ". One fact per bullet.',
        '  Focus on relationship evolution, milestones, turning points, secrets/revelations, promises, conflicts and current status.',
        '  Always use explicit names (never an unnamed "he"/"she"). No flowery prose, no speculation, no meta commentary.',
        '- Record only what actually happened in the chat. Preserve important specifics (names, places, dates, numbers, exact promises).',
    ].join('\n');
}

function buildUserPrompt({ mode, transcript, part, total, existing, s }) {
    const c = ctx();
    const user = c.name1 || 'User';
    const char = c.name2 || 'Character';
    const p = [];

    if (mode === 'single') {
        p.push(`TASK: Create EXACTLY ONE lorebook entry summarizing the roleplay chat log below between ${user} (the user) and ${char}.`);
        p.push('The entry must capture the evolution of their relationship, key milestones, secrets and the current status. Use 6 to 15 bullets.');
        if (existing.length) {
            p.push('', 'EXISTING ENTRY (UPDATE IT): merge it with the new events. Keep still-relevant facts, fix outdated ones, append new milestones in chronological order. Keep the same "comment" unless it no longer fits. Return the full merged entry.');
            p.push(JSON.stringify(existing[0]));
        }
    } else {
        p.push(`TASK: Build or extend a COMPLETE lorebook from the roleplay chat log below (main characters: ${user} and ${char}).`);
        p.push('Create SEPARATE, focused entries for each relevant subject:');
        p.push('1. Each important character (identity, role, traits shown, relationship to others) — one entry per character.');
        p.push(`2. The core relationship(s) (e.g. ${user} & ${char}): evolution, milestones, current status.`);
        p.push('3. Important locations, factions/organizations and key items.');
        p.push('4. Major events/turning points and secrets/revelations (one entry per major arc or secret).');
        p.push(`Return at most ${s.maxEntries} entries in this reply. Each entry: 3 to 12 bullets.`);
        if (existing.length) {
            p.push('', 'EXISTING ENTRIES IN THE LOREBOOK:');
            p.push(JSON.stringify(existing));
            p.push('If a subject is already covered, return that entry with EXACTLY the same "comment" and a fully merged, updated "content" (and refined keys). Do NOT return existing entries that need no changes. Never create duplicates.');
        }
    }

    if (s.extraInstructions?.trim()) p.push('', 'ADDITIONAL USER INSTRUCTIONS:', s.extraInstructions.trim());

    p.push('', `CHAT LOG${total > 1 ? ` (part ${part}/${total})` : ''}:`, '<<<', transcript, '>>>');
    p.push('', 'Return ONLY the JSON object.');
    return p.join('\n');
}

function existingBlock(items, cap) {
    const out = [];
    let total = 0;
    for (const it of items) {
        const o = { comment: it.comment, key: it.key, content: it.content };
        const str = JSON.stringify(o);
        if (total + str.length > cap) break;
        out.push(o);
        total += str.length;
    }
    return out;
}

// ───────────────────────── LLM + Parsing ─────────────────────────

async function callLLM(systemPrompt, prompt, s) {
    const c = ctx();
    if (typeof c.generateRaw !== 'function') throw new Error('generateRaw() indisponível nesta versão do SillyTavern.');
    const opts = { systemPrompt, prompt };
    const rl = Number(s.responseLength);
    if (rl > 0) opts.responseLength = rl;
    if (s.useSchema) opts.jsonSchema = JSON_SCHEMA;
    const res = await c.generateRaw(opts);
    return String(res ?? '');
}

// Escapa quebras de linha literais dentro de strings JSON (erro comum de LLMs)
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
    const attempts = [
        str,
        str.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1'),
    ];
    attempts.push(escapeNewlinesInStrings(attempts[1]));
    for (const a of attempts) {
        try { return JSON.parse(a); } catch { /* próxima tentativa */ }
    }
    return undefined;
}

function normalizeEntry(e) {
    if (!e || typeof e !== 'object') return null;
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
    return { comment, key: keys, content };
}

function parseEntries(raw) {
    let t = String(raw)
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();

    const candidates = [];
    const fo = t.indexOf('{'), lo = t.lastIndexOf('}');
    const fa = t.indexOf('['), la = t.lastIndexOf(']');
    if (fo !== -1 && lo > fo) candidates.push(t.slice(fo, lo + 1));
    if (fa !== -1 && la > fa) candidates.push(t.slice(fa, la + 1));
    if (fa !== -1 && fa < fo) candidates.reverse();

    for (const cand of candidates) {
        const obj = tryParse(cand);
        if (obj === undefined) continue;
        let arr = [];
        if (Array.isArray(obj)) arr = obj;
        else if (Array.isArray(obj.entries)) arr = obj.entries;
        else if (obj.comment || obj.content) arr = [obj];
        const items = arr.map(normalizeEntry).filter(Boolean);
        if (items.length) return items;
    }
    throw new Error('Resposta do modelo não é um JSON válido.');
}

async function askWithRetry(sys, prompt, s) {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        const p = attempt === 0 ? prompt
            : prompt + '\n\nIMPORTANT: Your previous reply was NOT valid JSON. Reply with ONLY the raw JSON object, starting with { and ending with }.';
        const raw = await callLLM(sys, p, s);
        console.debug(LOG, 'Resposta bruta:', raw);
        try { return parseEntries(raw); } catch (e) { lastErr = e; }
    }
    throw lastErr;
}

// ───────────────────────── Lorebook (World Info) ─────────────────────────

function resolveTarget(s) {
    const c = ctx();
    const names = worldNames();

    switch (s.target) {
        case 'chat': {
            const cur = c.chatMetadata?.[WI.METADATA_KEY ?? 'world_info'];
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
    // Fallback manual
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
    const bookEntries = Object.values(data.entries ?? {});

    // Lista de trabalho (existentes + novas)
    let working = [];
    const toWork = (e) => ({ uid: e.uid, comment: e.comment || '', key: Array.isArray(e.key) ? [...e.key] : [], content: e.content || '', status: 'existing' });

    if (mode === 'full') {
        working = bookEntries.filter(e => e && !e.disable && e.content).map(toWork);
    } else if (s.updateSingle) {
        const m = getMeta();
        const e = m.single?.book === target.book ? data.entries?.[m.single.uid] : null;
        if (e) working = [toWork(e)];
    }

    const sys = buildSystemPrompt();
    const chunks = chunkLines(lines, s.chunkChars);
    const cap = Math.floor((Number(s.chunkChars) || 14000) * 0.6);

    for (let k = 0; k < chunks.length; k++) {
        onStatus?.(`Gerando com o modelo conectado… parte ${k + 1}/${chunks.length}`);
        const prompt = buildUserPrompt({
            mode, s,
            transcript: chunks[k], part: k + 1, total: chunks.length,
            existing: existingBlock(mode === 'single' ? working.slice(0, 1) : working, cap),
        });
        const items = await askWithRetry(sys, prompt, s);

        if (mode === 'single') {
            const it = items[0];
            if (working[0]) Object.assign(working[0], it, { status: working[0].status === 'new' ? 'new' : 'updated' });
            else working.push({ ...it, uid: null, status: 'new' });
        } else {
            for (const it of items.slice(0, Number(s.maxEntries) || 12)) {
                const hit = working.find(w => norm(w.comment) === norm(it.comment));
                if (hit) Object.assign(hit, it, { status: hit.status === 'new' ? 'new' : 'updated' });
                else working.push({ ...it, uid: null, status: 'new' });
            }
        }
    }

    const changes = working.filter(w => w.status !== 'existing');
    if (!changes.length) throw new Error('O modelo não retornou nenhuma entrada nova ou atualizada.');
    return { target, changes, lastIndex, mode };
}

async function commit(result) {
    const c = ctx();
    const s = getSettings();
    const { target, changes, lastIndex, mode } = result;
    const book = target.book;

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
        c.chatMetadata[WI.METADATA_KEY ?? 'world_info'] = book;
        $('.chat_lorebook_button').addClass('world_set');
    }
    if (target.isNew) {
        if (s.activateNewBook) activateGlobally(book);
        s.target = 'specific';   // próximas execuções atualizam este mesmo lorebook
        s.specificBook = book;
        saveSettings();
    }

    const meta = getMeta();
    meta.lastIndex = lastIndex;
    if (mode === 'single' && changes[0]) meta.single = { book, uid: changes[0].uid };
    await c.saveMetadata();

    return { book, created, updated };
}

async function runAndCommit({ mode, range, lastN, onStatus }) {
    if (busy) throw new Error('Já existe uma geração em andamento.');
    busy = true;
    try {
        const result = await forge({ mode, range, lastN, onStatus });
        return await commit(result);
    } finally {
        busy = false;
    }
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
    </div>
    <label class="checkbox_label"><input type="checkbox" id="lbf_m_preview" ${s.preview ? 'checked' : ''}> Pré-visualizar antes de salvar</label>
    <label class="checkbox_label"><input type="checkbox" id="lbf_m_update" ${s.updateSingle ? 'checked' : ''}> Modo único: atualizar a entrada anterior deste chat (em vez de criar outra)</label>
    <div id="lbf_m_info" class="lbf-info"></div>
    <div class="lbf-actions">
        <div id="lbf_m_go" class="menu_button menu_button_icon"><i class="fa-solid fa-wand-magic-sparkles"></i> Gerar Resumo para Lorebook</div>
    </div>
    <div id="lbf_m_status" class="lbf-status"></div>
    <div id="lbf_m_preview_area" class="lbf-preview" style="display:none">
        <div id="lbf_m_list" class="lbf-list"></div>
        <small>Você pode editar o JSON abaixo antes de salvar (remova itens que não quiser):</small>
        <textarea id="lbf_m_json" class="text_pole" rows="14"></textarea>
        <div class="lbf-actions">
            <div id="lbf_m_save" class="menu_button menu_button_icon"><i class="fa-solid fa-floppy-disk"></i> Salvar no Lorebook</div>
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
    $el.find('#lbf_m_preview').on('change', function () { s.preview = this.checked; saveSettings(); });
    $el.find('#lbf_m_update').on('change', function () { s.updateSingle = this.checked; saveSettings(); });

    if (s.target === 'specific' && !s.specificBook) s.specificBook = String($el.find('#lbf_m_book').val() ?? '');
    refreshVisibility();

    const showPreview = (result) => {
        pending = result;
        const list = result.changes.map(ch =>
            `<div class="lbf-item"><span class="lbf-badge ${ch.status}">${ch.status === 'new' ? 'NOVA' : 'ATUALIZADA'}</span> <b>${escapeHtml(ch.comment)}</b> <small>[${ch.key.map(escapeHtml).join(', ')}]</small></div>`).join('');
        $el.find('#lbf_m_list').html(`<div>Lorebook: <b>${escapeHtml(result.target.book)}</b></div>${list}`);
        $el.find('#lbf_m_json').val(JSON.stringify(result.changes.map(ch => ({
            comment: ch.comment, key: ch.key, content: ch.content, _uid: ch.uid, _status: ch.status,
        })), null, 2));
        $el.find('#lbf_m_preview_area').show();
    };

    $el.find('#lbf_m_go').on('click', async () => {
        if (busy) return;
        busy = true;
        $el.find('#lbf_m_preview_area').hide();
        const handle = c.loader?.show?.({ blocking: false, message: 'Lorebook Forge: gerando…', toastMode: 'static' });
        try {
            const result = await forge({ mode: s.mode, range: s.range, lastN: s.lastN, onStatus: m => status(m) });
            if (s.preview) {
                status(`✔ ${result.changes.length} entrada(s) gerada(s). Revise e salve.`, 'ok');
                showPreview(result);
            } else {
                const r = await commit(result);
                status(`✔ Salvo em "${r.book}": ${r.created} nova(s), ${r.updated} atualizada(s).`, 'ok');
                toastr.success(`${r.created} nova(s), ${r.updated} atualizada(s)`, `Lorebook "${r.book}"`);
                refreshVisibility();
            }
        } catch (e) {
            console.error(LOG, e);
            status(`✖ ${e.message}`, 'err');
            toastr.error(e.message, 'Lorebook Forge');
        } finally {
            busy = false;
            await handle?.hide?.();
        }
    });

    $el.find('#lbf_m_save').on('click', async () => {
        if (!pending || busy) return;
        let edited;
        try { edited = JSON.parse(String($el.find('#lbf_m_json').val())); }
        catch { return toastr.error('JSON inválido no editor.'); }
        if (!Array.isArray(edited)) return toastr.error('O JSON deve ser um array de entradas.');

        pending.changes = edited.map(x => {
            const n = normalizeEntry(x);
            return n ? { ...n, uid: x._uid ?? null, status: x._status ?? 'new' } : null;
        }).filter(Boolean);
        if (!pending.changes.length) return toastr.warning('Nenhuma entrada válida para salvar.');

        busy = true;
        try {
            const r = await commit(pending);
            status(`✔ Salvo em "${r.book}": ${r.created} nova(s), ${r.updated} atualizada(s).`, 'ok');
            toastr.success(`${r.created} nova(s), ${r.updated} atualizada(s)`, `Lorebook "${r.book}"`);
            $el.find('#lbf_m_preview_area').hide();
            pending = null;
            refreshVisibility();
        } catch (e) {
            console.error(LOG, e);
            toastr.error(e.message, 'Lorebook Forge');
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
            <b>Avançado</b>
            <label>Máx. caracteres por bloco do chat <input type="number" min="2000" id="lbf_chunk" class="text_pole" value="${Number(s.chunkChars)}"></label>
            <label>Tamanho máx. da resposta (tokens) <input type="number" min="256" id="lbf_resp" class="text_pole" value="${Number(s.responseLength)}"></label>
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
    const num = (sel, key, def) => $(sel).on('input', function () { s[key] = Number(this.value) || def; saveSettings(); });
    $('#lbf_open').on('click', openModal);
    $('#lbf_auto').on('change', function () { s.autoEnabled = this.checked; saveSettings(); });
    num('#lbf_auto_every', 'autoEvery', 20);
    $('#lbf_auto_mode').on('change', function () { s.autoMode = this.value; saveSettings(); });
    num('#lbf_chunk', 'chunkChars', 14000);
    num('#lbf_resp', 'responseLength', 2048);
    num('#lbf_maxent', 'maxEntries', 12);
    $('#lbf_schema').on('change', function () { s.useSchema = this.checked; saveSettings(); });
    $('#lbf_activate').on('change', function () { s.activateNewBook = this.checked; saveSettings(); });
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
            toastr.success(`${r.created} nova(s), ${r.updated} atualizada(s)`, `Lorebook "${r.book}"`);
        } catch (e) {
            console.warn(LOG, 'Auto falhou:', e);
            toastr.warning(e.message, 'Lorebook Forge (auto)');
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
                    const msg = `Lorebook "${r.book}": ${r.created} nova(s), ${r.updated} atualizada(s).`;
                    toastr.success(msg, 'Lorebook Forge');
                    return msg;
                } catch (e) {
                    toastr.error(e.message, 'Lorebook Forge');
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
    const c = ctx();

    $('#extensions_settings2').append(settingsHtml(s));
    bindSettings(s);

    // Botão discreto no menu de extensões (varinha mágica)
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
    console.log(LOG, 'carregado.');
});
