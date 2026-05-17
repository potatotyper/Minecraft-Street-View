package com.street.view.capture;

import com.street.view.MinecraftStreetView;
import com.street.view.map.MapExportConfig;
import com.street.view.map.MapTileExporter;
import com.street.view.map.TileExportResult;
import com.street.view.protocol.CaptureRequestPayload;
import com.street.view.protocol.CaptureStatusPayload;
import com.street.view.protocol.StreetViewProtocol;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

import java.io.IOException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

public final class CaptureCoordinator {
    private static final Duration PLAYER_COOLDOWN = Duration.ofSeconds(60);
    private static final Map<UUID, StreetViewSnapshotStore.CaptureSnapshot> ACTIVE_BY_PLAYER = new HashMap<>();
    private static final Map<String, UUID> PLAYER_BY_CAPTURE_ID = new HashMap<>();
    private static final Map<UUID, Instant> LAST_CAPTURE_BY_PLAYER = new HashMap<>();

    private CaptureCoordinator() {
    }

    public static void registerNetworking() {
        StreetViewProtocol.registerClientboundPayloads();
        StreetViewProtocol.registerServerboundPayloads();
        ServerPlayNetworking.registerGlobalReceiver(CaptureStatusPayload.TYPE, CaptureCoordinator::handleStatus);
    }

    public static int requestCapture(ServerPlayer player, int radiusChunks, int blockPixelSize) {
        UUID playerId = player.getUUID();

        if (ACTIVE_BY_PLAYER.containsKey(playerId)) {
            player.sendSystemMessage(Component.literal("Street View capture is already running for you."));
            return 0;
        }

        Instant lastCapture = LAST_CAPTURE_BY_PLAYER.get(playerId);
        Instant now = Instant.now();
        if (lastCapture != null) {
            long secondsRemaining = PLAYER_COOLDOWN.minus(Duration.between(lastCapture, now)).toSeconds();
            if (secondsRemaining > 0) {
                player.sendSystemMessage(Component.literal("Street View capture cooldown: wait " + secondsRemaining + " seconds."));
                return 0;
            }
        }

        if (!ServerPlayNetworking.canSend(player, CaptureRequestPayload.TYPE)) {
            player.sendSystemMessage(Component.literal("Install the client-side Street View capture mod to create 360 views."));
            return 0;
        }

        ServerLevel world = player.level();
        int centerBlockX = (int) Math.floor(player.getX());
        int centerBlockY = (int) Math.floor(player.getY());
        int centerBlockZ = (int) Math.floor(player.getZ());
        Path outputRoot = Path.of(MapExportConfig.OUTPUT_DIR_NAME);

        try {
            TileExportResult export = MapTileExporter.exportArea(
                world,
                outputRoot,
                radiusChunks,
                centerBlockX,
                centerBlockZ,
                blockPixelSize
            );
            String captureId = UUID.randomUUID().toString();
            String nodeId = cleanNodeId("node_" + centerBlockX + "_" + centerBlockY + "_" + centerBlockZ);
            StreetViewSnapshotStore.CaptureSnapshot snapshot = new StreetViewSnapshotStore.CaptureSnapshot(
                captureId,
                export.snapshotId(),
                nodeId,
                export.dimension(),
                export.outputDirectory(),
                export.createdAt(),
                (float) player.getX(),
                (float) player.getEyeY(),
                (float) player.getZ(),
                centerBlockX,
                centerBlockY,
                centerBlockZ,
                player.getYRot(),
                player.getXRot()
            );

            StreetViewSnapshotStore.writePending(snapshot);
            ACTIVE_BY_PLAYER.put(playerId, snapshot);
            PLAYER_BY_CAPTURE_ID.put(captureId, playerId);
            LAST_CAPTURE_BY_PLAYER.put(playerId, now);

            ServerPlayNetworking.send(player, new CaptureRequestPayload(
                captureId,
                export.snapshotId(),
                nodeId,
                export.dimension(),
                snapshot.blockX(),
                snapshot.blockY(),
                snapshot.blockZ(),
                snapshot.x(),
                snapshot.y(),
                snapshot.z(),
                snapshot.yaw(),
                snapshot.pitch(),
                StreetViewProtocol.PANORAMA_WIDTH,
                StreetViewProtocol.PANORAMA_HEIGHT,
                StreetViewProtocol.PANORAMA_FORMAT,
                true
            ));

            player.sendSystemMessage(Component.literal(
                "Street View capture started: map tiles=" + export.exportedTiles() + ", snapshot=" + export.snapshotId() + "."
            ));
            return 1;
        } catch (IOException exception) {
            MinecraftStreetView.LOGGER.error("Street View capture setup failed", exception);
            player.sendSystemMessage(Component.literal("Street View capture failed: " + exception.getMessage()));
            return 0;
        }
    }

    private static void handleStatus(CaptureStatusPayload payload, ServerPlayNetworking.Context context) {
        UUID expectedPlayerId = PLAYER_BY_CAPTURE_ID.get(payload.captureId());
        UUID senderId = context.player().getUUID();

        if (expectedPlayerId == null || !expectedPlayerId.equals(senderId)) {
            MinecraftStreetView.LOGGER.warn("Ignoring unknown Street View capture status {}", payload.captureId());
            return;
        }

        StreetViewSnapshotStore.CaptureSnapshot snapshot = ACTIVE_BY_PLAYER.get(senderId);
        if (snapshot == null) {
            return;
        }

        if ("started".equals(payload.status())) {
            return;
        }

        ACTIVE_BY_PLAYER.remove(senderId);
        PLAYER_BY_CAPTURE_ID.remove(payload.captureId());

        try {
            StreetViewSnapshotStore.writeStatus(
                snapshot,
                payload.status(),
                payload.message(),
                payload.panoramaPath(),
                payload.thumbnailPath()
            );
        } catch (IOException exception) {
            MinecraftStreetView.LOGGER.error("Failed to update Street View capture metadata", exception);
        }

        if ("complete".equals(payload.status())) {
            context.player().sendSystemMessage(Component.literal("Street View panorama complete: " + snapshot.snapshotId()));
        } else {
            String message = payload.message() == null || payload.message().isBlank() ? "Unknown capture error." : payload.message();
            context.player().sendSystemMessage(Component.literal("Street View panorama failed: " + message));
        }
    }

    private static String cleanNodeId(String raw) {
        return raw.replaceAll("[^A-Za-z0-9._-]", "_");
    }
}
