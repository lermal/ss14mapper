import { api, ApiError } from './api/client';
import { ContentApi, type ContentFields, type ContentItem, type ContentKind, type ContentLocale } from './api/content';
import { language, languageReady, t } from './i18n';
import { h } from './ui/icons';

await languageReady;
document.documentElement.lang = language();
document.title = `${t('Guides and FAQ')} — SS14 Mapper`;
const home = language() === 'ru' ? '/ru/' : '/';
(document.getElementById('editor-link') as HTMLAnchorElement).href = home;
const root = document.getElementById('content-manager')!;
const notice = h('p', 'cm-notice'); notice.setAttribute('role', 'status');
const pane = h('div');
root.replaceChildren(h('h1', '', t('Guides and FAQ')), notice, pane);
let content: ContentApi;
let kind: ContentKind = 'guide', locale: ContentLocale = language() === 'ru' ? 'ru' : 'en';
let items: ContentItem[] = [], current: ContentItem | null = null;
let dirty = false, busy = false, query = '', status = 'all';
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

function message(text = '', error = false): void { notice.textContent = text; notice.dataset.error = String(error); }
function button(text: string, action: () => void, cls = ''): HTMLButtonElement {
    const b = h('button', cls, text); b.type = 'button'; b.addEventListener('click', action); return b;
}
function field<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string, control: T, help = ''): HTMLElement {
    const label = h('label', 'cm-field'); label.append(h('span', '', name), control);
    if (help) label.append(h('small', '', help)); return label;
}
function select(options: Array<[string, string]>, value: string): HTMLSelectElement {
    const el = h('select'); for (const [key, text] of options) el.add(new Option(text, key)); el.value = value; return el;
}
function input(value: string, max: number): HTMLInputElement { const el = h('input'); el.value = value; el.maxLength = max; return el; }
function errorText(e: unknown): string {
    if (e instanceof ApiError) {
        if (e.status === 409) return t('This content changed elsewhere. Reload it before saving; your current text is still in the form.');
        const errors = (e.body as { errors?: Record<string, string[]> } | null)?.errors;
        return t(Object.values(errors ?? {}).flat()[0] ?? e.message);
    }
    return e instanceof Error ? e.message : t('The server could not complete the request.');
}
async function act(work: () => Promise<void>): Promise<void> {
    if (busy) return; busy = true; message(t('Working…'));
    const controls = [...pane.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('button,input,select,textarea')].map(el => [el, el.disabled] as const);
    controls.forEach(([el]) => el.disabled = true);
    try { await work(); } catch (e) { message(errorText(e), true); }
    finally { busy = false; controls.forEach(([el, disabled]) => el.disabled = disabled); }
}
function mayLeave(): boolean { return !dirty || confirm(t('Discard unsaved changes?')); }
async function refresh(): Promise<void> { items = await content.list(kind, locale); }
function state(item: ContentItem): string { return item.published ? t(item.hasDraft ? 'Published; draft changes' : 'Published') : t('Draft'); }

