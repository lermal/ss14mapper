import { ApiClient } from './client';

export type ContentKind = 'guide' | 'faq';
export type ContentLocale = 'en' | 'ru';
export interface ContentFields { slug: string; title: string; summary: string; category: string; body: string }
export interface ContentItem extends ContentFields {
    id: number; kind: ContentKind; locale: ContentLocale; position: number; revision: number;
    published: boolean; hasDraft: boolean; slugLocked: boolean; url: string; publishedAt: string | null; updatedAt: string;
}
export class ContentApi {
    constructor(private readonly client: ApiClient) {}
    list(kind: ContentKind, locale: ContentLocale): Promise<ContentItem[]> { return this.client.request('GET', `/admin/content?kind=${kind}&locale=${locale}`); }
    create(kind: ContentKind, locale: ContentLocale, fields: ContentFields): Promise<ContentItem> { return this.client.request('POST', '/admin/content', { body: { kind, locale, ...fields } }); }
    save(item: ContentItem, fields: ContentFields): Promise<ContentItem> { return this.client.request('PUT', `/admin/content/${item.id}`, { body: { revision: item.revision, ...fields } }); }
    publish(item: ContentItem): Promise<ContentItem> { return this.client.request('POST', `/admin/content/${item.id}/publish`, { body: { revision: item.revision } }); }
    unpublish(item: ContentItem): Promise<ContentItem> { return this.client.request('POST', `/admin/content/${item.id}/unpublish`, { body: { revision: item.revision } }); }
    remove(item: ContentItem): Promise<void> { return this.client.request('DELETE', `/admin/content/${item.id}`, { body: { revision: item.revision } }); }
    order(kind: ContentKind, locale: ContentLocale, previousIds: number[], ids: number[]): Promise<void> { return this.client.request('PUT', '/admin/content/order', { body: { kind, locale, previousIds, ids } }); }
    preview(body: string): Promise<{ html: string }> { return this.client.request('POST', '/admin/content/preview', { body: { body } }); }
    image(image: File): Promise<{ url: string }> { const form = new FormData(); form.append('image', image); return this.client.request('POST', '/admin/content/images', { form }); }
}
