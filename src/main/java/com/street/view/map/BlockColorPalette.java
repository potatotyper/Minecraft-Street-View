package com.street.view.map;

import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.level.block.state.BlockState;

import java.awt.Color;
import java.util.Locale;

public final class BlockColorPalette {
    private static final Color VOID_COLOR = new Color(16, 18, 24);

    private BlockColorPalette() {
    }

    public static Color colorFor(BlockState state) {
        if (state.isAir()) {
            return VOID_COLOR;
        }

        Identifier id = BuiltInRegistries.BLOCK.getKey(state.getBlock());
        String path = id.getPath().toLowerCase(Locale.ROOT);

        if (path.contains("water")) {
            return new Color(54, 100, 190);
        }
        if (path.contains("lava")) {
            return new Color(255, 106, 29);
        }
        if (path.contains("grass") || path.contains("moss") || path.contains("leaves")) {
            return new Color(84, 136, 72);
        }
        if (path.contains("sand")) {
            return new Color(210, 199, 138);
        }
        if (path.contains("snow") || path.contains("ice")) {
            return new Color(214, 232, 248);
        }
        if (path.contains("stone") || path.contains("deepslate") || path.contains("cobblestone")) {
            return new Color(124, 129, 135);
        }
        if (path.contains("dirt") || path.contains("mud") || path.contains("clay")) {
            return new Color(121, 90, 66);
        }
        if (path.contains("wood") || path.contains("log") || path.contains("planks")) {
            return new Color(140, 108, 74);
        }

        int hash = id.toString().hashCode();
        int red = 70 + (hash & 0x3F);
        int green = 70 + ((hash >>> 6) & 0x3F);
        int blue = 70 + ((hash >>> 12) & 0x3F);
        return new Color(red, green, blue);
    }
}
