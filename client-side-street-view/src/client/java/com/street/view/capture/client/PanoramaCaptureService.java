package com.street.view.capture.client;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.mojang.blaze3d.platform.NativeImage;
import com.street.view.capture.ClientSideStreetView;
import com.street.view.protocol.CaptureRequestPayload;
import com.street.view.protocol.CaptureStatusPayload;
import com.street.view.protocol.StreetViewProtocol;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.CameraType;
import net.minecraft.client.Minecraft;
import net.minecraft.client.OptionInstance;
import net.minecraft.client.Screenshot;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.network.chat.Component;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.ImageOutputStream;
import java.awt.Graphics2D;
import java.awt.RenderingHints;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.format.DateTimeFormatter;
import java.util.Iterator;
import java.util.List;

public final class PanoramaCaptureService {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int FACE_COUNT = 6;
    private static final int TICKS_BETWEEN_FACES = 2;
    private static final float JPEG_QUALITY = 0.9f;

    private CaptureJob activeJob;

    public void start(Minecraft client, CaptureRequestPayload request) {
        if (activeJob != null) {
            sendStatus(request, "failed", "A Street View capture is already running.", "", "");
            return;
        }

        if (client.player == null || client.level == null) {
            sendStatus(request, "failed", "No active world is loaded on the client.", "", "");
            return;
        }

        activeJob = new CaptureJob(client, request);
        activeJob.start(client);
        sendStatus(request, "started", "", "", "");
    }

    public void tick(Minecraft client) {
        if (activeJob == null) {
            return;
        }

        try {
            if (activeJob.tick(client)) {
                activeJob = null;
            }
        } catch (Exception exception) {
            ClientSideStreetView.LOGGER.error("Street View panorama capture failed", exception);
            activeJob.fail(client, exception.getMessage());
            activeJob = null;
        }
    }

    private static void sendStatus(CaptureRequestPayload request, String status, String message, String panoramaPath, String thumbnailPath) {
        if (!ClientPlayNetworking.canSend(CaptureStatusPayload.TYPE)) {
            return;
        }

        ClientPlayNetworking.send(new CaptureStatusPayload(
            request.captureId(),
            request.snapshotId(),
            request.nodeId(),
            status,
            message == null ? "" : message,
            panoramaPath == null ? "" : panoramaPath,
            thumbnailPath == null ? "" : thumbnailPath
        ));
    }

    private static final class CaptureJob {
        private final CaptureRequestPayload request;
        private final BufferedImage[] faces = new BufferedImage[FACE_COUNT];
        private final CameraType previousCameraType;
        private final boolean previousHideGui;
        private final int previousFov;
        private final boolean previousBobView;
        private final float previousYaw;
        private final float previousPitch;

        private int faceIndex;
        private int waitTicks = TICKS_BETWEEN_FACES;
        private boolean waitingForScreenshot;
        private boolean restored;

        private CaptureJob(Minecraft client, CaptureRequestPayload request) {
            this.request = request;
            LocalPlayer player = client.player;
            this.previousCameraType = client.options.getCameraType();
            this.previousHideGui = client.options.hideGui;
            this.previousFov = client.options.fov().get();
            this.previousBobView = client.options.bobView().get();
            this.previousYaw = player == null ? request.yaw() : player.getYRot();
            this.previousPitch = player == null ? request.pitch() : player.getXRot();
        }

        private void start(Minecraft client) {
            client.setScreen(null);
            client.options.hideGui = true;
            client.options.setCameraType(CameraType.FIRST_PERSON);
            client.options.fov().set(90);
            client.options.bobView().set(false);
            applyFaceRotation(client, 0);
            client.player.sendSystemMessage(Component.literal("Street View capture started."));
        }

        private boolean tick(Minecraft client) throws IOException {
            if (waitingForScreenshot) {
                return false;
            }

            if (faceIndex >= FACE_COUNT) {
                finish(client);
                return true;
            }

            applyFaceRotation(client, faceIndex);
            if (waitTicks > 0) {
                waitTicks--;
                return false;
            }

            waitingForScreenshot = true;
            int capturedFace = faceIndex;
            Screenshot.takeScreenshot(client.getMainRenderTarget(), image -> {
                try {
                    faces[capturedFace] = centerSquareFace(image, Math.max(512, request.width() / 4));
                    faceIndex++;
                    waitTicks = TICKS_BETWEEN_FACES;
                } catch (RuntimeException exception) {
                    ClientSideStreetView.LOGGER.error("Failed to read Street View face image", exception);
                    throw exception;
                } finally {
                    image.close();
                    waitingForScreenshot = false;
                }
            });

            return false;
        }

