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

## License

Code: MIT. Game assets shown by the editor keep their own licenses (mostly CC-BY-SA 3.0); the editor
lists the license of every sprite it draws.
