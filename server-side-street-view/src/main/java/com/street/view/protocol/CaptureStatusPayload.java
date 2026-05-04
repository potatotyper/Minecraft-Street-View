package com.street.view.protocol;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

public record CaptureStatusPayload(
    String captureId,
    String snapshotId,
    String nodeId,
    String status,
    String message,
    String panoramaPath,
    String thumbnailPath
) implements CustomPacketPayload {
    public static final Type<CaptureStatusPayload> TYPE = new Type<>(
        Identifier.fromNamespaceAndPath(StreetViewProtocol.MOD_ID, "capture_status")
    );
    public static final StreamCodec<RegistryFriendlyByteBuf, CaptureStatusPayload> STREAM_CODEC = StreamCodec.of(
        CaptureStatusPayload::write,
        CaptureStatusPayload::read
    );

    private static CaptureStatusPayload read(RegistryFriendlyByteBuf buffer) {
        return new CaptureStatusPayload(
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf()
        );
    }

    private static void write(RegistryFriendlyByteBuf buffer, CaptureStatusPayload payload) {
        buffer.writeUtf(payload.captureId);
        buffer.writeUtf(payload.snapshotId);
        buffer.writeUtf(payload.nodeId);
        buffer.writeUtf(payload.status);
        buffer.writeUtf(payload.message == null ? "" : payload.message);
        buffer.writeUtf(payload.panoramaPath == null ? "" : payload.panoramaPath);
        buffer.writeUtf(payload.thumbnailPath == null ? "" : payload.thumbnailPath);
    }

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
