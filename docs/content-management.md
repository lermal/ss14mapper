# Managing guides and FAQ

Choose **Guides and FAQ…** from the account menu to open
`/admin/content/?lang=en` in a new tab. Your map stays open in the editor.
To grant access, add the maintainer's numeric GitHub ID to `MAINTAINER_GITHUB_IDS`
in the API environment.

## Writing and publishing

1. Select a section and language, then click **New guide** or **New question**.
2. Enter a title, a URL slug using lowercase Latin letters, numbers and hyphens,
   and a Markdown body. For FAQ entries, put the question in the title and the answer
   in the body. Use the toolbar to format text and upload images. Click **Preview**
   to check the result.
3. Click **Save draft** to save your work or **Publish** to put it on the site.
   After editing a published item, click **Publish changes** to update the public
   page. Until then, readers see the previous version.
4. Use **Move up** and **Move down** in the list to set the order. Clear the search
   and status filter before reordering. Each section and language has its own order.
5. Click **Unpublish** to remove an item from the site and sitemap while keeping
   its draft. **Delete** removes both the draft and the published version.

Write the English and Russian versions as separate items. Give translations the
same slug and publish both versions so readers can switch languages.
Choose the slug before publishing: you cannot change it after the first publication.
Use **Category** for a label displayed in the list.

Upload PNG, JPEG or WebP images up to 5 MB and 6000 × 6000 pixels.
Anyone with an image URL can open the file as soon as you upload it, including
before you publish the article. Upload images intended for public access.

## Links to forms

Add Markdown links to guides and FAQ answers:

```markdown
[Request a fork](/#add-build)
[Report a bug or suggest an improvement](/#feedback)
[View your builds](/#your-builds)
[Create a map](/#new-map)
[Open your map library](/#library)
[Customize key bindings](/#settings)
[View keyboard shortcuts](/#shortcuts)
[About the editor](/#about)
```

For Russian pages, replace `/#` with `/ru/#`.
Maintainers can use `/#manage-builds` to manage builds and `/#bug-reports`
to review feedback. Open the content manager at `/admin/content/?lang=en`.

Sign in through GitHub when prompted to submit requests, view your builds or open
maintainer tools. After signing in, you return to the form you selected.
You need a maintainer account to open the administration tools.

After you close a form, its fragment disappears from the URL, so reloading the page
will not reopen it. If you follow another form link while a form is open, close the
current form to open the last one you selected. The URL keeps the open map's query
parameters. From within the editor, use a link such as `#feedback` to open a form
without reloading the map.

These links work through the frontend build. You do not need new nginx rules for them.

## Production setup

Deploy **both projects**: `ss14mapper` and `ss14mapper-api`.

1. Update the API code and set `MAPPER_SITE_URL` to your public frontend origin
   (`https://ss14mapper.forged.by` for the upstream site).
   Keep your authentication, CORS and `MAINTAINER_GITHUB_IDS` settings.
2. In the API directory, run:

   ```sh
   php artisan migrate --force
   php artisan content:import-guide
   php artisan config:cache
   php artisan view:clear
   ```

   Use `content:import-guide` to import and publish the existing English and Russian
   guides with the slug `getting-started`. Repeated runs skip items with that slug
   and preserve your edits. Skip the import if you want to start with an empty list.
   Empty sections have a `noindex` meta tag.
3. Build the frontend with `npm run build` and your existing `VITE_API_URL` setting.
   Deploy the entire `dist/` directory, including `admin/content/index.html`
   and `content.css`.
4. In nginx, replace `public-discovery-server.conf` with `tools/nginx/content-server.conf`.
   Keep `public-discovery-http.conf` in the `http {}` context.
   Copy `content-upstream-http.conf.example`, set the HTTP address and Host of the
   nginx or Apache server that serves Laravel, and include the file in `http {}`.
   Use the Laravel HTTP server, not a PHP-FPM socket. Pointing the upstream at the
   frontend would create a request loop.
   Keep your HTTPS, API, asset pack and security header settings. Run `nginx -t`
   before reloading. For an HTTPS connection to the API, configure an HTTPS upstream,
   SNI and certificate verification.
5. Route `/guide/*`, `/faq/*`, `/content-media/*` and `/sitemap.xml` to the API.
   Serve `/admin/content/` on the frontend domain from `dist/`.
   Keep using `VITE_API_URL` for administrative requests.
6. Disable Cloudflare caching for section HTML, the sitemap and the content manager.
   Purge those URLs after switching routes. The API returns
   `Cache-Control: no-cache` for public HTML and the sitemap.
7. Open `/guide/`, `/guide/ru/` and `/faq/`, then create a draft through the content
   manager. After importing the guides, check the upstream deployment with
   `npm run check-site -- https://ss14mapper.forged.by`.
   Confirm that the sitemap includes published articles and excludes drafts.
   For a deployment on another domain, update the canonical URLs, language links,
   robots sitemap URL and the expected origin in the public-page checks to match
   that domain before running the checks against it.

Allow request bodies of at least 6 MB through the API and its reverse proxy.
In PHP, set `upload_max_filesize` to at least 5 MB and `post_max_size` to a larger
value. Back up the database and `storage/app/private/content-images`
(or the directory configured for the `local` disk). Image files remain on disk
after you delete an item, so you can reuse them in other articles.

## Local development

Use a test database for the API. Start Vite with the development proxy:

```sh
VITE_API_URL=/api SS14MAPPER_DEV_API=http://127.0.0.1:8771 npm run dev -- --host 127.0.0.1 --port 8772
```

Run the API on port 8771. Set `MAPPER_SITE_URL` and `FRONTEND_URLS` in its environment
to the frontend origin on port 8772. Set `SANCTUM_STATEFUL_DOMAINS` to the matching
hostname and port, without a URL scheme. Configure cookies and the OAuth callback
for local sign-in. Forward port 8772 through VS Code and use the same hostname
in your browser and configuration. This proxy is available in development mode.

## The content manager returns 404

Check `/admin/content/` and `/admin/content/index.html`. If the HTML file loads
but the directory URL returns 404, add these locations to the frontend's `server {}`
block:

```nginx
location = /admin/content {
    return 301 /admin/content/$is_args$args;
}
location = /admin/content/ {
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header Cache-Control "private, no-store" always;
    try_files /admin/content/index.html =404;
}
```

These rules are already in `tools/nginx/content-server.conf`. Do not add duplicate
locations if you include that file. Preserve your server's security headers according
to the `add_header` inheritance rules in your nginx version.
Run `sudo nginx -t`, then `sudo systemctl reload nginx`.
Run `npm run check-site -- https://ss14mapper.forged.by` to check the upstream
site, including the content manager URL used by the account menu. For another
domain, adjust the expected origin as described in **Production setup**.
To publish articles and FAQ answers, configure the API routes from that section.
