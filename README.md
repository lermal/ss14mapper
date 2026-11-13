# SS14 Mapper

Map editor for [Space Station 14](https://spacestation14.com) that runs in the browser: open a map of a
shuttle, point of interest or station from any fork, edit it and save a file the game loads, without
building and running the game client and server.

Status: early prototype.

## Development

```bash
npm ci
npm run dev      # local editor
npm test         # tests
npm run build    # static site in dist/
```

Tests that read real maps use a corpus outside the repository; see `tools/corpus.mjs`.

## Asset packs

The editor draws maps and lists placeable entities from an asset pack built from a checkout of a fork.
The builder works on any fork; which forks are built is configured in `tools/forks.json`.

```bash
npm run build-pack -- --checkout /path/to/fork --out /path/to/packs/<id> --id <id> [--repo <url>]
```

The checkout needs `Resources/{Prototypes,Textures,Locale/en-US}`, the root `Resources/*migration*.yml`, the
`Content.*` sources (read as text for component categories) and, from the `RobustToolbox` submodule,
`Resources/EnginePrototypes` and `Robust.Shared.Maths/Color.cs`. Nothing in the checkout is executed.

A pack is `manifest.json` plus files named by a hash of their content: prototypes with inheritance applied
(only the components drawing needs), tiles, decals, entity and tile migrations, and texture pages (WebP,
first frame of every direction of every RSI state). Rebuilding an unchanged checkout gives the same files.

## License

Code: MIT. Game assets shown by the editor keep their own licenses (mostly CC-BY-SA 3.0); the editor
lists the license of every sprite it draws.
