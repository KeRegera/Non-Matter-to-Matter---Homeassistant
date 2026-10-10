/**
 * Mapping of Home Assistant entities to Matter device types.
 *
 * Every mapper decides which Matter device type and which cluster features an entity gets (derived from the
 * entity's supported features), and how Home Assistant state translates into Matter attributes.
 */
import type { EndpointType } from "@matter/main";
import {
    AirQualityServer,
    BooleanStateServer,
    CarbonDioxideConcentrationMeasurementServer,
    CarbonMonoxideConcentrationMeasurementServer,
    FormaldehydeConcentrationMeasurementServer,
    NitrogenDioxideConcentrationMeasurementServer,
    OccupancySensingServer,
    OzoneConcentrationMeasurementServer,
    Pm10ConcentrationMeasurementServer,
    Pm1ConcentrationMeasurementServer,
    Pm25ConcentrationMeasurementServer,
    RadonConcentrationMeasurementServer,
    RelativeHumidityMeasurementServer,
    SmokeCoAlarmServer,
    TotalVolatileOrganicCompoundsConcentrationMeasurementServer,
} from "@matter/main/behaviors";
import {
    AirQuality,
    ColorControl,
    ConcentrationMeasurement,
    DoorLock,
    FanControl,
    OperationalState,
    RvcCleanMode,
    RvcRunMode,
    SmokeCoAlarm,
    Thermostat,
    ValveConfigurationAndControl,
    WindowCovering,
} from "@matter/main/clusters";
import {
    AirPurifierDevice,
    AirQualitySensorDevice,
    ColorTemperatureLightDevice,
    ContactSensorDevice,
    DimmableLightDevice,
    DimmablePlugInUnitDevice,
    DoorLockDevice,
    ExtendedColorLightDevice,
    FanDevice,
    FlowSensorDevice,
    HumiditySensorDevice,
    LightSensorDevice,
    ModeSelectDevice,
    OccupancySensorDevice,
    OnOffLightDevice,
    OnOffPlugInUnitDevice,
    PressureSensorDevice,
    RainSensorDevice,
    RoboticVacuumCleanerDevice,
    SmokeCoAlarmDevice,
    SpeakerDevice,
    TemperatureSensorDevice,
    ThermostatDevice,
    WaterFreezeDetectorDevice,
    WaterLeakDetectorDevice,
    WaterValveDevice,
    WindowCoveringDevice,
} from "@matter/main/devices";
import type { HassEntity } from "../ha/types.js";
import {
    HaColorControlServer,
    HaDoorLockServer,
    HaFanControlServer,
    HaLevelControlServer,
    HaModeSelectServer,
    HaOnOffServer,
    HaRvcCleanModeServer,
    HaRvcOperationalStateServer,
    HaRvcRunModeServer,
    HaThermostatServer,
    HaValveServer,
    HaWindowCoveringServer,
    RvcRunModes,
    orderedClimateFanModes,
} from "./behaviors.js";
import type { EntityContext } from "./context.js";
import {
    brightnessToLevel,
    clamp,
    flowToMatter,
    hueToMatter,
    isOn,
    kelvinToMireds,
    levelToBrightness,
    levelToPercent,
    luxToMatter,
    num,
    percentToLevel,
    pressureToMatter,
    satToMatter,
    temperatureToMatter,
    transitionSeconds,
    xyToMatter,
} from "./convert.js";

/** Cluster state patch keyed by behavior id */
export type StatePatch = Record<string, any>;

export interface MappedDevice {
    type: EndpointType;
    state: StatePatch;
}

export interface DeviceMapper {
    /** Unique id, also used in the configuration UI to override the automatic choice */
    id: string;
    /** Human readable name */
    label: string;
    /** Domains this mapper can handle */
    domains: string[];
    /** Whether this mapper is the automatic choice for an entity */
    auto?(entity: HassEntity): boolean;
    /** Describes the Matter structure; the endpoint is rebuilt if it changes */
    signature(entity: HassEntity): string;
    create(entity: HassEntity, ctx: EntityContext): MappedDevice;
    update(entity: HassEntity, ctx: EntityContext): StatePatch;
}

const attr = (entity: HassEntity, name: string) => entity.attributes?.[name];
const features = (entity: HassEntity) => Number(attr(entity, "supported_features") ?? 0);
const deviceClass = (entity: HassEntity) => String(attr(entity, "device_class") ?? "");
const available = (entity: HassEntity) => entity.state !== "unavailable" && entity.state !== "unknown";
const sig = (...parts: unknown[]) => parts.map(p => (typeof p === "boolean" ? (p ? 1 : 0) : String(p))).join("|");

// ---------------------------------------------------------------------------------------------------------------
// Generic on/off (switch, input_boolean, automation, script, scene, button, siren, humidifier, ...)
// ---------------------------------------------------------------------------------------------------------------

const MOMENTARY_DOMAINS = ["scene", "script", "button", "input_button"];

function setupOnOff(ctx: EntityContext) {
    const domain = ctx.domain;
    ctx.momentary = MOMENTARY_DOMAINS.includes(domain);
    ctx.turnOn = async () => {
        switch (domain) {
            case "scene":
                return ctx.call("turn_on");
            case "script":
                return ctx.call("turn_on");
            case "button":
            case "input_button":
                return ctx.call("press");
            case "lock":
                return ctx.call("unlock");
            case "cover":
                return ctx.call("open_cover");
            case "valve":
                return ctx.call("open_valve");
            case "vacuum":
                return ctx.call("start");
            case "lawn_mower":
                return ctx.call("start_mowing");
            case "alarm_control_panel":
                return ctx.call("alarm_arm_away");
            default:
                return ctx.call("turn_on", {}, "homeassistant");
        }
    };
    ctx.turnOff = async () => {
        switch (domain) {
            case "scene":
            case "button":
            case "input_button":
                return;
            case "script":
                return ctx.call("turn_off");
            case "lock":
                return ctx.call("lock");
            case "cover":
                return ctx.call("close_cover");
            case "valve":
                return ctx.call("close_valve");
            case "vacuum":
                return ctx.call("return_to_base");
            case "lawn_mower":
                return ctx.call("dock");
            case "alarm_control_panel":
                return ctx.call("alarm_disarm");
            default:
                return ctx.call("turn_off", {}, "homeassistant");
        }
    };
}

function onOffValue(entity: HassEntity, domain: string) {
    if (MOMENTARY_DOMAINS.includes(domain) && domain !== "script") return false;
    switch (domain) {
        case "lock":
            return entity.state === "unlocked" || entity.state === "open";
        case "cover":
        case "valve":
            return entity.state === "open" || entity.state === "opening";
        case "vacuum":
        case "lawn_mower":
            return entity.state === "cleaning" || entity.state === "mowing";
        case "alarm_control_panel":
            return entity.state.startsWith("armed") || entity.state === "triggered";
        case "media_player":
            return !["off", "standby", "unavailable", "unknown"].includes(entity.state);
        default:
            return isOn(entity.state);
    }
}

const ON_OFF_DOMAINS = [
    "switch",
    "input_boolean",
    "automation",
    "script",
    "scene",
    "button",
    "input_button",
    "siren",
    "humidifier",
    "group",
    "remote",
    "media_player",
    "light",
    "fan",
    "climate",
    "lock",
    "cover",
    "valve",
    "vacuum",
    "lawn_mower",
    "water_heater",
    "alarm_control_panel",
    "camera",
];