function showList(): void {
    dirty = false; current = null; pane.replaceChildren();
    const toolbar = h('div', 'cm-toolbar'), tabs = h('div', 'cm-tabs'); tabs.setAttribute('aria-label', t('Content type'));
    for (const [value, name] of [['guide', 'Guides'], ['faq', 'FAQ']] as const) {
        const b = button(t(name), () => void act(async () => { kind = value; query = ''; status = 'all'; await refresh(); showList(); message(); }));
        b.setAttribute('aria-pressed', String(value === kind)); tabs.append(b);
    }
    const lang = select([['ru', 'Русский'], ['en', 'English']], locale);
    lang.addEventListener('change', () => void act(async () => { locale = lang.value as ContentLocale; await refresh(); showList(); message(); }));
    const filter = select([['all', t('All')], ['draft', t('Draft')], ['published', t('Published')]], status);
    const search = input(query, 200); search.type = 'search';
    const searchField = field(t('Search'), search); searchField.classList.add('cm-search');
    const add = button(t(kind === 'guide' ? 'New guide' : 'New question'), () => { current = null; showEditor(); }, 'cm-primary');
    toolbar.append(tabs, field(t('Content language'), lang), field(t('Status'), filter), searchField, button(t('Reload'), () => void act(async () => { await refresh(); showList(); message(t('Reloaded.')); })), add);
    const list = h('div'); pane.append(toolbar, list);
    const draw = () => {
        list.replaceChildren();
        const visible = items.filter(item => (!query || `${item.title} ${item.category}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())) && (status === 'all' || item.published === (status === 'published')));
        if (!visible.length) list.append(h('p', 'cm-note', t(items.length ? 'No matching items.' : 'No items yet. Create a guide or a question to start.')));
        if (query || status !== 'all') list.append(h('p', 'cm-note', t('Clear filters to change the order.')));
        for (const item of visible) {
            const row = h('article', 'cm-row'), info = h('div');
            info.append(button(item.title, () => { current = item; showEditor(); }, 'cm-item-title'), h('p', 'cm-row-meta', [state(item), item.category].filter(Boolean).join(' — ')));
            const order = h('div', 'cm-row-order');
            for (const [delta, label] of [[-1, 'Move up'], [1, 'Move down']] as const) {
                const index = items.findIndex(x => x.id === item.id);
                const move = button(t(label), () => void act(async () => {
                    const previous = items.map(x => x.id), next = [...previous];
                    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
                    await content.order(kind, locale, previous, next); await refresh(); showList(); message(t('Order saved.'));
                }));
                move.disabled = !!query || status !== 'all' || index + delta < 0 || index + delta >= items.length;
                move.setAttribute('aria-label', `${t(label)}: ${item.title}`); order.append(move);
            }
            row.append(info, order); list.append(row);
        }
    };
    search.addEventListener('input', () => { query = search.value; draw(); });
    filter.addEventListener('change', () => { status = filter.value; draw(); }); draw();
}

function showEditor(): void {
    dirty = false; message(); pane.replaceChildren();
    const back = button(t('Back to list'), () => { if (mayLeave()) void act(async () => { await refresh(); showList(); message(); }); });
    const head = h('div', 'cm-toolbar'); head.append(back, h('span', 'cm-note', `${t(kind === 'guide' ? 'Guide' : 'Question')} / ${locale === 'ru' ? 'Русский' : 'English'}`));
    if (current?.published) { const link = h('a', '', t('Open published page')); link.href = current.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; head.append(link); }
    const form = h('form', 'cm-editor'); form.addEventListener('submit', e => e.preventDefault());
    const grid = h('div', 'cm-editor-grid'), main = h('div', 'cm-editor-main'), aside = h('aside', 'cm-editor-aside');
    const title = input(current?.title ?? '', 200); title.required = true;
    const slug = input(current?.slug ?? '', 100); slug.required = true; slug.pattern = '[a-z0-9]+(-[a-z0-9]+)*'; slug.disabled = !!current?.slugLocked;
    const summary = input(current?.summary ?? '', 320), category = input(current?.category ?? '', 100);
    const body = h('textarea', 'cm-body'); body.value = current?.body ?? ''; body.maxLength = 200000; body.spellcheck = true;
    const fields = (): ContentFields => ({ title: title.value.trim(), slug: slug.value.trim(), summary: summary.value.trim(), category: category.value.trim(), body: body.value });
    form.addEventListener('input', () => { dirty = true; });
    const tools = h('div', 'cm-markdown-tools'); tools.setAttribute('role', 'group'); tools.setAttribute('aria-label', t('Markdown formatting'));
    function insert(before: string, after = '', placeholder = ''): void {
        const start = body.selectionStart, end = body.selectionEnd;
        const selected = body.value.slice(start, end) || placeholder;
        body.setRangeText(before + selected + after, start, end, 'end'); body.focus();
        body.setSelectionRange(start + before.length, start + before.length + selected.length); dirty = true;
    }
    for (const [name, before, after, placeholder] of [
        ['Bold', '**', '**', t('Text')], ['Italic', '*', '*', t('Text')], ['Markdown heading', '\n## ', '\n', t('Markdown heading')],
        ['List', '\n- ', '\n', t('List item')], ['Numbered list', '\n1. ', '\n', t('List item')], ['Code', '\n```\n', '\n```\n', ''],
    ]) tools.append(button(t(name!), () => insert(before!, after!, placeholder!)));
    tools.append(button(t('Insert link'), () => { const url = prompt(t('Link URL'), 'https://'); if (url) insert('[', `](${url.replace(/[\s()]/g, c => c === '(' ? '%28' : c === ')' ? '%29' : encodeURIComponent(c))})`, t('Link text')); }));
    const image = h('input'); image.type = 'file'; image.accept = 'image/png,image/jpeg,image/webp'; image.hidden = true;
    tools.append(button(t('Upload image'), () => image.click()), image);
    image.addEventListener('change', () => { const file = image.files?.[0]; image.value = ''; if (!file) return;
        const alt = prompt(t('Describe the image'), ''); if (alt === null) return;
        void act(async () => { const uploaded = await content.image(file); insert(`\n![${alt.replace(/[\[\]\\]/g, '\\$&')}](${uploaded.url})\n`); message(t('Image inserted. Save the draft to keep it in the text.')); });
    });
    const preview = h('iframe', 'cm-preview'); preview.title = t('Preview'); preview.setAttribute('sandbox', ''); preview.hidden = true;
    const previewButton = button(t('Preview'), () => void act(async () => {
        const rendered = await content.preview(body.value);
        preview.srcdoc = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${location.origin}/content.css"></head><body class="preview"><article class="markdown">${rendered.html}</article></body></html>`;
        preview.hidden = false; message(t('Preview updated.'));
    }));
    main.append(field(t(kind === 'guide' ? 'Title' : 'Question'), title), tools, field(t(kind === 'guide' ? 'Guide text (Markdown)' : 'Answer (Markdown)'), body), previewButton, preview);
    aside.append(field(t('Address'), slug, t('Use lowercase Latin letters, numbers and hyphens. The address is fixed after publication.')),
        field(t('Short description'), summary, t('Used in the guide list and page description.')), field(t('Category'), category),
        h('p', 'cm-note', t('Use the same address in the other language to link translations.')),
        h('p', 'cm-note', current ? state(current) : t('New draft')));
    grid.append(main, aside); form.append(grid);
    async function persist(): Promise<ContentItem | null> {
        // Disabled controls are ignored by reportValidity while a request runs; validate explicitly.
        if (!title.value.trim() || !slug.value.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug.value.trim()) || slug.value.trim() === 'ru') {
            throw new Error(t('Enter a title and an address using Latin letters, numbers and hyphens.'));
        }
        current = current ? await content.save(current, fields()) : await content.create(kind, locale, fields());
        dirty = false; return current;
    }
    const actions = h('div', 'cm-actions');
    const save = button(t('Save draft'), () => void act(async () => { await persist(); showEditor(); message(t('Draft saved. The published version has not changed.')); }));
    const publish = button(t(current?.published ? 'Publish changes' : 'Publish'), () => void act(async () => {
        if (!current || dirty) await persist();
        current = await content.publish(current!); showEditor(); message(t('Published.'));
    }), 'cm-primary');
    actions.append(save, publish);
    if (current) {
        actions.append(button(t('Reload'), () => { if (mayLeave()) void act(async () => {
            const id = current!.id; await refresh(); current = items.find(x => x.id === id) ?? null;
            if (current) showEditor(); else showList(); message(t('Reloaded.'));
        }); }));
        if (current.published) actions.append(button(t('Unpublish'), () => {
            if (confirm(t('Remove this item from the public site? The draft will remain.'))) void act(async () => {
                if (dirty) await persist(); current = await content.unpublish(current!); showEditor(); message(t('Unpublished.'));
            });
        }));
        actions.append(button(t('Delete'), () => {
            if (confirm(t('Delete this item and its published version? This cannot be undone.'))) void act(async () => {
                await content.remove(current!); dirty = false; await refresh(); showList(); message(t('Deleted.'));
            });
        }, 'cm-danger'));
    }
    form.append(h('p', 'cm-note', t('Saving a draft does not change the published page. Publish when it is ready.')), actions);
    body.addEventListener('keydown', e => {
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'i') { e.preventDefault(); const mark = e.key.toLowerCase() === 'b' ? '**' : '*'; insert(mark, mark, t('Text')); }
    });
    form.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save.click(); } });
    pane.append(head, form);
}

if (!api) {
    message(t('Content management needs the site API. Open this page on the configured site.'), true);
} else {
    const connected = api;
    await act(async () => {
        const me = await connected.me();
        if (!me) {
            message(t('Sign in with your maintainer account to manage guides and FAQ.'));
            pane.append(button(t('Sign in'), () => location.assign(connected.signInUrl(location.href)))); return;
        }
        document.getElementById('account-name')!.textContent = me.login;
        if (!me.maintainer) { message(t('Only maintainers can manage guides and FAQ.'), true); return; }
        content = new ContentApi(connected.client); await refresh(); showList(); message();
    });
    if (!pane.hasChildNodes()) pane.append(button(t('Reload'), () => location.reload()));
}
