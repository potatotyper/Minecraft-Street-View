package com.street.view;

import com.street.view.capture.CaptureCoordinator;
import com.street.view.command.StreetViewCommand;
import net.fabricmc.api.ModInitializer;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class MinecraftStreetView implements ModInitializer {
	public static final String MOD_ID = "minecraft-street-view";

	// This logger is used to write text to the console and the log file.
	// It is considered best practice to use your mod id as the logger's name.
	// That way, it's clear which mod wrote info, warnings, and errors.
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		CaptureCoordinator.registerNetworking();
		StreetViewCommand.register();
		LOGGER.info("Minecraft Street View initialized. Use '/streetview map status' to verify map export and capture setup.");
	}
}