function onOffMapper(id: string, label: string, type: EndpointType, autoDomains: string[]): DeviceMapper {
    return {
        id,
        label,
        domains: ON_OFF_DOMAINS,
        auto: entity => autoDomains.includes(entity.entity_id.split(".")[0]),
        signature: () => id,
        create(entity, ctx) {
            setupOnOff(ctx);
            return { type, state: this.update(entity, ctx) };
        },
        update(entity, ctx) {
            if (!available(entity)) return {};
            return { onOff: { onOff: onOffValue(entity, ctx.domain) } };
        },
    };
}

const OutletType = OnOffPlugInUnitDevice.with(HaOnOffServer);
const OnOffLightType = OnOffLightDevice.with(HaOnOffServer.with("Lighting"));

// ---------------------------------------------------------------------------------------------------------------
// Lights
// ---------------------------------------------------------------------------------------------------------------

const COLOR_MODES = ["hs", "xy", "rgb", "rgbw", "rgbww"];

function lightCaps(entity: HassEntity) {
    const modes: string[] = attr(entity, "supported_color_modes") ?? [];
    const color = modes.some(m => COLOR_MODES.includes(m));
    const ct = modes.includes("color_temp");
    const dim = color || ct || modes.includes("brightness") || modes.includes("white");
    return { color, ct, dim, hs: color, xy: color };
}

function setupLight(ctx: EntityContext) {
    ctx.turnOn = () => ctx.call("turn_on", {}, "light");
    ctx.turnOff = () => ctx.call("turn_off", {}, "light");
    ctx.setLevel = (level, transition) => {
        const t = transitionSeconds(transition);
        return ctx.call("turn_on", { brightness: levelToBrightness(level), ...(t ? { transition: t } : {}) }, "light");
    };
}

function lightMireds(entity: HassEntity) {
    const minK = num(attr(entity, "min_color_temp_kelvin")) ?? 2000;
    const maxK = num(attr(entity, "max_color_temp_kelvin")) ?? 6500;
    return { min: kelvinToMireds(maxK), max: kelvinToMireds(minK) };
}

