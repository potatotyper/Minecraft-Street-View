package com.street.view.map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeFormatter;

public final class MapTileExporter {
    private static final int BLOCKS_PER_CHUNK = 16;
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private MapTileExporter() {
    }

    public static TileExportResult exportSpawnArea(
        ServerLevel world,
        Path outputRoot,
        int radiusChunks,
        int centerBlockX,
        int centerBlockZ,
        int blockPixelSize
    ) throws IOException {
        Instant exportTime = Instant.now();
        String createdAt = DateTimeFormatter.ISO_INSTANT.format(exportTime);
        String snapshotId = createdAt.replace(':', '-');

        String dimensionId = dimensionName(world);
        String dimensionFolder = dimensionId;

        Path snapshotDir = outputRoot.resolve(snapshotId);
        Path tileDir = snapshotDir.resolve("tiles").resolve(dimensionFolder).resolve("z0");
        Files.createDirectories(tileDir);

        int centerChunkX = Math.floorDiv(centerBlockX, BLOCKS_PER_CHUNK);
        int centerChunkZ = Math.floorDiv(centerBlockZ, BLOCKS_PER_CHUNK);
        ChunkPos spawnChunk = new ChunkPos(centerChunkX, centerChunkZ);
        int exportedTiles = 0;

        for (int chunkX = spawnChunk.x() - radiusChunks; chunkX <= spawnChunk.x() + radiusChunks; chunkX++) {
            for (int chunkZ = spawnChunk.z() - radiusChunks; chunkZ <= spawnChunk.z() + radiusChunks; chunkZ++) {
                BufferedImage tile = renderChunkTile(world, chunkX, chunkZ, blockPixelSize);
                int centerX = (chunkX * BLOCKS_PER_CHUNK) + (BLOCKS_PER_CHUNK / 2);
                int centerZ = (chunkZ * BLOCKS_PER_CHUNK) + (BLOCKS_PER_CHUNK / 2);
                int centerYExclusive = world.getHeight(Heightmap.Types.WORLD_SURFACE, centerX, centerZ);
                int centerY = Math.max(world.getMinY(), centerYExclusive - 1);
                String tileName = "tile_center_" + centerX + "_" + centerY + "_" + centerZ + ".png";
                ImageIO.write(tile, "png", tileDir.resolve(tileName).toFile());
                exportedTiles++;
            }
        }

        Path manifestPath = snapshotDir.resolve("manifest.json");
        ExportManifest manifest = new ExportManifest(
            snapshotId,
            createdAt,
            world.getServer().getWorldData().getLevelName(),
            dimensionId,
            radiusChunks,
            blockPixelSize,
            exportedTiles,
            tileDir.toString()
        );

        Files.writeString(manifestPath, GSON.toJson(manifest));
        return new TileExportResult(snapshotId, exportedTiles, snapshotDir);
    }

    private static BufferedImage renderChunkTile(ServerLevel world, int chunkX, int chunkZ, int blockPixelSize) {
        // Ensure chunk data (including heightmaps) is present before sampling.
        world.getChunk(chunkX, chunkZ);

        int tileSizePixels = BLOCKS_PER_CHUNK * blockPixelSize;
        BufferedImage image = new BufferedImage(tileSizePixels, tileSizePixels, BufferedImage.TYPE_INT_ARGB);
        int minBuildHeight = world.getMinY();

        for (int localX = 0; localX < BLOCKS_PER_CHUNK; localX++) {
            for (int localZ = 0; localZ < BLOCKS_PER_CHUNK; localZ++) {
                int worldX = (chunkX * BLOCKS_PER_CHUNK) + localX;
                int worldZ = (chunkZ * BLOCKS_PER_CHUNK) + localZ;

                int topYExclusive = world.getHeight(Heightmap.Types.WORLD_SURFACE, worldX, worldZ);
                int blockY = Math.max(minBuildHeight, topYExclusive - 1);

                BlockState topState = world.getBlockState(new BlockPos(worldX, blockY, worldZ));
                Color baseColor = BlockColorPalette.colorFor(topState);

                int northTopY = world.getHeight(Heightmap.Types.WORLD_SURFACE, worldX, worldZ - 1);
                int southTopY = world.getHeight(Heightmap.Types.WORLD_SURFACE, worldX, worldZ + 1);
                int heightDelta = southTopY - northTopY;
                float shade = Math.max(0.72f, Math.min(1.25f, 1.0f + (heightDelta * 0.03f)));

                Color shadedColor = shade(baseColor, shade);
                fillBlock(image, localX, localZ, blockPixelSize, shadedColor.getRGB());
            }
        }

        return image;
    }

    private static Color shade(Color color, float factor) {
        int red = clamp((int) (color.getRed() * factor));
        int green = clamp((int) (color.getGreen() * factor));
        int blue = clamp((int) (color.getBlue() * factor));
        return new Color(red, green, blue);
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(255, value));
    }

    private static void fillBlock(BufferedImage image, int localX, int localZ, int blockPixelSize, int argb) {
        int startX = localX * blockPixelSize;
        int startY = localZ * blockPixelSize;

        for (int x = startX; x < startX + blockPixelSize; x++) {
            for (int y = startY; y < startY + blockPixelSize; y++) {
                image.setRGB(x, y, argb);
            }
        }
    }

    private record ExportManifest(
        String snapshotId,
        String createdAt,
        String worldName,
        String dimension,
        int radiusChunks,
        int blockPixelSize,
        int exportedTiles,
        String tileDirectory
    ) {
    }

    private static String dimensionName(ServerLevel world) {
        if (world.dimension().equals(Level.OVERWORLD)) {
            return "minecraft_overworld";
        }
        if (world.dimension().equals(Level.NETHER)) {
            return "minecraft_nether";
        }
        if (world.dimension().equals(Level.END)) {
            return "minecraft_end";
        }

        return world.dimension().toString().replaceAll("[^A-Za-z0-9._-]", "_");
    }
}
