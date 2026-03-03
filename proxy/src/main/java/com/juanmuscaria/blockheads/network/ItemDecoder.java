package com.juanmuscaria.blockheads.network;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;

/**
 * Decodes Blockheads item data from binary format to human-readable strings.
 * Item format: 8 bytes total
 * - Bytes 0-1: Item ID (little-endian uint16)
 * - Bytes 2-3: Count (little-endian uint16)
 * - Bytes 4-5: Extra/durability (little-endian uint16)
 * - Bytes 6-7: Padding (zeros)
 */
public class ItemDecoder {

    private static final Map<Integer, String> ITEM_NAMES = new HashMap<>();

    static {
        // Basic items (0-99)
        ITEM_NAMES.put(0, "UNKNOWN");
        ITEM_NAMES.put(1, "CLOTHING");
        ITEM_NAMES.put(3, "FLINT");
        ITEM_NAMES.put(4, "STICK");
        ITEM_NAMES.put(6, "FLINT_AXE");
        ITEM_NAMES.put(7, "FLINT_SPEAR");
        ITEM_NAMES.put(8, "FLINT_PICKAXE");
        ITEM_NAMES.put(9, "DOUBLE_TIME");
        ITEM_NAMES.put(11, "TIME_CRYSTAL");
        ITEM_NAMES.put(12, "BASKET");
        ITEM_NAMES.put(13, "EMBER");
        ITEM_NAMES.put(14, "CHARCOAL");
        ITEM_NAMES.put(15, "CAMPFIRE");
        ITEM_NAMES.put(16, "FLINT_SPADE");
        ITEM_NAMES.put(17, "TORCH");
        ITEM_NAMES.put(19, "BLOCKHEAD");
        ITEM_NAMES.put(20, "FOOD");
        ITEM_NAMES.put(21, "APPLE");
        ITEM_NAMES.put(22, "MANGO");
        ITEM_NAMES.put(23, "MAPLE_SEED");
        ITEM_NAMES.put(24, "PRICKLY_PEAR");
        ITEM_NAMES.put(25, "FLINT_MACHETE");
        ITEM_NAMES.put(27, "PINECONE");
        ITEM_NAMES.put(28, "CLAY");
        ITEM_NAMES.put(29, "DODO_MEAT");
        ITEM_NAMES.put(30, "DODO_FEATHER");
        ITEM_NAMES.put(31, "COPPER_ORE");
        ITEM_NAMES.put(32, "IRON_ORE");
        ITEM_NAMES.put(33, "STONE_AXE");
        ITEM_NAMES.put(34, "STONE_PICKAXE");
        ITEM_NAMES.put(35, "COPPER_INGOT");
        ITEM_NAMES.put(36, "TIN_ORE");
        ITEM_NAMES.put(37, "TIN_INGOT");
        ITEM_NAMES.put(38, "BRONZE_INGOT");
        ITEM_NAMES.put(39, "COPPER_SPEAR");
        ITEM_NAMES.put(40, "TIN_SPADE");
        ITEM_NAMES.put(41, "COPPER_ARROW");
        ITEM_NAMES.put(42, "COPPER_BOW_AND_ARROWS");
        ITEM_NAMES.put(43, "BRONZE_PICKAXE");
        ITEM_NAMES.put(44, "STRING");
        ITEM_NAMES.put(45, "CLAY_JUG");
        ITEM_NAMES.put(46, "COCONUT");
        ITEM_NAMES.put(47, "OIL_LANTERN");
        ITEM_NAMES.put(48, "OIL");
        ITEM_NAMES.put(49, "BRONZE_MACHETE");
        ITEM_NAMES.put(50, "BRONZE_SWORD");
        ITEM_NAMES.put(51, "COAL");
        ITEM_NAMES.put(52, "DOOR");
        ITEM_NAMES.put(53, "LADDER");
        ITEM_NAMES.put(54, "FLAX_SEED");
        ITEM_NAMES.put(55, "FLAX");
        ITEM_NAMES.put(56, "INDIAN_YELLOW");
        ITEM_NAMES.put(57, "RED_OCHRE");
        ITEM_NAMES.put(58, "WINDOW");
        ITEM_NAMES.put(59, "COOKED_DODO_MEAT");
        ITEM_NAMES.put(60, "ORANGE");
        ITEM_NAMES.put(61, "SUNFLOWER_SEED");
        ITEM_NAMES.put(62, "CORN");
        ITEM_NAMES.put(63, "BED");
        ITEM_NAMES.put(64, "STONE_SPADE");
        ITEM_NAMES.put(65, "IRON_INGOT");
        ITEM_NAMES.put(66, "IRON_PICKAXE");
        ITEM_NAMES.put(67, "IRON_MACHETE");
        ITEM_NAMES.put(68, "IRON_SWORD");
        ITEM_NAMES.put(69, "TRAPDOOR");
        ITEM_NAMES.put(70, "IRON_AXE");
        ITEM_NAMES.put(71, "CARROT");
        ITEM_NAMES.put(72, "GOLD_INGOT");
        ITEM_NAMES.put(73, "GOLD_NUGGET");
        ITEM_NAMES.put(74, "CARROT_ON_A_STICK");
        ITEM_NAMES.put(75, "RUBY");
        ITEM_NAMES.put(76, "EMERALD");
        ITEM_NAMES.put(77, "CHERRY");
        ITEM_NAMES.put(78, "COFFEE_CHERRY");
        ITEM_NAMES.put(79, "GREEN_COFFEE_BEAN");
        ITEM_NAMES.put(80, "CUP");
        ITEM_NAMES.put(81, "COFFEE");
        ITEM_NAMES.put(82, "ROASTED_COFFEE_BEAN");
        ITEM_NAMES.put(83, "LINEN");
        ITEM_NAMES.put(84, "LINEN_PANTS");
        ITEM_NAMES.put(85, "LINEN_SHIRT");
        ITEM_NAMES.put(86, "SAPPHIRE");
        ITEM_NAMES.put(87, "AMETHYST");
        ITEM_NAMES.put(88, "DIAMOND");
        ITEM_NAMES.put(89, "GOLD_SPADE");
        ITEM_NAMES.put(90, "GOLD_PICKAXE");
        ITEM_NAMES.put(91, "DODO_EGG");
        ITEM_NAMES.put(92, "STEEL_INGOT");
        ITEM_NAMES.put(93, "STEEL_PICKAXE");
        ITEM_NAMES.put(94, "AMETHYST_PICKAXE");
        ITEM_NAMES.put(95, "SAPPHIRE_PICKAXE");
        ITEM_NAMES.put(96, "EMERALD_PICKAXE");
        ITEM_NAMES.put(97, "RUBY_PICKAXE");
        ITEM_NAMES.put(98, "DIAMOND_PICKAXE");
        ITEM_NAMES.put(99, "ULTRAMARINE_BLUE");

        // Items 100-199
        ITEM_NAMES.put(100, "CARBON_BLACK");
        ITEM_NAMES.put(101, "MARBLE_WHITE");
        ITEM_NAMES.put(102, "TIN_BUCKET");
        ITEM_NAMES.put(103, "PAINT");
        ITEM_NAMES.put(104, "PAINT_STRIPPER");
        ITEM_NAMES.put(105, "BUCKET_OF_WATER");
        ITEM_NAMES.put(106, "PIGMENT");
        ITEM_NAMES.put(107, "RAINBOW_PAINT_CAP");
        ITEM_NAMES.put(109, "EMERALD_GREEN");
        ITEM_NAMES.put(110, "TYRIAN_PURPLE");
        ITEM_NAMES.put(111, "BOAT");
        ITEM_NAMES.put(112, "CHILLI");
        ITEM_NAMES.put(113, "RAINBOW_LINEN_PANTS");
        ITEM_NAMES.put(114, "RAINBOW_SHIRT");
        ITEM_NAMES.put(115, "LINEN_CAP");
        ITEM_NAMES.put(116, "RAINBOW_CAP");
        ITEM_NAMES.put(117, "LINEN_BRIMMED_HAT");
        ITEM_NAMES.put(118, "RAINBOW_BRIMMED_HAT");
        ITEM_NAMES.put(119, "COPPER_BLUE");
        ITEM_NAMES.put(120, "LEATHER");
        ITEM_NAMES.put(121, "FUR");
        ITEM_NAMES.put(122, "LEATHER_JACKET");
        ITEM_NAMES.put(123, "RAINBOW_JACKET");
        ITEM_NAMES.put(124, "LEATHER_BOOTS");
        ITEM_NAMES.put(125, "RAINBOW_LEATHER_BOOTS");
        ITEM_NAMES.put(126, "FUR_COAT");
        ITEM_NAMES.put(127, "FUR_BOOTS");
        ITEM_NAMES.put(128, "RAINBOW_COAT");
        ITEM_NAMES.put(129, "RAINBOW_FUR_BOOTS");
        ITEM_NAMES.put(130, "LEATHER_PANTS");
        ITEM_NAMES.put(131, "RAINBOW_LEATHER_PANTS");
        ITEM_NAMES.put(132, "UPGRADE");
        ITEM_NAMES.put(133, "CAMERA");
        ITEM_NAMES.put(134, "PORTAL");
        ITEM_NAMES.put(135, "AMETHYST_PORTAL");
        ITEM_NAMES.put(136, "SAPPHIRE_PORTAL");
        ITEM_NAMES.put(137, "EMERALD_PORTAL");
        ITEM_NAMES.put(138, "RUBY_PORTAL");
        ITEM_NAMES.put(139, "DIAMOND_PORTAL");
        ITEM_NAMES.put(140, "SUNRISE_HAT_OF_FULLNESS");
        ITEM_NAMES.put(141, "SUNSET_SKIRT_OF_HAPPINESS");
        ITEM_NAMES.put(142, "NORTH_POLE_HAT_OF_WARMTH");
        ITEM_NAMES.put(143, "SOUTH_POLE_BOOTS_OF_SPEED");
        ITEM_NAMES.put(144, "KELP");
        ITEM_NAMES.put(145, "AMETHYST_CHANDELIER");
        ITEM_NAMES.put(146, "SAPPHIRE_CHANDELIER");
        ITEM_NAMES.put(147, "EMERALD_CHANDELIER");
        ITEM_NAMES.put(148, "RUBY_CHANDELIER");
        ITEM_NAMES.put(149, "DIAMOND_CHANDELIER");
        ITEM_NAMES.put(150, "STEEL_LANTERN");
        ITEM_NAMES.put(151, "RAW_FISH");
        ITEM_NAMES.put(152, "COOKED_FISH");
        ITEM_NAMES.put(153, "TIN_FOIL");
        ITEM_NAMES.put(154, "TIN_FOIL_HAT");
        ITEM_NAMES.put(155, "WORM");
        ITEM_NAMES.put(156, "FISHING_ROD");
        ITEM_NAMES.put(157, "SHARK_JAW");
        ITEM_NAMES.put(158, "FISH_BUCKET");
        ITEM_NAMES.put(159, "SHARK_BUCKET");
        ITEM_NAMES.put(160, "LIME");
        ITEM_NAMES.put(161, "SHELF");
        ITEM_NAMES.put(162, "TELEPORT_HERE");
        ITEM_NAMES.put(163, "SIGN");
        ITEM_NAMES.put(164, "IRON_DOOR");
        ITEM_NAMES.put(165, "IRON_TRAPDOOR");
        ITEM_NAMES.put(166, "COPPER_COIN");
        ITEM_NAMES.put(167, "GOLD_COIN");
        ITEM_NAMES.put(168, "SHOP");
        ITEM_NAMES.put(169, "SOFT_BED");
        ITEM_NAMES.put(170, "GOLDEN_BED");
        ITEM_NAMES.put(171, "BED_BLANKET");
        ITEM_NAMES.put(172, "RAINBOW_SOFT_BED");
        ITEM_NAMES.put(173, "RAINBOW_GOLDEN_BED");
        ITEM_NAMES.put(174, "BLACK_WINDOW");
        ITEM_NAMES.put(175, "MAGNET");
        ITEM_NAMES.put(176, "COPPER_BOILER");
        ITEM_NAMES.put(177, "ELECTRONIC_MOTOR");
        ITEM_NAMES.put(178, "COPPER_WIRE");
        ITEM_NAMES.put(179, "STEAM_ENGINE");
        ITEM_NAMES.put(180, "IRON_POT");
        ITEM_NAMES.put(181, "FISH_CURRY");
        ITEM_NAMES.put(182, "DODO_STEW");
        ITEM_NAMES.put(183, "ICE_TORCH");
        ITEM_NAMES.put(184, "SILICON_INGOT");
        ITEM_NAMES.put(185, "SILICON_CRYSTAL");
        ITEM_NAMES.put(186, "SILICON_WAFER");
        ITEM_NAMES.put(187, "TIN_ARMOR_LEGGINGS");
        ITEM_NAMES.put(188, "TIN_CHEST_PLATE");
        ITEM_NAMES.put(189, "TIN_HELMET");
        ITEM_NAMES.put(190, "TIN_BOOTS");
        ITEM_NAMES.put(191, "IRON_ARMOR_LEGGINGS");
        ITEM_NAMES.put(192, "IRON_CHEST_PLATE");
        ITEM_NAMES.put(193, "IRON_HELMET");
        ITEM_NAMES.put(194, "IRON_BOOTS");
        ITEM_NAMES.put(195, "ICE_ARMOR_LEGGINGS");
        ITEM_NAMES.put(196, "ICE_CHEST_PLATE");
        ITEM_NAMES.put(197, "ICE_HELMET");
        ITEM_NAMES.put(198, "ICE_BOOTS");
        ITEM_NAMES.put(199, "RAIL");

        // Items 200-299
        ITEM_NAMES.put(200, "TRAIN_STATION");
        ITEM_NAMES.put(201, "PIG_IRON");
        ITEM_NAMES.put(202, "CRUSHED_LIMESTONE");
        ITEM_NAMES.put(203, "TRAIN_WHEEL");
        ITEM_NAMES.put(204, "RAIL_HANDCAR");
        ITEM_NAMES.put(205, "STEAM_LOCOMOTIVE");
        ITEM_NAMES.put(206, "FREIGHT_CAR");
        ITEM_NAMES.put(207, "DISPLAY_CABINET");
        ITEM_NAMES.put(208, "PASSENGER_CAR");
        ITEM_NAMES.put(209, "CROWBAR");
        ITEM_NAMES.put(210, "TRADE_PORTAL");
        ITEM_NAMES.put(212, "LARGE_SQUARE_PAINTING");
        ITEM_NAMES.put(213, "LARGE_LANDSCAPE_PAINTING");
        ITEM_NAMES.put(214, "LARGE_PORTRAIT_PAINTING");
        ITEM_NAMES.put(215, "MED_SQUARE_PAINTING");
        ITEM_NAMES.put(216, "MED_LANDSCAPE_PAINTING");
        ITEM_NAMES.put(217, "MED_PORTRAIT_PAINTING");
        ITEM_NAMES.put(218, "SMALL_SQUARE_PAINTING");
        ITEM_NAMES.put(219, "SMALL_LANDSCAPE_PAINTING");
        ITEM_NAMES.put(220, "SMALL_PORTRAIT_PAINTING");
        ITEM_NAMES.put(221, "EASEL");
        ITEM_NAMES.put(222, "STONE_COLUMN");
        ITEM_NAMES.put(223, "LIMESTONE_COLUMN");
        ITEM_NAMES.put(224, "MARBLE_COLUMN");
        ITEM_NAMES.put(225, "SANDSTONE_COLUMN");
        ITEM_NAMES.put(226, "RED_MARBLE_COLUMN");
        ITEM_NAMES.put(227, "LAPIS_LAZULI_COLUMN");
        ITEM_NAMES.put(228, "BASALT_COLUMN");
        ITEM_NAMES.put(229, "STONE_STAIRS");
        ITEM_NAMES.put(230, "LIMESTONE_STAIRS");
        ITEM_NAMES.put(231, "MARBLE_STAIRS");
        ITEM_NAMES.put(232, "SANDSTONE_STAIRS");
        ITEM_NAMES.put(233, "RED_MARBLE_STAIRS");
        ITEM_NAMES.put(234, "LAPIS_LAZULI_STAIRS");
        ITEM_NAMES.put(235, "BASALT_STAIRS");
        ITEM_NAMES.put(236, "COPPER_COLUMN");
        ITEM_NAMES.put(237, "TIN_COLUMN");
        ITEM_NAMES.put(238, "BRONZE_COLUMN");
        ITEM_NAMES.put(239, "IRON_COLUMN");
        ITEM_NAMES.put(240, "STEEL_COLUMN");
        ITEM_NAMES.put(241, "GOLD_COLUMN");
        ITEM_NAMES.put(242, "WOOD_COLUMN");
        ITEM_NAMES.put(243, "BRICK_COLUMN");
        ITEM_NAMES.put(244, "ICE_COLUMN");
        ITEM_NAMES.put(245, "COPPER_STAIRS");
        ITEM_NAMES.put(246, "TIN_STAIRS");
        ITEM_NAMES.put(247, "BRONZE_STAIRS");
        ITEM_NAMES.put(248, "IRON_STAIRS");
        ITEM_NAMES.put(249, "STEEL_STAIRS");
        ITEM_NAMES.put(250, "GOLD_STAIRS");
        ITEM_NAMES.put(251, "WOOD_STAIRS");
        ITEM_NAMES.put(252, "BRICK_STAIRS");
        ITEM_NAMES.put(253, "ICE_STAIRS");
        ITEM_NAMES.put(254, "STEEL_DOWNLIGHT");
        ITEM_NAMES.put(255, "POISON");
        ITEM_NAMES.put(256, "POISON_ARROW");
        ITEM_NAMES.put(257, "GOLD_BOW_AND_POISON_ARROWS");
        ITEM_NAMES.put(258, "STEEL_UPLIGHT");
        ITEM_NAMES.put(259, "WORLD_CREDIT");
        ITEM_NAMES.put(260, "PLATINUM_COIN");
        ITEM_NAMES.put(261, "PLATINUM_NUGGET");
        ITEM_NAMES.put(262, "PLATINUM_INGOT");
        ITEM_NAMES.put(269, "FUEL");
        ITEM_NAMES.put(270, "REFINERY");
        ITEM_NAMES.put(271, "EPOXY");
        ITEM_NAMES.put(272, "RAW_RESIN");
        ITEM_NAMES.put(273, "CARBON_FIBERS");
        ITEM_NAMES.put(274, "CARBON_FIBER_SHEET");
        ITEM_NAMES.put(275, "CARBON_FIBER_WING");
        ITEM_NAMES.put(276, "JETPACK_CHASSIS");
        ITEM_NAMES.put(277, "JET_ENGINE");
        ITEM_NAMES.put(278, "JETPACK");
        ITEM_NAMES.put(279, "TITANIUM_ORE");
        ITEM_NAMES.put(280, "TITANIUM_INGOT");
        ITEM_NAMES.put(285, "TITANIUM_PICKAXE");
        ITEM_NAMES.put(286, "TITANIUM_SWORD");
        ITEM_NAMES.put(287, "TITANIUM_LEGGINGS");
        ITEM_NAMES.put(288, "TITANIUM_CHEST_PLATE");
        ITEM_NAMES.put(289, "TITANIUM_HELMET");
        ITEM_NAMES.put(290, "TITANIUM_BOOTS");
        ITEM_NAMES.put(291, "CARBON_FIBER_LEGGINGS");
        ITEM_NAMES.put(292, "CARBON_FIBER_CHEST_PLATE");
        ITEM_NAMES.put(293, "CARBON_FIBER_HELMET");
        ITEM_NAMES.put(294, "CARBON_FIBER_BOOTS");
        ITEM_NAMES.put(295, "VINE");
        ITEM_NAMES.put(296, "TULIP_BULB");
        ITEM_NAMES.put(297, "TULIP_SEED");
        ITEM_NAMES.put(298, "COINS");
        ITEM_NAMES.put(299, "RANDOM_ORE");

        // Items 300-399
        ITEM_NAMES.put(300, "ELECTRIC_SLUICE");
        ITEM_NAMES.put(301, "OWNERSHIP_SIGN");
        ITEM_NAMES.put(302, "CAGE");
        ITEM_NAMES.put(303, "CAGED_DODO");
        ITEM_NAMES.put(304, "WOODEN_GATE");
        ITEM_NAMES.put(305, "AMETHYST_SHARD");
        ITEM_NAMES.put(306, "SAPPHIRE_SHARD");
        ITEM_NAMES.put(307, "EMERALD_SHARD");
        ITEM_NAMES.put(308, "RUBY_SHARD");
        ITEM_NAMES.put(309, "DIAMOND_SHARD");
        ITEM_NAMES.put(310, "WHEAT");
        ITEM_NAMES.put(311, "FLOUR");
        ITEM_NAMES.put(312, "YEAST");
        ITEM_NAMES.put(313, "SALT");
        ITEM_NAMES.put(314, "DOUGH");
        ITEM_NAMES.put(315, "BREAD");
        ITEM_NAMES.put(316, "TOMATO");
        ITEM_NAMES.put(317, "PIZZA");
        ITEM_NAMES.put(318, "FLATBREAD");
        ITEM_NAMES.put(319, "MILK");
        ITEM_NAMES.put(320, "MOZZARELLA");
        ITEM_NAMES.put(321, "YAK_HORN");
        ITEM_NAMES.put(322, "RAZOR");
        ITEM_NAMES.put(323, "YAK_SHAVINGS");
        ITEM_NAMES.put(324, "CAGED_DONKEY");
        ITEM_NAMES.put(325, "CAGED_YAK");
        ITEM_NAMES.put(326, "CAGED_DROPBEAR");
        ITEM_NAMES.put(327, "CAGED_SCORPION");
        ITEM_NAMES.put(328, "RAINBOW_CAKE");
        ITEM_NAMES.put(329, "RAINBOW_ESSENCE");
        ITEM_NAMES.put(330, "CAGED_UNICORN");
        ITEM_NAMES.put(331, "MIRROR");
        ITEM_NAMES.put(332, "PLASTER_COLUMN");
        ITEM_NAMES.put(333, "PLASTER_STAIRS");
        ITEM_NAMES.put(334, "AMETHYST_COLUMN");
        ITEM_NAMES.put(335, "SAPPHIRE_COLUMN");
        ITEM_NAMES.put(336, "EMERALD_COLUMN");
        ITEM_NAMES.put(337, "RUBY_COLUMN");
        ITEM_NAMES.put(338, "DIAMOND_COLUMN");
        ITEM_NAMES.put(339, "AMETHYST_STAIRS");
        ITEM_NAMES.put(340, "SAPPHIRE_STAIRS");
        ITEM_NAMES.put(341, "EMERALD_STAIRS");
        ITEM_NAMES.put(342, "RUBY_STAIRS");
        ITEM_NAMES.put(343, "DIAMOND_STAIRS");

        // Block items (1024+)
        ITEM_NAMES.put(1024, "STONE");
        ITEM_NAMES.put(1025, "KILN");
        ITEM_NAMES.put(1026, "BRICK");
        ITEM_NAMES.put(1027, "LIMESTONE");
        ITEM_NAMES.put(1029, "MARBLE");
        ITEM_NAMES.put(1031, "FURNACE");
        ITEM_NAMES.put(1032, "WOODWORK_BENCH");
        ITEM_NAMES.put(1033, "TAYLORS_BENCH");
        ITEM_NAMES.put(1034, "PRESS");
        ITEM_NAMES.put(1035, "SANDSTONE");
        ITEM_NAMES.put(1037, "RED_MARBLE");
        ITEM_NAMES.put(1042, "GLASS");
        ITEM_NAMES.put(1043, "CHEST");
        ITEM_NAMES.put(1045, "GOLD_BLOCK");
        ITEM_NAMES.put(1047, "ROCK");
        ITEM_NAMES.put(1048, "DIRT");
        ITEM_NAMES.put(1049, "WOOD");
        ITEM_NAMES.put(1050, "WORK_BENCH");
        ITEM_NAMES.put(1051, "SAND");
        ITEM_NAMES.put(1052, "TOOL_BENCH");
        ITEM_NAMES.put(1053, "LAPIS_LAZULI");
        ITEM_NAMES.put(1055, "CRAFT_BENCH");
        ITEM_NAMES.put(1056, "MIXING_BENCH");
        ITEM_NAMES.put(1057, "REINFORCED_PLATFORM");
        ITEM_NAMES.put(1060, "ICE");
        ITEM_NAMES.put(1061, "DYE_BENCH");
        ITEM_NAMES.put(1062, "COMPOST");
        ITEM_NAMES.put(1063, "BASALT");
        ITEM_NAMES.put(1065, "SAFE");
        ITEM_NAMES.put(1066, "COPPER_BLOCK");
        ITEM_NAMES.put(1067, "TIN_BLOCK");
        ITEM_NAMES.put(1068, "BRONZE_BLOCK");
        ITEM_NAMES.put(1069, "IRON_BLOCK");
        ITEM_NAMES.put(1070, "STEEL_BLOCK");
        ITEM_NAMES.put(1071, "METALWORK_BENCH");
        ITEM_NAMES.put(1072, "GOLDEN_CHEST");
        ITEM_NAMES.put(1074, "PORTAL_CHEST");
        ITEM_NAMES.put(1075, "BLACK_SAND");
        ITEM_NAMES.put(1076, "BLACK_GLASS");
        ITEM_NAMES.put(1077, "STEAM_GENERATOR");
        ITEM_NAMES.put(1078, "ELECTRIC_KILN");
        ITEM_NAMES.put(1079, "ELECTRIC_FURNACE");
        ITEM_NAMES.put(1080, "ELECTRIC_METALWORK_BENCH");
        ITEM_NAMES.put(1081, "ELECTRIC_STOVE");
        ITEM_NAMES.put(1082, "SOLAR_PANEL");
        ITEM_NAMES.put(1084, "ARMOR_BENCH");
        ITEM_NAMES.put(1085, "TRAIN_YARD");
        ITEM_NAMES.put(1086, "BUILDERS_BENCH");
        ITEM_NAMES.put(1087, "ELEVATOR_SHAFT");
        ITEM_NAMES.put(1089, "PLATINUM_BLOCK");
        ITEM_NAMES.put(1090, "CARBON_FIBER_BLOCK");
        ITEM_NAMES.put(1091, "TITANIUM_BLOCK");
        ITEM_NAMES.put(1094, "GRAVEL");
        ITEM_NAMES.put(1095, "COMPOST_BIN");
        ITEM_NAMES.put(1097, "PIZZA_OVEN");
        ITEM_NAMES.put(1098, "AMETHYST_BLOCK");
        ITEM_NAMES.put(1099, "SAPPHIRE_BLOCK");
        ITEM_NAMES.put(1100, "EMERALD_BLOCK");
        ITEM_NAMES.put(1101, "RUBY_BLOCK");
        ITEM_NAMES.put(1102, "DIAMOND_BLOCK");
        ITEM_NAMES.put(1103, "PLASTER");
        ITEM_NAMES.put(1104, "FEEDER_CHEST");
        ITEM_NAMES.put(1105, "LUMINOUS_PLASTER");
    }

