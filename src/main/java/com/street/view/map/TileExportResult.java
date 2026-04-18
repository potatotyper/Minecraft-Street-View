package com.street.view.map;

import java.nio.file.Path;

public record TileExportResult(
    String snapshotId,
    int exportedTiles,
    Path outputDirectory
) {
}
