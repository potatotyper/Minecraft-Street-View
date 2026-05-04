package com.street.view.map;

import java.nio.file.Path;

public record TileExportResult(
    String snapshotId,
    String createdAt,
    String dimension,
    int exportedTiles,
    Path outputDirectory
) {
}