        private void finish(Minecraft client) throws IOException {
            BufferedImage panorama = stitchEquirectangular(faces, request.width(), request.height());
            BufferedImage thumbnail = scale(panorama, 320, 160);

            String baseRelativePath = "panoramas/" + request.dimension() + "/" + request.nodeId();
            String panoramaRelativePath = baseRelativePath + "/pano.jpg";
            String thumbnailRelativePath = baseRelativePath + "/thumb.jpg";
            Path snapshotDirectory = client.gameDirectory.toPath().resolve("streetview-map").resolve(request.snapshotId());
            Path nodeDirectory = snapshotDirectory.resolve(baseRelativePath);
            Files.createDirectories(nodeDirectory);

            writeJpeg(panorama, snapshotDirectory.resolve(panoramaRelativePath), JPEG_QUALITY);
            writeJpeg(thumbnail, snapshotDirectory.resolve(thumbnailRelativePath), JPEG_QUALITY);
            writeCaptureMetadata(snapshotDirectory.resolve(baseRelativePath + "/capture.json"), panoramaRelativePath, thumbnailRelativePath);
            writeStreetViewIndex(snapshotDirectory.resolve("streetview.json"), panoramaRelativePath, thumbnailRelativePath);

            restore(client);
            sendStatus(request, "complete", "", panoramaRelativePath, thumbnailRelativePath);
            client.player.sendSystemMessage(Component.literal("Street View capture complete: " + request.snapshotId()));
        }

        private void fail(Minecraft client, String message) {
            restore(client);
            sendStatus(request, "failed", message == null ? "Unknown capture error." : message, "", "");
            if (client.player != null) {
                client.player.sendSystemMessage(Component.literal("Street View capture failed."));
            }
        }

        private void restore(Minecraft client) {
            if (restored) {
                return;
            }

            restored = true;
            client.options.hideGui = previousHideGui;
            client.options.setCameraType(previousCameraType);
            client.options.fov().set(previousFov);
            client.options.bobView().set(previousBobView);

            if (client.player != null) {
                setRotation(client.player, previousYaw, previousPitch);
            }
        }

        private void applyFaceRotation(Minecraft client, int face) {
            if (client.player == null) {
                return;
            }

            float yaw = switch (face) {
                case 1 -> request.yaw() + 90.0f;
                case 2 -> request.yaw() + 180.0f;
                case 3 -> request.yaw() - 90.0f;
                default -> request.yaw();
            };
            float pitch = switch (face) {
                case 4 -> -90.0f;
                case 5 -> 90.0f;
                default -> 0.0f;
            };

            setRotation(client.player, yaw, pitch);
        }

        private void setRotation(LocalPlayer player, float yaw, float pitch) {
            player.setYRot(yaw);
            player.setXRot(pitch);
            player.yRotO = yaw;
            player.xRotO = pitch;
            player.setYHeadRot(yaw);
            player.yHeadRotO = yaw;
            player.setYBodyRot(yaw);
            player.yBodyRotO = yaw;
        }

        private void writeCaptureMetadata(Path path, String panoramaPath, String thumbnailPath) throws IOException {
            CaptureMetadata metadata = new CaptureMetadata(
                StreetViewProtocol.SCHEMA_VERSION,
                request.captureId(),
                request.snapshotId(),
                request.nodeId(),
                request.dimension(),
                DateTimeFormatter.ISO_INSTANT.format(Instant.now()),
                request.x(),
                request.y(),
                request.z(),
                request.yaw(),
                request.pitch(),
                "equirectangular",
                request.width(),
                request.height(),
                request.format(),
                request.includeEntities(),
                panoramaPath,
                thumbnailPath
            );

            Files.writeString(path, GSON.toJson(metadata));
        }

        private void writeStreetViewIndex(Path path, String panoramaPath, String thumbnailPath) throws IOException {
            StreetViewIndex index = new StreetViewIndex(
                StreetViewProtocol.SCHEMA_VERSION,
                request.snapshotId(),
                request.dimension(),
                DateTimeFormatter.ISO_INSTANT.format(Instant.now()),
                List.of(new StreetViewNode(
                    request.nodeId(),
                    request.x(),
                    request.y(),
                    request.z(),
                    request.yaw(),
                    request.pitch(),
                    "equirectangular",
                    request.width(),
                    request.height(),
                    request.format(),
                    request.includeEntities(),
                    "complete",
                    "",
                    panoramaPath,
                    thumbnailPath
                ))
            );

            Files.writeString(path, GSON.toJson(index));
        }
    }

