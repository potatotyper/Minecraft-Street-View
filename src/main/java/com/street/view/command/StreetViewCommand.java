package com.street.view.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.street.view.MinecraftStreetView;
import com.street.view.map.MapExportConfig;
import com.street.view.map.MapTileExporter;
import com.street.view.map.TileExportResult;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;

import java.io.IOException;
import java.nio.file.Path;

public final class StreetViewCommand {
    private static final int MIN_RADIUS_CHUNKS = 1;
    private static final int MAX_RADIUS_CHUNKS = 64;

    private StreetViewCommand() {
    }

    public static void register() {
        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) -> dispatcher.register(
            Commands.literal("streetview")
                .then(Commands.literal("map")
                    .then(Commands.literal("build")
                        .executes(context -> runBuild(
                            context.getSource(),
                            MapExportConfig.DEFAULT_RADIUS_CHUNKS,
                            MapExportConfig.DEFAULT_BLOCK_PIXEL_SIZE
                        ))
                        .then(Commands.argument("radiusChunks", IntegerArgumentType.integer(MIN_RADIUS_CHUNKS, MAX_RADIUS_CHUNKS))
                            .executes(context -> runBuild(
                                context.getSource(),
                                IntegerArgumentType.getInteger(context, "radiusChunks"),
                                MapExportConfig.DEFAULT_BLOCK_PIXEL_SIZE
                            ))
                            .then(Commands.argument("blockPixelSize", IntegerArgumentType.integer(1, 64))
                                .executes(context -> runBuild(
                                    context.getSource(),
                                    IntegerArgumentType.getInteger(context, "radiusChunks"),
                                    IntegerArgumentType.getInteger(context, "blockPixelSize")
                                ))
                            )
                        )
                    )
                    .then(Commands.literal("status")
                        .executes(context -> runStatus(context.getSource()))
                    )
                )
        ));
    }

    private static int runBuild(CommandSourceStack source, int radiusChunks, int blockPixelSize) {
        ServerLevel world = source.getServer().overworld();
        Path outputRoot = Path.of(MapExportConfig.OUTPUT_DIR_NAME);

        source.sendSuccess(() -> Component.literal(
            "Starting map export around spawn. Radius=" + radiusChunks + " chunks, pixelScale=" + blockPixelSize + "."
        ), false);

        try {
            int centerBlockX = (int) Math.floor(source.getPosition().x());
            int centerBlockZ = (int) Math.floor(source.getPosition().z());
            TileExportResult result = MapTileExporter.exportSpawnArea(
                world,
                outputRoot,
                radiusChunks,
                centerBlockX,
                centerBlockZ,
                blockPixelSize
            );
            source.sendSuccess(() -> Component.literal(
                "Map export complete: " + result.exportedTiles() + " tiles -> " + result.outputDirectory() +
                    " (center=" + centerBlockX + "," + centerBlockZ + ")"
            ), false);
            return 1;
        } catch (IOException exception) {
            MinecraftStreetView.LOGGER.error("Map export failed", exception);
            source.sendFailure(Component.literal("Map export failed: " + exception.getMessage()));
            return 0;
        }
    }

    private static int runStatus(CommandSourceStack source) {
        Path outputRoot = Path.of(MapExportConfig.OUTPUT_DIR_NAME);
        source.sendSuccess(() -> Component.literal("Map output directory: " + outputRoot.toAbsolutePath()), false);
        source.sendSuccess(() -> Component.literal("Run '/streetview map build [radiusChunks] [blockPixelSize]' to generate tiles."), false);
        return 1;
    }
}
