package com.street.view.protocol;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

public record CaptureRequestPayload(
    String captureId,
    String snapshotId,
    String nodeId,
    String dimension,
    float x,
    float y,
    float z,
    float yaw,
    float pitch,
    int width,
    int height,
    String format,
    boolean includeEntities
) implements CustomPacketPayload {
    public static final Type<CaptureRequestPayload> TYPE = new Type<>(
        Identifier.fromNamespaceAndPath(StreetViewProtocol.MOD_ID, "capture_request")
    );
    public static final StreamCodec<RegistryFriendlyByteBuf, CaptureRequestPayload> STREAM_CODEC = StreamCodec.of(
        CaptureRequestPayload::write,
        CaptureRequestPayload::read
    );

    private static CaptureRequestPayload read(RegistryFriendlyByteBuf buffer) {
        return new CaptureRequestPayload(
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readUtf(),
            buffer.readFloat(),
            buffer.readFloat(),
            buffer.readFloat(),
            buffer.readFloat(),
            buffer.readFloat(),
            buffer.readInt(),
            buffer.readInt(),
            buffer.readUtf(),
            buffer.readBoolean()
        );
    }

    private static void write(RegistryFriendlyByteBuf buffer, CaptureRequestPayload payload) {
        buffer.writeUtf(payload.captureId());
        buffer.writeUtf(payload.snapshotId());
        buffer.writeUtf(payload.nodeId());
        buffer.writeUtf(payload.dimension());
        buffer.writeFloat(payload.x());
        buffer.writeFloat(payload.y());
        buffer.writeFloat(payload.z());
        buffer.writeFloat(payload.yaw());
        buffer.writeFloat(payload.pitch());
        buffer.writeInt(payload.width());
        buffer.writeInt(payload.height());
        buffer.writeUtf(payload.format());
        buffer.writeBoolean(payload.includeEntities());
    }

    @Override
    public Type<? extends CustomPacketPayload> type() {
        return TYPE;
    }
}