const lightMapper: DeviceMapper = {
    id: "light",
    label: "Licht (automatisch: Ein/Aus, dimmbar, Farbtemperatur, Farbe)",
    domains: ["light"],
    auto: entity => entity.entity_id.startsWith("light."),
    signature(entity) {
        const c = lightCaps(entity);
        const m = lightMireds(entity);
        return sig("light", c.dim, c.ct, c.color, m.min, m.max);
    },
    create(entity, ctx) {
        setupLight(ctx);
        const caps = lightCaps(entity);
        const state = this.update(entity, ctx);
        const onOff = HaOnOffServer.with("Lighting");
        const level = HaLevelControlServer.with("Lighting", "OnOff");
        state.levelControl = { minLevel: 1, maxLevel: 254, onLevel: null, currentLevel: 254, ...state.levelControl };

        if (caps.color || caps.ct) {
            const mireds = lightMireds(entity);
            state.colorControl = {
                colorTempPhysicalMinMireds: mireds.min,
                colorTempPhysicalMaxMireds: mireds.max,
                coupleColorTempToLevelMinMireds: mireds.min,
                startUpColorTemperatureMireds: null,
                colorTemperatureMireds: clamp(
                    (state.colorControl?.colorTemperatureMireds as number | undefined) ?? 370,
                    mireds.min,
                    mireds.max,
                ),
                ...state.colorControl,
            };
            if (caps.color) {
                return {
                    type: ExtendedColorLightDevice.with(
                        onOff,
                        level,
                        HaColorControlServer.with("HueSaturation", "Xy", "ColorTemperature"),
                    ),
                    state,
                };
            }
            const cc = state.colorControl as Record<string, unknown>;
            delete cc.currentHue;
            delete cc.currentSaturation;
            delete cc.currentX;
            delete cc.currentY;
            return {
                type: ColorTemperatureLightDevice.with(onOff, level, HaColorControlServer.with("ColorTemperature")),
                state,
            };
        }
        if (caps.dim) return { type: DimmableLightDevice.with(onOff, level), state };
        delete state.levelControl;
        return { type: OnOffLightDevice.with(onOff), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        const on = entity.state === "on";
        const caps = lightCaps(entity);
        const patch: StatePatch = { onOff: { onOff: on } };
        const brightness = num(attr(entity, "brightness"));
        if (caps.dim) patch.levelControl = on && brightness !== undefined ? { currentLevel: brightnessToLevel(brightness) } : {};

        if ((caps.color || caps.ct) && on) {
            const cc: Record<string, unknown> = {};
            const mode = attr(entity, "color_mode");
            const kelvin = num(attr(entity, "color_temp_kelvin"));
            const mireds = lightMireds(entity);
            if (kelvin) cc.colorTemperatureMireds = clamp(kelvinToMireds(kelvin), mireds.min, mireds.max);
            if (caps.color) {
                const hs = attr(entity, "hs_color");
                if (Array.isArray(hs)) {
                    cc.currentHue = hueToMatter(Number(hs[0]));
                    cc.currentSaturation = satToMatter(Number(hs[1]));
                }
                const xy = attr(entity, "xy_color");
                if (Array.isArray(xy)) {
                    cc.currentX = xyToMatter(Number(xy[0]));
                    cc.currentY = xyToMatter(Number(xy[1]));
                }
            }
            if (mode === "color_temp" || !caps.color) {
                cc.colorMode = ColorControl.ColorMode.ColorTemperatureMireds;
                cc.enhancedColorMode = ColorControl.EnhancedColorMode.ColorTemperatureMireds;
            } else if (mode === "xy") {
                cc.colorMode = ColorControl.ColorMode.CurrentXAndCurrentY;
                cc.enhancedColorMode = ColorControl.EnhancedColorMode.CurrentXAndCurrentY;
            } else if (mode) {
                cc.colorMode = ColorControl.ColorMode.CurrentHueAndCurrentSaturation;
                cc.enhancedColorMode = ColorControl.EnhancedColorMode.CurrentHueAndCurrentSaturation;
            }
            patch.colorControl = cc;
        }
        return patch;
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Dimmable on/off devices (media player volume, number entities shown as dimmer)
// ---------------------------------------------------------------------------------------------------------------

const mediaPlayerMapper: DeviceMapper = {
    id: "speaker",
    label: "Lautsprecher (Ein/Aus + Lautstärke)",
    domains: ["media_player"],
    auto: entity => entity.entity_id.startsWith("media_player."),
    signature: () => "speaker",
    create(entity, ctx) {
        setupOnOff(ctx);
        const supported = features(entity);
        // Fall back to mute if the player cannot be switched off
        if (!(supported & 256) && supported & 8) {
            ctx.turnOn = () => ctx.call("volume_mute", { is_volume_muted: false });
            ctx.turnOff = () => ctx.call("volume_mute", { is_volume_muted: true });
        }
        ctx.setLevel = level => ctx.call("volume_set", { volume_level: levelToPercent(level) / 100 });
        const state = this.update(entity, ctx);
        state.levelControl = { minLevel: 1, maxLevel: 254, currentLevel: 127, ...state.levelControl };
        return { type: SpeakerDevice.with(HaOnOffServer, HaLevelControlServer.with("OnOff")), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        const supported = features(entity);
        const on =
            !(supported & 256) && supported & 8
                ? !attr(entity, "is_volume_muted")
                : !["off", "standby"].includes(entity.state);
        const volume = num(attr(entity, "volume_level"));
        return {
            onOff: { onOff: on },
            levelControl: volume !== undefined ? { currentLevel: percentToLevel(volume * 100) } : {},
        };
    },
};

const dimmableOutletMapper: DeviceMapper = {
    id: "dimmable_outlet",
    label: "Dimmbare Steckdose (Ein/Aus + Stufe)",
    domains: ["media_player", "fan", "cover", "valve", "light", "number", "input_number"],
    signature: () => "dimmable_outlet",
    create(entity, ctx) {
        setupOnOff(ctx);
        const d = ctx.domain;
        if (d === "number" || d === "input_number") {
            const min = num(attr(entity, "min")) ?? 0;
            const max = num(attr(entity, "max")) ?? 100;
            ctx.turnOn = () => ctx.call("set_value", { value: max });
            ctx.turnOff = () => ctx.call("set_value", { value: min });
            ctx.setLevel = level => {
                const step = num(attr(entity, "step")) ?? 1;
                const value = min + ((max - min) * (level - 1)) / 253;
                return ctx.call("set_value", { value: Math.round(value / step) * step });
            };
        } else if (d === "media_player") {
            ctx.setLevel = level => ctx.call("volume_set", { volume_level: levelToPercent(level) / 100 });
        } else if (d === "fan") {
            ctx.setLevel = level => ctx.call("set_percentage", { percentage: levelToPercent(level) });
        } else if (d === "cover") {
            ctx.setLevel = level => ctx.call("set_cover_position", { position: levelToPercent(level) });
        } else if (d === "valve") {
            ctx.setLevel = level => ctx.call("set_valve_position", { position: levelToPercent(level) });
        } else if (d === "light") {
            setupLight(ctx);
        }
        const state = this.update(entity, ctx);
        state.levelControl = { minLevel: 1, maxLevel: 254, currentLevel: 254, ...state.levelControl };
        return { type: DimmablePlugInUnitDevice.with(HaOnOffServer, HaLevelControlServer.with("OnOff")), state };
    },
    update(entity, ctx) {
        if (!available(entity)) return {};
        const d = ctx.domain;
        let percent: number | undefined;
        let on = onOffValue(entity, d);
        if (d === "number" || d === "input_number") {
            const min = num(attr(entity, "min")) ?? 0;
            const max = num(attr(entity, "max")) ?? 100;
            const value = num(entity.state) ?? min;
            percent = max > min ? ((value - min) / (max - min)) * 100 : 0;
            on = value > min;
        } else if (d === "media_player") percent = (num(attr(entity, "volume_level")) ?? 0) * 100;
        else if (d === "fan") percent = num(attr(entity, "percentage"));
        else if (d === "cover") percent = num(attr(entity, "current_position"));
        else if (d === "valve") percent = num(attr(entity, "current_position"));
        else if (d === "light") {
            const b = num(attr(entity, "brightness"));
            percent = b !== undefined ? (b / 255) * 100 : undefined;
        }
        return {
            onOff: { onOff: on },
            levelControl: percent !== undefined && percent > 0 ? { currentLevel: percentToLevel(percent) } : {},
        };
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Fans and air purifiers
// ---------------------------------------------------------------------------------------------------------------

function fanCaps(entity: HassEntity) {
    const supported = features(entity);
    const presets: string[] = attr(entity, "preset_modes") ?? [];
    const step = num(attr(entity, "percentage_step")) ?? 1;
    return {
        speed: (supported & 1) !== 0,
        oscillate: (supported & 2) !== 0,
        direction: (supported & 4) !== 0,
        auto: presets.some(p => ["auto", "smart", "natural"].includes(p.toLowerCase())),
        wind: presets.some(p => /sleep|natural/i.test(p)),
        speedMax: clamp(Math.round(100 / (step || 1)), 1, 100),
    };
}

function fanModeFor(entity: HassEntity, caps: ReturnType<typeof fanCaps>): FanControl.FanMode {
    if (entity.state === "off") return FanControl.FanMode.Off;
    const preset = String(attr(entity, "preset_mode") ?? "").toLowerCase();
    if (caps.auto && ["auto", "smart", "natural"].includes(preset)) return FanControl.FanMode.Auto;
    const percent = num(attr(entity, "percentage"));
    if (!caps.speed || percent === undefined) return FanControl.FanMode.High;
    if (percent <= 0) return FanControl.FanMode.Off;
    if (percent <= 33) return FanControl.FanMode.Low;
    if (percent <= 66) return FanControl.FanMode.Medium;
    return FanControl.FanMode.High;
}

function fanBehavior(caps: ReturnType<typeof fanCaps>) {
    const list: FanControl.Feature[] = [FanControl.Feature.Step];
    if (caps.speed) list.push(FanControl.Feature.MultiSpeed);
    if (caps.auto) list.push(FanControl.Feature.Auto);
    if (caps.oscillate) list.push(FanControl.Feature.Rocking);
    if (caps.direction) list.push(FanControl.Feature.AirflowDirection);
    if (caps.wind) list.push(FanControl.Feature.Wind);
    return HaFanControlServer.with(...list);
}

function fanMapper(id: string, label: string, airPurifier: boolean): DeviceMapper {
    return {
        id,
        label,
        domains: ["fan"],
        auto: entity => !airPurifier && entity.entity_id.startsWith("fan."),
        signature(entity) {
            const c = fanCaps(entity);
            return sig(id, c.speed, c.oscillate, c.direction, c.auto, c.wind, c.speedMax);
        },
        create(entity, ctx) {
            setupOnOff(ctx);
            const caps = fanCaps(entity);
            const state = this.update(entity, ctx);
            const fan: Record<string, unknown> = {
                fanModeSequence: caps.speed
                    ? caps.auto
                        ? FanControl.FanModeSequence.OffLowMedHighAuto
                        : FanControl.FanModeSequence.OffLowMedHigh
                    : caps.auto
                      ? FanControl.FanModeSequence.OffHighAuto
                      : FanControl.FanModeSequence.OffHigh,
                fanMode: FanControl.FanMode.Off,
                percentSetting: 0,
                percentCurrent: 0,
            };
            if (caps.speed) Object.assign(fan, { speedMax: caps.speedMax, speedSetting: 0, speedCurrent: 0 });
            if (caps.oscillate) Object.assign(fan, { rockSupport: { rockLeftRight: true }, rockSetting: {} });
            if (caps.direction) fan.airflowDirection = FanControl.AirflowDirection.Forward;
            if (caps.wind) Object.assign(fan, { windSupport: { sleepWind: true, naturalWind: true }, windSetting: {} });
            state.fanControl = { ...fan, ...state.fanControl };
            const behavior = fanBehavior(caps);
            const type = airPurifier
                ? AirPurifierDevice.with(behavior, HaOnOffServer)
                : FanDevice.with(behavior, HaOnOffServer);
            return { type, state };
        },
        update(entity) {
            if (!available(entity)) return {};
            const caps = fanCaps(entity);
            const on = entity.state === "on";
            const percent = on ? (caps.speed ? (num(attr(entity, "percentage")) ?? 100) : 100) : 0;
            const fan: Record<string, unknown> = {
                fanMode: fanModeFor(entity, caps),
                percentSetting: percent,
                percentCurrent: percent,
            };
            if (caps.speed) {
                const speed = clamp(Math.round((percent / 100) * caps.speedMax), 0, caps.speedMax);
                fan.speedSetting = speed;
                fan.speedCurrent = speed;
            }
            if (caps.oscillate) fan.rockSetting = attr(entity, "oscillating") ? { rockLeftRight: true } : {};
            if (caps.direction) {
                fan.airflowDirection =
                    attr(entity, "direction") === "reverse"
                        ? FanControl.AirflowDirection.Reverse
                        : FanControl.AirflowDirection.Forward;
            }
            if (caps.wind) {
                const preset = String(attr(entity, "preset_mode") ?? "").toLowerCase();
                fan.windSetting = preset.includes("sleep")
                    ? { sleepWind: true }
                    : preset.includes("natural")
                      ? { naturalWind: true }
                      : {};
            }
            return { fanControl: fan, onOff: { onOff: on } };
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------------------------------------------

function coverCaps(entity: HassEntity) {
    const f = features(entity);
    const tilt = (f & (16 | 32 | 128)) !== 0 || attr(entity, "current_tilt_position") !== undefined;
    return { tilt, lift: (f & (1 | 2 | 4)) !== 0 || !tilt };
}

function coverType(entity: HassEntity) {
    const T = WindowCovering.WindowCoveringType;
    switch (deviceClass(entity)) {
        case "awning":
            return T.Awning;
        case "curtain":
            return T.Drapery;
        case "shutter":
            return T.Shutter;
        case "blind":
            return coverCaps(entity).tilt ? T.TiltBlindLift : T.Rollershade;
        default:
            return T.Rollershade;
    }
}

const coverMapper: DeviceMapper = {
    id: "cover",
    label: "Rollladen / Jalousie / Tor (Position + Neigung)",
    domains: ["cover"],
    auto: entity => entity.entity_id.startsWith("cover."),
    signature(entity) {
        const c = coverCaps(entity);
        return sig("cover", c.lift, c.tilt, coverType(entity));
    },
    create(entity, ctx) {
        const caps = coverCaps(entity);
        const list: WindowCovering.Feature[] = [];
        if (caps.lift) list.push(WindowCovering.Feature.Lift, WindowCovering.Feature.PositionAwareLift);
        if (caps.tilt) list.push(WindowCovering.Feature.Tilt, WindowCovering.Feature.PositionAwareTilt);
        const state = this.update(entity, ctx);
        const wc: Record<string, unknown> = {
            type: coverType(entity),
            endProductType: WindowCovering.EndProductType.RollerShade,
            configStatus: {
                operational: true,
                onlineReserved: true,
                liftMovementReversed: false,
                liftPositionAware: caps.lift,
                tiltPositionAware: caps.tilt,
                liftEncoderControlled: caps.lift,
                tiltEncoderControlled: caps.tilt,
            },
        };
        if (caps.lift) {
            wc.currentPositionLiftPercent100ths = 0;
            wc.targetPositionLiftPercent100ths = 0;
        }
        if (caps.tilt) {
            wc.currentPositionTiltPercent100ths = 0;
            wc.targetPositionTiltPercent100ths = 0;
        }
        state.windowCovering = { ...wc, ...state.windowCovering };
        return { type: WindowCoveringDevice.with(HaWindowCoveringServer.with(...list)), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        const caps = coverCaps(entity);
        const wc: Record<string, unknown> = {};
        const st = entity.state;
        if (caps.lift) {
            let pos = num(attr(entity, "current_position"));
            if (pos === undefined) pos = st === "closed" ? 0 : st === "open" ? 100 : st === "closing" ? 50 : 50;
            const current = clamp(Math.round((100 - pos) * 100), 0, 10000);
            wc.currentPositionLiftPercent100ths = current;
            wc.targetPositionLiftPercent100ths = st === "opening" ? 0 : st === "closing" ? 10000 : current;
        }
        if (caps.tilt) {
            const tilt = num(attr(entity, "current_tilt_position"));
            if (tilt !== undefined) {
                const current = clamp(Math.round((100 - tilt) * 100), 0, 10000);
                wc.currentPositionTiltPercent100ths = current;
                wc.targetPositionTiltPercent100ths = current;
            }
        }
        return { windowCovering: wc };
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Locks
// ---------------------------------------------------------------------------------------------------------------

function lockState(state: string) {
    switch (state) {
        case "locked":
            return DoorLock.LockState.Locked;
        case "unlocked":
            return DoorLock.LockState.Unlocked;
        case "open":
            return DoorLock.LockState.Unlatched;
        default:
            return DoorLock.LockState.NotFullyLocked;
    }
}

const lockMapper: DeviceMapper = {
    id: "lock",
    label: "Türschloss (Sperren, Entsperren, Öffnen)",
    domains: ["lock"],
    auto: entity => entity.entity_id.startsWith("lock."),
    signature: entity => sig("lock", (features(entity) & 1) !== 0),
    create(entity, ctx) {
        const unbolt = (features(entity) & 1) !== 0;
        const state = this.update(entity, ctx);
        state.doorLock = {
            lockType: DoorLock.LockType.DeadBolt,
            actuatorEnabled: true,
            lockState: DoorLock.LockState.Locked,
            operatingMode: DoorLock.OperatingMode.Normal,
            ...state.doorLock,
        };
        const behavior = unbolt ? HaDoorLockServer.with("Unbolting") : HaDoorLockServer;
        return { type: DoorLockDevice.with(behavior), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        return { doorLock: { lockState: lockState(entity.state) } };
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Climate / thermostats / water heaters
// ---------------------------------------------------------------------------------------------------------------

function climateCaps(entity: HassEntity) {
    const domain = entity.entity_id.split(".")[0];
    if (domain === "water_heater") return { heat: true, cool: false, auto: false, fan: false, humidity: false };
    const modes: string[] = attr(entity, "hvac_modes") ?? [];
    const heat = modes.some(m => ["heat", "heat_cool", "auto"].includes(m));
    const cool = modes.some(m => ["cool", "heat_cool"].includes(m));
    return {
        heat: heat || !cool,
        cool,
        auto: (heat || !cool) && cool,
        fan: Array.isArray(attr(entity, "fan_modes")) && attr(entity, "fan_modes").length > 0,
        humidity: attr(entity, "current_humidity") !== undefined,
    };
}

function toMatterTemp(ctx: EntityContext, value: unknown) {
    const n = num(value);
    return n === undefined ? undefined : temperatureToMatter(n, ctx.ha.temperatureUnit);
}

function climateLimits(entity: HassEntity, ctx: EntityContext) {
    const min = toMatterTemp(ctx, attr(entity, "min_temp")) ?? 700;
    const max = toMatterTemp(ctx, attr(entity, "max_temp")) ?? 3500;
    return { min: Math.min(min, max), max: Math.max(min, max) };
}

function systemModeFor(entity: HassEntity, caps: ReturnType<typeof climateCaps>): Thermostat.SystemMode {
    const S = Thermostat.SystemMode;
    if (entity.entity_id.startsWith("water_heater.")) return entity.state === "off" ? S.Off : S.Heat;
    switch (entity.state) {
        case "off":
            return S.Off;
        case "heat":
            return S.Heat;
        case "cool":
            return S.Cool;
        case "heat_cool":
            return caps.auto ? S.Auto : caps.cool ? S.Cool : S.Heat;
        case "auto":
            return caps.auto ? S.Auto : caps.heat ? S.Heat : S.Cool;
        case "dry":
            return S.Dry;
        case "fan_only":
            return S.FanOnly;
        default:
            return caps.heat ? S.Heat : S.Cool;
    }
}

const climateMapper: DeviceMapper = {
    id: "thermostat",
    label: "Thermostat (Modi, Soll-/Ist-Temperatur, Lüfter, Luftfeuchte)",
    domains: ["climate", "water_heater"],
    auto: entity => entity.entity_id.startsWith("climate.") || entity.entity_id.startsWith("water_heater."),
    signature(entity) {
        const c = climateCaps(entity);
        return sig("thermostat", c.heat, c.cool, c.auto, c.fan, c.humidity, (attr(entity, "fan_modes") ?? []).join(","));
    },
    create(entity, ctx) {
        const caps = climateCaps(entity);
        const limits = climateLimits(entity, ctx);
        const list: Thermostat.Feature[] = [];
        if (caps.heat) list.push(Thermostat.Feature.Heating);
        if (caps.cool) list.push(Thermostat.Feature.Cooling);
        if (caps.auto) list.push(Thermostat.Feature.AutoMode);

        const state = this.update(entity, ctx);
        const th: Record<string, unknown> = {
            controlSequenceOfOperation:
                caps.heat && caps.cool
                    ? Thermostat.ControlSequenceOfOperation.CoolingAndHeating
                    : caps.cool
                      ? Thermostat.ControlSequenceOfOperation.CoolingOnly
                      : Thermostat.ControlSequenceOfOperation.HeatingOnly,
            externalMeasuredIndoorTemperature: null,
            systemMode: Thermostat.SystemMode.Off,
            thermostatRunningState: {},
        };
        if (caps.heat) {
            Object.assign(th, {
                absMinHeatSetpointLimit: limits.min,
                absMaxHeatSetpointLimit: limits.max,
                minHeatSetpointLimit: limits.min,
                maxHeatSetpointLimit: limits.max,
                occupiedHeatingSetpoint: clamp(2000, limits.min, limits.max),
            });
        }
        if (caps.cool) {
            Object.assign(th, {
                absMinCoolSetpointLimit: limits.min,
                absMaxCoolSetpointLimit: limits.max,
                minCoolSetpointLimit: limits.min,
                maxCoolSetpointLimit: limits.max,
                occupiedCoolingSetpoint: clamp(2400, limits.min, limits.max),
            });
        }
        if (caps.auto) th.minSetpointDeadBand = 0;
        state.thermostat = { ...th, ...state.thermostat };

        let type: EndpointType = ThermostatDevice.with(HaThermostatServer.with(...list));
        if (caps.fan) {
            const auto = (attr(entity, "fan_modes") as string[]).some(m => m.toLowerCase() === "auto");
            type = (type as typeof ThermostatDevice).with(
                HaFanControlServer.with(
                    ...(auto ? [FanControl.Feature.Auto, FanControl.Feature.Step] : [FanControl.Feature.Step]),
                ),
            );
            state.fanControl = {
                fanModeSequence: auto
                    ? FanControl.FanModeSequence.OffLowMedHighAuto
                    : FanControl.FanModeSequence.OffLowMedHigh,
                fanMode: FanControl.FanMode.Auto,
                percentSetting: 0,
                percentCurrent: 0,
                ...state.fanControl,
            };
        }
        if (caps.humidity) {
            type = (type as typeof ThermostatDevice).with(RelativeHumidityMeasurementServer);
            state.relativeHumidityMeasurement = {
                minMeasuredValue: 0,
                maxMeasuredValue: 10000,
                measuredValue: null,
                ...state.relativeHumidityMeasurement,
            };
        }
        return { type, state };
    },
    update(entity, ctx) {
        if (!available(entity)) return {};
        const caps = climateCaps(entity);
        const limits = climateLimits(entity, ctx);
        const th: Record<string, unknown> = {};
        const current = toMatterTemp(ctx, attr(entity, "current_temperature"));
        th.externalMeasuredIndoorTemperature = current ?? null;
        th.systemMode = systemModeFor(entity, caps);

        const low = toMatterTemp(ctx, attr(entity, "target_temp_low"));
        const high = toMatterTemp(ctx, attr(entity, "target_temp_high"));
        const target = toMatterTemp(ctx, attr(entity, "temperature"));
        const c = (v: number) => clamp(v, limits.min, limits.max);
        if (low !== undefined && high !== undefined) {
            if (caps.heat) th.occupiedHeatingSetpoint = c(low);
            if (caps.cool) th.occupiedCoolingSetpoint = c(high);
        } else if (target !== undefined) {
            if (caps.heat) th.occupiedHeatingSetpoint = c(target);
            if (caps.cool) th.occupiedCoolingSetpoint = c(target);
        }

        const action = attr(entity, "hvac_action");
        th.thermostatRunningState = {
            heat: action === "heating" || (ctx.domain === "water_heater" && entity.state !== "off"),
            cool: action === "cooling",
            fan: action === "fan",
        };

        const patch: StatePatch = { thermostat: th };
        if (caps.fan) {
            const modes: string[] = attr(entity, "fan_modes");
            const ordered = orderedClimateFanModes(modes);
            const mode = String(attr(entity, "fan_mode") ?? "");
            let fanMode = FanControl.FanMode.Auto;
            let percent = 0;
            if (mode.toLowerCase() === "off") fanMode = FanControl.FanMode.Off;
            else if (mode.toLowerCase() !== "auto") {
                const index = ordered.indexOf(mode);
                percent = index >= 0 ? Math.round(((index + 1) / ordered.length) * 100) : 100;
                fanMode =
                    percent <= 33
                        ? FanControl.FanMode.Low
                        : percent <= 66
                          ? FanControl.FanMode.Medium
                          : FanControl.FanMode.High;
            }
            patch.fanControl = { fanMode, percentSetting: percent, percentCurrent: percent };
        }
        if (caps.humidity) {
            const h = num(attr(entity, "current_humidity"));
            patch.relativeHumidityMeasurement = { measuredValue: h === undefined ? null : Math.round(h * 100) };
        }
        return patch;
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Valves
// ---------------------------------------------------------------------------------------------------------------

const valveMapper: DeviceMapper = {
    id: "valve",
    label: "Ventil (Öffnen/Schließen, Position)",
    domains: ["valve", "switch", "input_boolean"],
    auto: entity => entity.entity_id.startsWith("valve."),
    signature: entity => sig("valve", entity.entity_id.startsWith("valve.") && (features(entity) & 4) !== 0),
    create(entity, ctx) {
        const level = ctx.domain === "valve" && (features(entity) & 4) !== 0;
        const state = this.update(entity, ctx);
        const v: Record<string, unknown> = {
            openDuration: null,
            defaultOpenDuration: null,
            remainingDuration: null,
            currentState: ValveConfigurationAndControl.ValveState.Closed,
            targetState: ValveConfigurationAndControl.ValveState.Closed,
        };
        if (level) Object.assign(v, { currentLevel: 0, targetLevel: 0 });
        else delete (state.valveConfigurationAndControl ?? {}).currentLevel;
        state.valveConfigurationAndControl = { ...v, ...state.valveConfigurationAndControl };
        const behavior = level ? HaValveServer.with("Level") : HaValveServer;
        return { type: WaterValveDevice.with(behavior), state };
    },
    update(entity, ctx) {
        if (!available(entity)) return {};
        const VS = ValveConfigurationAndControl.ValveState;
        const st = entity.state;
        const open = st === "open" || st === "on";
        const currentState = st === "opening" || st === "closing" ? VS.Transitioning : open ? VS.Open : VS.Closed;
        const targetState = st === "opening" ? VS.Open : st === "closing" ? VS.Closed : open ? VS.Open : VS.Closed;
        const v: Record<string, unknown> = { currentState, targetState };
        const pos = num(attr(entity, "current_position"));
        if (ctx.domain === "valve" && (features(entity) & 4) !== 0 && pos !== undefined) {
            v.currentLevel = Math.round(pos);
            v.targetLevel = Math.round(pos);
        }
        return { valveConfigurationAndControl: v };
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Vacuum
// ---------------------------------------------------------------------------------------------------------------

function vacuumOperationalState(state: string) {
    const O = OperationalState.OperationalStateEnum;
    switch (state) {
        case "cleaning":
            return O.Running;
        case "paused":
            return O.Paused;
        case "error":
            return O.Error;
        case "returning":
            return 64; // SeekingCharger
        case "docked":
            return 66; // Docked
        default:
            return O.Stopped;
    }
}

function cleanModeTags(label: string) {
    const l = label.toLowerCase();
    const tags = [{ value: RvcCleanMode.ModeTag.Vacuum }];
    if (/quiet|silent/.test(l)) tags.push({ value: RvcCleanMode.ModeTag.Quiet });
    else if (/max|turbo|strong|high/.test(l)) tags.push({ value: RvcCleanMode.ModeTag.Max });
    else if (/min|low|gentle/.test(l)) tags.push({ value: RvcCleanMode.ModeTag.Min });
    else if (/auto|standard|balanced|normal/.test(l)) tags.push({ value: RvcCleanMode.ModeTag.Auto });
    else if (/deep/.test(l)) tags.push({ value: RvcCleanMode.ModeTag.DeepClean });
    return tags;
}

const vacuumMapper: DeviceMapper = {
    id: "vacuum",
    label: "Saugroboter (Start, Pause, Stopp, Basis, Saugstufen)",
    domains: ["vacuum"],
    auto: entity => entity.entity_id.startsWith("vacuum."),
    signature: entity => sig("vacuum", ((attr(entity, "fan_speed_list") as string[]) ?? []).join(",")),
    create(entity, ctx) {
        const speeds: string[] = attr(entity, "fan_speed_list") ?? [];
        const O = OperationalState.OperationalStateEnum;
        const state = this.update(entity, ctx);
        state.rvcRunMode = {
            supportedModes: [
                { label: "Idle", mode: RvcRunModes.Idle, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
                { label: "Cleaning", mode: RvcRunModes.Cleaning, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
            ],
            currentMode: RvcRunModes.Idle,
            ...state.rvcRunMode,
        };
        state.rvcOperationalState = {
            operationalStateList: [
                { operationalStateId: O.Stopped },
                { operationalStateId: O.Running },
                { operationalStateId: O.Paused },
                { operationalStateId: O.Error },
                { operationalStateId: 64 },
                { operationalStateId: 65 },
                { operationalStateId: 66 },
            ],
            phaseList: null,
            currentPhase: null,
            operationalError: { errorStateId: OperationalState.ErrorState.NoError },
            operationalState: O.Stopped,
            ...state.rvcOperationalState,
        };
        let type: EndpointType = RoboticVacuumCleanerDevice.with(
            HaRvcRunModeServer,
            HaRvcOperationalStateServer,
        );
        if (speeds.length) {
            type = (type as typeof RoboticVacuumCleanerDevice).with(HaRvcCleanModeServer);
            const current = speeds.indexOf(String(attr(entity, "fan_speed") ?? ""));
            state.rvcCleanMode = {
                supportedModes: speeds.map((label, i) => ({ label, mode: i, modeTags: cleanModeTags(label) })),
                currentMode: current >= 0 ? current : 0,
                ...state.rvcCleanMode,
            };
        }
        return { type, state };
    },
    update(entity) {
        if (!available(entity)) return {};
        const patch: StatePatch = {
            rvcRunMode: { currentMode: entity.state === "cleaning" ? RvcRunModes.Cleaning : RvcRunModes.Idle },
            rvcOperationalState: {
                operationalState: vacuumOperationalState(entity.state),
                operationalError: {
                    errorStateId:
                        entity.state === "error"
                            ? OperationalState.ErrorState.UnableToCompleteOperation
                            : OperationalState.ErrorState.NoError,
                },
            },
        };
        const speeds: string[] = attr(entity, "fan_speed_list") ?? [];
        const index = speeds.indexOf(String(attr(entity, "fan_speed") ?? ""));
        if (speeds.length && index >= 0) patch.rvcCleanMode = { currentMode: index };
        return patch;
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Selects (select, input_select, presets, sources, effects, alarm panel)
// ---------------------------------------------------------------------------------------------------------------

const ALARM_MODES: Array<[string, number, string]> = [
    // [state, supported feature bit, service]
    ["disarmed", 0, "alarm_disarm"],
    ["armed_home", 1, "alarm_arm_home"],
    ["armed_away", 2, "alarm_arm_away"],
    ["armed_night", 4, "alarm_arm_night"],
    ["armed_custom_bypass", 16, "alarm_arm_custom_bypass"],
    ["armed_vacation", 32, "alarm_arm_vacation"],
];

function selectOptions(entity: HassEntity): { options: string[]; current?: string } {
    const domain = entity.entity_id.split(".")[0];
    switch (domain) {
        case "select":
        case "input_select":
            return { options: attr(entity, "options") ?? [], current: entity.state };
        case "media_player":
            return { options: attr(entity, "source_list") ?? [], current: attr(entity, "source") };
        case "light":
            return { options: attr(entity, "effect_list") ?? [], current: attr(entity, "effect") };
        case "climate":
        case "fan":
            return { options: attr(entity, "preset_modes") ?? [], current: attr(entity, "preset_mode") };
        case "humidifier":
            return { options: attr(entity, "available_modes") ?? [], current: attr(entity, "mode") };
        case "water_heater":
            return { options: attr(entity, "operation_list") ?? [], current: attr(entity, "operation_mode") };
        case "vacuum":
            return { options: attr(entity, "fan_speed_list") ?? [], current: attr(entity, "fan_speed") };
        case "alarm_control_panel": {
            const f = features(entity);
            const options = ALARM_MODES.filter(([, bit]) => bit === 0 || f & bit).map(([s]) => s);
            return { options, current: entity.state };
        }
        default:
            return { options: [] };
    }
}

const modeSelectMapper: DeviceMapper = {
    id: "mode_select",
    label: "Auswahl / Modus (Optionen, Presets, Quellen, Effekte, Alarmanlage)",
    domains: ["select", "input_select", "media_player", "light", "climate", "fan", "humidifier", "water_heater", "vacuum", "alarm_control_panel"],
    auto: entity => /^(input_)?select\.|^alarm_control_panel\./.test(entity.entity_id),
    signature: entity => sig("mode_select", selectOptions(entity).options.join("\u0001")),
    create(entity, ctx) {
        const { options } = selectOptions(entity);
        const state = this.update(entity, ctx);
        state.modeSelect = {
            description: "Mode",
            standardNamespace: null,
            supportedModes: options.slice(0, 255).map((label, mode) => ({
                label: label.slice(0, 64),
                mode,
                semanticTags: [],
            })),
            currentMode: 0,
            ...state.modeSelect,
        };
        return { type: ModeSelectDevice.with(HaModeSelectServer), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        const { options, current } = selectOptions(entity);
        const index = current === undefined ? -1 : options.indexOf(current);
        return index >= 0 ? { modeSelect: { currentMode: index } } : {};
    },
};

// ---------------------------------------------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------------------------------------------

function sensorMapper(
    id: string,
    label: string,
    deviceClasses: string[],
    type: EndpointType,
    behaviorId: string,
    init: Record<string, unknown>,
    value: (entity: HassEntity, ctx: EntityContext) => number | null,
): DeviceMapper {
    return {
        id,
        label,
        domains: ["sensor", "number", "input_number", "climate", "weather"],
        auto: entity => entity.entity_id.startsWith("sensor.") && deviceClasses.includes(deviceClass(entity)),
        signature: () => id,
        create(entity, ctx) {
            const state = this.update(entity, ctx);
            state[behaviorId] = { ...init, measuredValue: null, ...state[behaviorId] };
            return { type, state };
        },
        update(entity, ctx) {
            if (!available(entity)) return {};
            return { [behaviorId]: { measuredValue: value(entity, ctx) } };
        },
    };
}

function sensorValue(entity: HassEntity) {
    const d = entity.entity_id.split(".")[0];
    if (d === "climate") return num(attr(entity, "current_temperature"));
    if (d === "weather") return num(attr(entity, "temperature"));
    return num(entity.state);
}

const unitOf = (entity: HassEntity) => attr(entity, "unit_of_measurement") as string | undefined;

const temperatureMapper = sensorMapper(
    "temperature_sensor",
    "Temperatursensor",
    ["temperature"],
    TemperatureSensorDevice,
    "temperatureMeasurement",
    { minMeasuredValue: -5000, maxMeasuredValue: 12500 },
    (entity, ctx) => {
        const v = sensorValue(entity);
        const unit = entity.entity_id.startsWith("sensor.") ? unitOf(entity) : ctx.ha.temperatureUnit;
        return v === undefined ? null : clamp(temperatureToMatter(v, unit), -27315, 32767);
    },
);

const humidityMapper = sensorMapper(
    "humidity_sensor",
    "Luftfeuchtigkeitssensor",
    ["humidity", "moisture"],
    HumiditySensorDevice,
    "relativeHumidityMeasurement",
    { minMeasuredValue: 0, maxMeasuredValue: 10000 },
    entity => {
        const d = entity.entity_id.split(".")[0];
        const v = d === "climate" ? num(attr(entity, "current_humidity")) : d === "weather" ? num(attr(entity, "humidity")) : num(entity.state);
        return v === undefined ? null : clamp(Math.round(v * 100), 0, 10000);
    },
);

const illuminanceMapper = sensorMapper(
    "light_sensor",
    "Helligkeitssensor",
    ["illuminance"],
    LightSensorDevice,
    "illuminanceMeasurement",
    { minMeasuredValue: 1, maxMeasuredValue: 0xfffe },
    entity => {
        const v = num(entity.state);
        return v === undefined ? null : luxToMatter(v);
    },
);

const pressureMapper = sensorMapper(
    "pressure_sensor",
    "Luftdrucksensor",
    ["pressure", "atmospheric_pressure"],
    PressureSensorDevice,
    "pressureMeasurement",
    { minMeasuredValue: 0, maxMeasuredValue: 32767 },
    entity => {
        const d = entity.entity_id.split(".")[0];
        const v = d === "weather" ? num(attr(entity, "pressure")) : num(entity.state);
        const unit = d === "weather" ? attr(entity, "pressure_unit") : unitOf(entity);
        return v === undefined ? null : clamp(pressureToMatter(v, unit), -32767, 32767);
    },
);

const flowMapper = sensorMapper(
    "flow_sensor",
    "Durchflusssensor",
    ["volume_flow_rate"],
    FlowSensorDevice,
    "flowMeasurement",
    { minMeasuredValue: 0, maxMeasuredValue: 0xfffe },
    entity => {
        const v = num(entity.state);
        return v === undefined ? null : flowToMatter(v, unitOf(entity));
    },
);

// Air quality ----------------------------------------------------------------------------------------------------

type AqLevels = [number, number, number, number, number]; // upper bounds for good, fair, moderate, poor, very poor

interface AirQualityKind {
    behavior: any;
    behaviorId: string;
    unit: ConcentrationMeasurement.MeasurementUnit;
    levels: AqLevels;
    /** Factor to convert the HA value into the Matter unit */
    convert?: (value: number, unit: string | undefined) => number;
}

const MU = ConcentrationMeasurement.MeasurementUnit;
const AIR_QUALITY_KINDS: Record<string, AirQualityKind> = {
    carbon_dioxide: {
        behavior: CarbonDioxideConcentrationMeasurementServer,
        behaviorId: "carbonDioxideConcentrationMeasurement",
        unit: MU.Ppm,
        levels: [750, 1000, 1500, 2000, 5000],
    },
    carbon_monoxide: {
        behavior: CarbonMonoxideConcentrationMeasurementServer,
        behaviorId: "carbonMonoxideConcentrationMeasurement",
        unit: MU.Ppm,
        levels: [4, 9, 15, 30, 50],
    },
    pm25: {
        behavior: Pm25ConcentrationMeasurementServer,
        behaviorId: "pm25ConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [10, 20, 25, 50, 75],
    },
    pm10: {
        behavior: Pm10ConcentrationMeasurementServer,
        behaviorId: "pm10ConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [20, 40, 50, 100, 150],
    },
    pm1: {
        behavior: Pm1ConcentrationMeasurementServer,
        behaviorId: "pm1ConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [10, 20, 25, 50, 75],
    },
    volatile_organic_compounds: {
        behavior: TotalVolatileOrganicCompoundsConcentrationMeasurementServer,
        behaviorId: "totalVolatileOrganicCompoundsConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [300, 500, 1000, 3000, 10000],
    },
    volatile_organic_compounds_parts: {
        behavior: TotalVolatileOrganicCompoundsConcentrationMeasurementServer,
        behaviorId: "totalVolatileOrganicCompoundsConcentrationMeasurement",
        unit: MU.Ppb,
        levels: [65, 220, 660, 2200, 5500],
    },
    nitrogen_dioxide: {
        behavior: NitrogenDioxideConcentrationMeasurementServer,
        behaviorId: "nitrogenDioxideConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [40, 90, 120, 230, 340],
    },
    ozone: {
        behavior: OzoneConcentrationMeasurementServer,
        behaviorId: "ozoneConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [50, 100, 130, 240, 380],
    },
    formaldehyde: {
        behavior: FormaldehydeConcentrationMeasurementServer,
        behaviorId: "formaldehydeConcentrationMeasurement",
        unit: MU.Ugm3,
        levels: [30, 60, 100, 200, 500],
    },
    radon: {
        behavior: RadonConcentrationMeasurementServer,
        behaviorId: "radonConcentrationMeasurement",
        unit: MU.Bqm3,
        levels: [50, 100, 150, 300, 600],
    },
};

function airQualityLevel(value: number | undefined, levels: AqLevels) {
    const A = AirQuality.AirQualityEnum;
    if (value === undefined) return A.Unknown;
    if (value <= levels[0]) return A.Good;
    if (value <= levels[1]) return A.Fair;
    if (value <= levels[2]) return A.Moderate;
    if (value <= levels[3]) return A.Poor;
    if (value <= levels[4]) return A.VeryPoor;
    return A.ExtremelyPoor;
}

const AirQualityFull = AirQualityServer.with("Fair", "Moderate", "VeryPoor", "ExtremelyPoor");

const airQualityMapper: DeviceMapper = {
    id: "air_quality_sensor",
    label: "Luftqualitätssensor (CO₂, Feinstaub, VOC, AQI, ...)",
    domains: ["sensor"],
    auto: entity =>
        entity.entity_id.startsWith("sensor.") &&
        (deviceClass(entity) === "aqi" || deviceClass(entity) in AIR_QUALITY_KINDS),
    signature: entity => sig("aq", deviceClass(entity)),
    create(entity, ctx) {
        const dc = deviceClass(entity);
        const kind = AIR_QUALITY_KINDS[dc];
        const state = this.update(entity, ctx);
        state.airQuality = { airQuality: AirQuality.AirQualityEnum.Unknown, ...state.airQuality };
        if (!kind) return { type: AirQualitySensorDevice.with(AirQualityFull), state };
        state[kind.behaviorId] = {
            measurementMedium: ConcentrationMeasurement.MeasurementMedium.Air,
            measurementUnit: kind.unit,
            minMeasuredValue: 0,
            maxMeasuredValue: null,
            measuredValue: null,
            ...state[kind.behaviorId],
        };
        return {
            type: AirQualitySensorDevice.with(AirQualityFull, kind.behavior.with("NumericMeasurement")),
            state,
        };
    },
    update(entity) {
        if (!available(entity)) return {};
        const dc = deviceClass(entity);
        const value = num(entity.state);
        if (dc === "aqi") {
            return { airQuality: { airQuality: airQualityLevel(value, [50, 100, 150, 200, 300]) } };
        }
        const kind = AIR_QUALITY_KINDS[dc];
        if (!kind) return {};
        return {
            airQuality: { airQuality: airQualityLevel(value, kind.levels) },
            [kind.behaviorId]: { measuredValue: value ?? null },
        };
    },
};

// Binary sensors ---------------------------------------------------------------------------------------------------

const CONTACT_CLASSES = ["door", "window", "garage_door", "opening", "lock", "tamper", "vibration", "plug", "power"];
const OCCUPANCY_CLASSES = ["motion", "occupancy", "presence", "moving", "sound"];

function binaryOn(entity: HassEntity) {
    const d = entity.entity_id.split(".")[0];
    if (d === "device_tracker" || d === "person") return entity.state === "home";
    if (d === "lock") return entity.state !== "locked";
    if (d === "cover" || d === "valve") return entity.state !== "closed";
    return isOn(entity.state);
}

const BINARY_DOMAINS = ["binary_sensor", "input_boolean", "switch", "device_tracker", "person", "lock", "cover", "valve"];

function booleanMapper(
    id: string,
    label: string,
    type: EndpointType,
    auto: (entity: HassEntity) => boolean,
    invert: boolean,
): DeviceMapper {
    return {
        id,
        label,
        domains: BINARY_DOMAINS,
        auto,
        signature: () => id,
        create(entity, ctx) {
            const state = this.update(entity, ctx);
            state.booleanState = { stateValue: invert, ...state.booleanState };
            return { type, state };
        },
        update(entity) {
            if (!available(entity)) return {};
            const on = binaryOn(entity);
            return { booleanState: { stateValue: invert ? !on : on } };
        },
    };
}

const isBinary = (entity: HassEntity) => entity.entity_id.startsWith("binary_sensor.");

const contactMapper = booleanMapper(
    "contact_sensor",
    "Kontaktsensor (Tür/Fenster)",
    ContactSensorDevice.with(BooleanStateServer),
    entity =>
        isBinary(entity) &&
        (CONTACT_CLASSES.includes(deviceClass(entity)) ||
            ![
                ...OCCUPANCY_CLASSES,
                "moisture",
                "smoke",
                "gas",
                "carbon_monoxide",
                "cold",
                "heat",
                "safety",
                "problem",
            ].includes(deviceClass(entity))),
    true,
);

const leakMapper = booleanMapper(
    "water_leak_detector",
    "Wasserleck-Sensor",
    WaterLeakDetectorDevice.with(BooleanStateServer),
    entity => isBinary(entity) && deviceClass(entity) === "moisture",
    false,
);

const freezeMapper = booleanMapper(
    "water_freeze_detector",
    "Frost-Sensor",
    WaterFreezeDetectorDevice.with(BooleanStateServer),
    entity => isBinary(entity) && deviceClass(entity) === "cold",
    false,
);

const rainMapper = booleanMapper(
    "rain_sensor",
    "Regensensor",
    RainSensorDevice.with(BooleanStateServer),
    () => false,
    false,
);

const occupancyMapper: DeviceMapper = {
    id: "occupancy_sensor",
    label: "Bewegungs-/Präsenzmelder",
    domains: BINARY_DOMAINS,
    auto: entity =>
        (isBinary(entity) && OCCUPANCY_CLASSES.includes(deviceClass(entity))) ||
        entity.entity_id.startsWith("person.") ||
        entity.entity_id.startsWith("device_tracker."),
    signature: () => "occupancy",
    create(entity, ctx) {
        const state = this.update(entity, ctx);
        state.occupancySensing = {
            occupancySensorType: 0,
            occupancySensorTypeBitmap: { pir: true },
            occupancy: { occupied: false },
            ...state.occupancySensing,
        };
        return { type: OccupancySensorDevice.with(OccupancySensingServer.with("PassiveInfrared")), state };
    },
    update(entity) {
        if (!available(entity)) return {};
        return { occupancySensing: { occupancy: { occupied: binaryOn(entity) } } };
    },
};

function smokeCoMapper(id: string, label: string, classes: string[], co: boolean): DeviceMapper {
    return {
        id,
        label,
        domains: ["binary_sensor"],
        auto: entity => isBinary(entity) && classes.includes(deviceClass(entity)),
        signature: () => id,
        create(entity, ctx) {
            const state = this.update(entity, ctx);
            state.smokeCoAlarm = {
                expressedState: SmokeCoAlarm.ExpressedState.Normal,
                batteryAlert: SmokeCoAlarm.AlarmState.Normal,
                testInProgress: false,
                hardwareFaultAlert: false,
                endOfServiceAlert: SmokeCoAlarm.EndOfService.Normal,
                ...(co
                    ? { coState: SmokeCoAlarm.AlarmState.Normal }
                    : { smokeState: SmokeCoAlarm.AlarmState.Normal }),
                ...state.smokeCoAlarm,
            };
            return {
                type: SmokeCoAlarmDevice.with(SmokeCoAlarmServer.with(co ? "CoAlarm" : "SmokeAlarm")),
                state,
            };
        },
        update(entity) {
            if (!available(entity)) return {};
            const on = isOn(entity.state);
            const alarm = on ? SmokeCoAlarm.AlarmState.Critical : SmokeCoAlarm.AlarmState.Normal;
            const expressed = on
                ? co
                    ? SmokeCoAlarm.ExpressedState.CoAlarm
                    : SmokeCoAlarm.ExpressedState.SmokeAlarm
                : SmokeCoAlarm.ExpressedState.Normal;
            return { smokeCoAlarm: co ? { coState: alarm, expressedState: expressed } : { smokeState: alarm, expressedState: expressed } };
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------------------------------------------

export const MAPPERS: DeviceMapper[] = [
    lightMapper,
    coverMapper,
    lockMapper,
    climateMapper,
    fanMapper("fan", "Ventilator (Stufen, Oszillation, Richtung, Auto)", false),
    fanMapper("air_purifier", "Luftreiniger (Stufen, Auto)", true),
    vacuumMapper,
    valveMapper,
    mediaPlayerMapper,
    modeSelectMapper,
    airQualityMapper,
    temperatureMapper,
    humidityMapper,
    illuminanceMapper,
    pressureMapper,
    flowMapper,
    occupancyMapper,
    leakMapper,
    freezeMapper,
    smokeCoMapper("smoke_alarm", "Rauchmelder", ["smoke"], false),
    smokeCoMapper("co_alarm", "CO-/Gasmelder", ["carbon_monoxide", "gas"], true),
    contactMapper,
    rainMapper,
    onOffMapper("outlet", "Steckdose / Schalter (Ein/Aus)", OutletType, [
        "switch",
        "input_boolean",
        "automation",
        "script",
        "scene",
        "button",
        "input_button",
        "siren",
        "humidifier",
        "group",
        "remote",
    ]),
    onOffMapper("onoff_light", "Licht (nur Ein/Aus)", OnOffLightType, []),
    dimmableOutletMapper,
];

export const mapperById = new Map(MAPPERS.map(m => [m.id, m]));

/** Selects the mapper for an entity: explicit override first, then the automatic choice */
export function selectMapper(entity: HassEntity, override?: string): DeviceMapper | undefined {
    if (override) {
        const mapper = mapperById.get(override);
        if (mapper) return mapper;
    }
    return MAPPERS.find(m => m.auto?.(entity));
}

/** Mappers that can be chosen for an entity's domain */
export function mappersForDomain(domain: string) {
    return MAPPERS.filter(m => m.domains.includes(domain));
}
