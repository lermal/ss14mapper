# SS14 Mapper

Map editor for [Space Station 14](https://spacestation14.com) that runs in the browser: open a map of a
shuttle, point of interest or station from any fork, edit it and save a file the game loads, without
building and running the game client and server.

Status: early prototype.

## AI in development

AI tools helped write code and tests for parts of SS14 Mapper. The project maintainer decides what gets merged and released.

## Development

```bash
npm ci
npm run dev      # local editor
npm test         # tests
npm run build    # static site in dist/
```

Tests that read real maps use a corpus outside the repository; see `tools/corpus.mjs`. Set `SS14MAPPER_ENGINE` to a RobustToolbox checkout to also compare the noise port with the engine's source.

## Interface translations

Copy [`src/locales/en.json`](src/locales/en.json) to `src/locales/<language-tag>.json` (for example, `de.json`).
Translate the values and keep the keys and interpolation tokens such as `{{1}}` and `{{count}}`.
For pluralized keys, use the [i18next JSON v4 plural forms](https://www.i18next.com/translation-function/plurals) for the target language.
Vite picks up new catalogs at build time. They appear in the language selector, and any missing translation falls back to English.
The palette and the map's context menu use entity names, descriptions, suffixes, and tile names from the selected fork's Fluent resources.
It tries the interface language and falls back to English for individual missing fields.
Rebuild an asset pack to include these translations.

## Asset packs

The editor draws maps and lists placeable entities from an asset pack built from a checkout of a fork.
The builder works on any fork; which forks are built is configured in `tools/forks.json`.

```bash
npm run build-pack -- --checkout /path/to/fork --out /path/to/packs/<id> --id <id> [--repo <url>]
```

The checkout needs `Resources/{Prototypes,Textures,Locale}`, the root `Resources/*migration*.yml`, the
`Content.*` sources (read as text: component categories, signal ports that systems add, grid and tile masses)
and, from the `RobustToolbox` submodule, `Resources/EnginePrototypes` and `Robust.Shared.Maths/Color.cs`.
Nothing in the checkout is executed.

A pack is `manifest.json` plus files named by a hash of their content: prototypes with inheritance applied
(only the components drawing, placing and device linking need), tiles, decals, entity and tile migrations,
and texture pages (WebP, first frame of every direction of every RSI state). Rebuilding an unchanged checkout
gives the same files.

For device linking, every entity lists its signal ports (`ports.source`, `ports.sink`: those of its
`DeviceLinkSource`/`DeviceLinkSink` plus the ones game systems add in C# to entities with certain components,
such as doors), and keeps its `DeviceList` (configurators: air and fire alarms) and `DeviceNetwork`
(`deviceNetId`, frequencies). The pack has the port prototypes (localised name, description, `defaultLinks`)
and how the fork saves links and device lists (`devices`). For the centre of mass, entities with a physics
body have its `mass` (fixture area × density) and `massCentre`, tiles their `mass` (ContentTileDefinition),
and the pack the density of grid fixtures (`tileDensity`).

The prototype index also has `componentNames`: every component type that entities of the fork can have (all component
types used by entity prototypes before the pack drops most of them, plus the `[RegisterComponent]` classes found in the
`Content.*` and `RobustToolbox/Robust.*` C# sources, read as text; the name is the class name without `Component`, or the
`[ComponentProtoName]` override). It feeds the inspector's "Add component" list. Checkouts without the engine's C#
sources lack the components only it registers.

### Building a pack in GitHub Actions

`.github/workflows/build-pack.yml` builds the pack of one fork and uploads it to the API. It is started by the
API with `workflow_dispatch` after a fork is approved, with the inputs `build_id`, `repo`
(`https://github.com/owner/name`), `branch`, `commit` (40 hex digits) and `fork_id`; all of them are validated
before use. The job runs `tools/ci/build-fork.sh`, which does a shallow sparse checkout of the fork
(and of its pinned RobustToolbox) and runs `build-pack`, with limits of 2 GB for the checkout, 200 MB for the
pack and 30 minutes for the job. The same script works locally:

```bash
tools/ci/build-fork.sh https://github.com/space-wizards/space-station-14 master <commit sha> upstream /tmp/build
```

The result is `/tmp/build/pack.tar.gz`. On success the job posts it to `POST {MAPPER_API_URL}/runner/builds/{build_id}/pack`,
on failure or cancellation it posts the reason to `.../failed`.

The repository needs:

- the secret `MAPPER_RUNNER_TOKEN`, sent as `Authorization: Bearer ...` to the API;
- the variable `MAPPER_API_URL`, the API's base URL (no trailing path).

The API starts the workflow with a fine-grained personal access token limited to this repository with the
repository permission `Actions: read and write`.

## License

Code: MIT. Game assets shown by the editor keep their own licenses (mostly CC-BY-SA 3.0); the editor
lists the license of every sprite it draws.