    /**
     * Get human-readable item name from ID.
     */
    public static String getItemName(int itemId) {
        return ITEM_NAMES.getOrDefault(itemId, "UNKNOWN_" + itemId);
    }

    /**
     * Decode 8-byte item data into human-readable string.
     */
    public static String decodeItem(byte[] data) {
        if (data == null || data.length < 8) {
            return "INVALID";
        }

        ByteBuffer buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        int itemId = buf.getShort() & 0xFFFF;
        int count = buf.getShort() & 0xFFFF;
        int extra = buf.getShort() & 0xFFFF;

        String name = getItemName(itemId);

        if (count > 1) {
            return String.format("%s x%d (id=%d, extra=%d)", name, count, itemId, extra);
        } else {
            return String.format("%s (id=%d, extra=%d)", name, itemId, extra);
        }
    }

    /**
     * Decode 8-byte item data and return [itemId, count] or null if invalid.
     */
    public static int[] decodeItemIdAndCount(byte[] data) {
        int[] decoded = decodeItemIdCountAndExtra(data);
        if (decoded == null) {
            return null;
        }
        return new int[]{decoded[0], decoded[1]};
    }

    /**
     * Decode 8-byte item data and return [itemId, count, extra] or null if invalid.
     */
    public static int[] decodeItemIdCountAndExtra(byte[] data) {
        if (data == null || data.length < 4) {
            return null;
        }

        ByteBuffer buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        int itemId = buf.getShort() & 0xFFFF;
        int count = buf.getShort() & 0xFFFF;
        int extra = 0;
        if (data.length >= 6) {
            extra = buf.getShort() & 0xFFFF;
        }

        if (itemId == 0) return null; // Empty/invalid item

        return new int[]{itemId, count, extra};
    }

    /**
     * Decode base64-encoded item data.
     */
    public static String decodeBase64Item(String base64) {
        try {
            byte[] data = Base64.getDecoder().decode(base64.trim());
            return decodeItem(data);
        } catch (Exception e) {
            return "DECODE_ERROR: " + e.getMessage();
        }
    }

    /**
     * Check if an item ID represents a potentially "illegal" or admin-only item.
     * These are items that normal players shouldn't have in survival.
     */
    public static boolean isIllegalItem(int itemId) {
        // Time crystals, portals, special items that might indicate cheating
        return itemId == 11  // TIME_CRYSTAL
            || itemId == 9   // DOUBLE_TIME
            || itemId == 132 // UPGRADE
            || itemId == 259 // WORLD_CREDIT
            || itemId == 329 // RAINBOW_ESSENCE
            || (itemId >= 134 && itemId <= 139); // All portal types
    }
}
