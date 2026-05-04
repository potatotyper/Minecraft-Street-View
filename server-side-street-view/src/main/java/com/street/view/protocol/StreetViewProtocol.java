package com.street.view.protocol;

import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;

public final class StreetViewProtocol {
    public static final String MOD_ID = "minecraft-street-view";
    public static final int PANORAMA_WIDTH = 4096;
    public static final int PANORAMA_HEIGHT = 2048;
    public static final String PANORAMA_FORMAT = "jpeg";
    public static final int SCHEMA_VERSION = 1;

    private static boolean clientboundRegistered;
    private static boolean serverboundRegistered;

    private StreetViewProtocol() {
    }

    public static void registerClientboundPayloads() {
        if (clientboundRegistered) {
            return;
        }

        clientboundRegistered = true;
        try {
            PayloadTypeRegistry.clientboundPlay().register(CaptureRequestPayload.TYPE, CaptureRequestPayload.STREAM_CODEC);
        } catch (IllegalArgumentException ignored) {
            // Another installed street-view jar may already have registered the shared channel.
        }
    }

    public static void registerServerboundPayloads() {
        if (serverboundRegistered) {
            return;
        }

        serverboundRegistered = true;
        try {
            PayloadTypeRegistry.serverboundPlay().register(CaptureStatusPayload.TYPE, CaptureStatusPayload.STREAM_CODEC);
        } catch (IllegalArgumentException ignored) {
            // Another installed street-view jar may already have registered the shared channel.
        }
    }
}