    private static BufferedImage centerSquareFace(NativeImage image, int faceSize) {
        int sourceWidth = image.getWidth();
        int sourceHeight = image.getHeight();
        int cropSize = Math.min(sourceWidth, sourceHeight);
        int cropX = (sourceWidth - cropSize) / 2;
        int cropY = (sourceHeight - cropSize) / 2;
        int[] pixels = image.makePixelArray();
        BufferedImage cropped = new BufferedImage(cropSize, cropSize, BufferedImage.TYPE_INT_RGB);

        for (int y = 0; y < cropSize; y++) {
            int sourceOffset = (cropY + y) * sourceWidth + cropX;
            for (int x = 0; x < cropSize; x++) {
                cropped.setRGB(x, y, pixels[sourceOffset + x]);
            }
        }

        return scale(cropped, faceSize, faceSize);
    }

    private static BufferedImage stitchEquirectangular(BufferedImage[] faces, int width, int height) {
        for (BufferedImage face : faces) {
            if (face == null) {
                throw new IllegalStateException("Missing one or more cube faces.");
            }
        }

        BufferedImage output = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < height; y++) {
            double latitude = Math.PI * (0.5 - ((y + 0.5) / height));
            double cosLatitude = Math.cos(latitude);
            double directionY = Math.sin(latitude);

            for (int x = 0; x < width; x++) {
                double longitude = (2.0 * Math.PI * ((x + 0.5) / width)) - Math.PI;
                double directionX = cosLatitude * Math.sin(longitude);
                double directionZ = cosLatitude * Math.cos(longitude);
                output.setRGB(x, y, sampleCube(faces, directionX, directionY, directionZ));
            }
        }

        return output;
    }

    private static int sampleCube(BufferedImage[] faces, double x, double y, double z) {
        double absX = Math.abs(x);
        double absY = Math.abs(y);
        double absZ = Math.abs(z);

        int face;
        double u;
        double v;
        if (absZ >= absX && absZ >= absY) {
            face = z >= 0 ? 0 : 2;
            u = z >= 0 ? x / absZ : -x / absZ;
            v = -y / absZ;
        } else if (absX >= absY) {
            face = x >= 0 ? 1 : 3;
            u = x >= 0 ? -z / absX : z / absX;
            v = -y / absX;
        } else {
            face = y >= 0 ? 4 : 5;
            u = x / absY;
            v = y >= 0 ? z / absY : -z / absY;
        }

        BufferedImage image = faces[face];
        int sourceX = clamp((int) Math.round(((u + 1.0) * 0.5) * (image.getWidth() - 1)), 0, image.getWidth() - 1);
        int sourceY = clamp((int) Math.round(((v + 1.0) * 0.5) * (image.getHeight() - 1)), 0, image.getHeight() - 1);
        return image.getRGB(sourceX, sourceY);
    }

    private static BufferedImage scale(BufferedImage source, int width, int height) {
        BufferedImage scaled = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
        Graphics2D graphics = scaled.createGraphics();
        try {
            graphics.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR);
            graphics.setRenderingHint(RenderingHints.KEY_RENDERING, RenderingHints.VALUE_RENDER_QUALITY);
            graphics.drawImage(source, 0, 0, width, height, null);
        } finally {
            graphics.dispose();
        }
        return scaled;
    }

    private static void writeJpeg(BufferedImage image, Path path, float quality) throws IOException {
        Files.createDirectories(path.getParent());
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpeg");
        if (!writers.hasNext()) {
            throw new IOException("No JPEG writer is available.");
        }

        ImageWriter writer = writers.next();
        try (ImageOutputStream output = ImageIO.createImageOutputStream(path.toFile())) {
            ImageWriteParam params = writer.getDefaultWriteParam();
            params.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
            params.setCompressionQuality(quality);
            writer.setOutput(output);
            writer.write(null, new IIOImage(image, null, null), params);
        } finally {
            writer.dispose();
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    private record CaptureMetadata(
        int schemaVersion,
        String captureId,
        String snapshotId,
        String nodeId,
        String dimension,
        String capturedAt,
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
        String panoramaPath,
        String thumbnailPath
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
