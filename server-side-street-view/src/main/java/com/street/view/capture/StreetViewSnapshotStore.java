package com.street.view.capture;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.street.view.protocol.StreetViewProtocol;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.List;

public final class StreetViewSnapshotStore {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    private StreetViewSnapshotStore() {
    }

    public static void writePending(CaptureSnapshot snapshot) throws IOException {
        Files.createDirectories(snapshot.snapshotDirectory());
        writeStreetViewIndex(snapshot, "pending", "", "", "");
        updateManifest(snapshot, "pending", 1);
    }

    public static void writeStatus(CaptureSnapshot snapshot, String status, String message, String panoramaPath, String thumbnailPath)
        throws IOException {
        writeStreetViewIndex(snapshot, status, message, panoramaPath, thumbnailPath);
        updateManifest(snapshot, status, "complete".equals(status) ? 1 : 0);
    }

    private static void writeStreetViewIndex(
        CaptureSnapshot snapshot,
        String status,
        String message,
        String panoramaPath,
        String thumbnailPath
    ) throws IOException {
        StreetViewIndex index = new StreetViewIndex(
            StreetViewProtocol.SCHEMA_VERSION,
            snapshot.snapshotId(),
            snapshot.dimension(),
            snapshot.createdAt(),
            List.of(new StreetViewNode(
                snapshot.nodeId(),
                snapshot.x(),
                snapshot.y(),
                snapshot.z(),
                snapshot.yaw(),
                snapshot.pitch(),
                "equirectangular",
                StreetViewProtocol.PANORAMA_WIDTH,
                StreetViewProtocol.PANORAMA_HEIGHT,
                StreetViewProtocol.PANORAMA_FORMAT,
                true,
                status,
                message == null ? "" : message,
                panoramaPath == null ? "" : panoramaPath,
                thumbnailPath == null ? "" : thumbnailPath
            ))
        );

        Files.writeString(snapshot.snapshotDirectory().resolve("streetview.json"), GSON.toJson(index));
    }

    private static void updateManifest(CaptureSnapshot snapshot, String status, int nodeCount) throws IOException {
        Path manifestPath = snapshot.snapshotDirectory().resolve("manifest.json");
        JsonObject manifest = new JsonObject();

        if (Files.exists(manifestPath)) {
            manifest = JsonParser.parseString(Files.readString(manifestPath)).getAsJsonObject();
        }

        JsonObject streetView = new JsonObject();
        streetView.addProperty("schemaVersion", StreetViewProtocol.SCHEMA_VERSION);
        streetView.addProperty("status", status);
        streetView.addProperty("nodeCount", nodeCount);
        streetView.addProperty("indexPath", "streetview.json");
        streetView.addProperty("updatedAt", DateTimeFormatter.ISO_INSTANT.format(Instant.now()));
        manifest.add("streetView", streetView);

        Files.writeString(manifestPath, GSON.toJson(manifest));
    }

    public record CaptureSnapshot(
        String captureId,
        String snapshotId,
        String nodeId,
        String dimension,
        Path snapshotDirectory,
        String createdAt,
        float x,
        float y,
        float z,
        float yaw,
        float pitch
    ) {
    }

    private record StreetViewIndex(
        int schemaVersion,
        String snapshotId,
        String dimension,
        String createdAt,
        List<StreetViewNode> nodes
    ) {
    }

    private record StreetViewNode(
        String id,
        float x,
        float y,
        float z,
        float yaw,
        float pitch,
        String projection,
        int width,
        int height,
        String format,
        boolean includesEntities,
        String status,
        String message,
        String panoramaPath,
        String thumbnailPath
    ) {
    }
}
