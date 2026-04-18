# Minecraft Street View

## Map MVP Workflow

This repository now includes a map-first pipeline that exports top-down chunk tiles and displays them in a local web viewer.

### 1. Generate map tiles in-game

Use the server command:

```text
/streetview map build [radiusChunks] [blockPixelSize]
```

Examples:

```text
/streetview map build
/streetview map build 12 16
```

Tile export output is written under `streetview-map/<snapshotId>/` with:

- `manifest.json`
- `tiles/<dimension>/z0/tile_<chunkX>_<chunkZ>.png`

### 2. Run the web map viewer

From the repository root:

```bash
node services/web-viewer/server.mjs
```

Open `http://localhost:4173`.

If your map output is in a custom location, provide it with:

```bash
MAP_OUTPUT_DIR="<absolute-path-to-streetview-map>" node services/web-viewer/server.mjs
```

The viewer discovers the latest snapshot and renders all exported chunk tiles on an interactive map.

## Setup

For setup instructions, please see the [Fabric Documentation page](https://docs.fabricmc.net/develop/getting-started/creating-a-project#setting-up) related to the IDE that you are using.

## License

This template is available under the CC0 license. Feel free to learn from it and incorporate it in your own projects.
