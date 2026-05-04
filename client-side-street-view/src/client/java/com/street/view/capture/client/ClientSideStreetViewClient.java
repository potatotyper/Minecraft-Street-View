package com.street.view.capture.client;

import com.street.view.capture.ClientSideStreetView;
import com.street.view.protocol.CaptureRequestPayload;
import com.street.view.protocol.StreetViewProtocol;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;

public final class ClientSideStreetViewClient implements ClientModInitializer {
    private final PanoramaCaptureService captureService = new PanoramaCaptureService();

    @Override
    public void onInitializeClient() {
        StreetViewProtocol.registerClientboundPayloads();
        StreetViewProtocol.registerServerboundPayloads();

        ClientPlayNetworking.registerGlobalReceiver(CaptureRequestPayload.TYPE, (payload, context) ->
            captureService.start(context.client(), payload)
        );
        ClientTickEvents.END_CLIENT_TICK.register(captureService::tick);

        ClientSideStreetView.LOGGER.info("Client-side Street View capture initialized.");
    }
}
