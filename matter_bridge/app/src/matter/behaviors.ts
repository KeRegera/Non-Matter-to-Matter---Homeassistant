/**
 * Matter cluster servers that forward Matter commands and attribute writes to Home Assistant.
 *
 * Home Assistant is the source of truth: state updates coming from Home Assistant are written to the endpoints
 * with an "offline" (local) context; everything a Matter controller changes arrives with a remote context and is
 * translated into Home Assistant service calls here.
 */
import { MaybePromise } from "@matter/main";
import {
    ColorControlServer,
    DoorLockServer,
    FanControlServer,
    LevelControlServer,
    ModeSelectServer,
    OnOffServer,
    RvcCleanModeServer,
    RvcOperationalStateServer,
    RvcRunModeServer,
    ThermostatServer,
    ValveConfigurationAndControlServer,
    WindowCoveringServer,
} from "@matter/main/behaviors";
import {
    ColorControl,
    DoorLock,
    FanControl,
    LevelControl,
    ModeBase,
    ModeSelect,
    OperationalState,
    Thermostat,
    ValveConfigurationAndControl,
} from "@matter/main/clusters";
import { log } from "../log.js";
import { contextOf, type EntityContext } from "./context.js";
import {
    clamp,
    hueFromMatter,
    enhancedHueFromMatter,
    miredsToKelvin,
    satFromMatter,
    transitionSeconds,
    xyFromMatter,
    fromCelsius,
} from "./convert.js";

type ActionContextLike = { offline?: boolean } | undefined;
const isRemote = (context: ActionContextLike) => context !== undefined && context.offline !== true;

/** Runs a Home Assistant call detached from the Matter transaction and logs errors */
function detached(promise: Promise<unknown>, what: string) {
    promise.catch(e => log.error(`Home Assistant call failed (${what}): ${e instanceof Error ? e.message : e}`));
}

// ---------------------------------------------------------------------------------------------------------------
// On/Off
// ---------------------------------------------------------------------------------------------------------------

export class HaOnOffServer extends OnOffServer {
    override async on() {
        const ctx = contextOf(this.endpoint);
        await (ctx.turnOn ? ctx.turnOn() : ctx.call("turn_on", {}, "homeassistant"));
        await super.on();
        if (ctx.momentary) this.#scheduleReset();
    }

    override async off() {
        const ctx = contextOf(this.endpoint);
        if (ctx.momentary) {
            this.state.onOff = false;
            return;
        }
        await (ctx.turnOff ? ctx.turnOff() : ctx.call("turn_off", {}, "homeassistant"));
        await super.off();
    }

    override async toggle() {
        if (this.state.onOff) await this.off();
        else await this.on();
    }

    #scheduleReset() {
        const endpoint = this.endpoint;
        setTimeout(() => {
            endpoint.set({ onOff: { onOff: false } } as any).catch(() => undefined);
        }, 1500);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Level control (brightness, volume, fan speed, positions...)
// ---------------------------------------------------------------------------------------------------------------

export class HaLevelControlServer extends LevelControlServer {
    override async moveToLevelLogic(
        level: number,
        transitionTime: number | null,
        withOnOff: boolean,
        _options?: LevelControl.Options,
    ) {
        const ctx = contextOf(this.endpoint);
        level = clamp(level, this.minLevel, this.maxLevel);
        if (withOnOff && level <= this.minLevel && ctx.turnOff) {
            await ctx.turnOff();
        } else if (ctx.setLevel) {
            await ctx.setLevel(level, transitionTime);
        }
        this.state.currentLevel = level;
    }

    override async moveLogic(
        moveMode: LevelControl.MoveMode,
        rate: number | null,
        withOnOff: boolean,
        options?: LevelControl.Options,
    ) {
        const target = moveMode === LevelControl.MoveMode.Up ? this.maxLevel : this.minLevel;
        const effectiveRate = rate ?? this.state.defaultMoveRate ?? 50;
        const distance = Math.abs(target - (this.state.currentLevel ?? this.minLevel));
        const transition = effectiveRate > 0 ? Math.round((distance / effectiveRate) * 10) : null;
        await this.moveToLevelLogic(target, transition, withOnOff, options);
    }

    override async stepLogic(
        stepMode: LevelControl.StepMode,
        stepSize: number,
        transitionTime: number | null,
        withOnOff: boolean,
        options?: LevelControl.Options,
    ) {
        const current = this.state.currentLevel ?? this.minLevel;
        const target = stepMode === LevelControl.StepMode.Up ? current + stepSize : current - stepSize;
        await this.moveToLevelLogic(clamp(target, this.minLevel, this.maxLevel), transitionTime, withOnOff, options);
    }

    override stopLogic() {
        // Home Assistant cannot stop a running transition - nothing to do
    }

    override handleOnOffChange(_onOff: boolean) {
        // Home Assistant handles the coupling of on/off and level itself
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Color control (lights)
// ---------------------------------------------------------------------------------------------------------------

export class HaColorControlServer extends ColorControlServer {
    /** Feature dependent attributes are not part of the generic typing */
    get #s(): any {
        return this.state;
    }

    #ctx(): EntityContext {
        return contextOf(this.endpoint);
    }

    async #turnOn(data: Record<string, unknown>, transitionTime: number) {
        const transition = transitionSeconds(transitionTime);
        await this.#ctx().call("turn_on", { ...data, ...(transition ? { transition } : {}) }, "light");
    }

    override async moveToHueLogic(
        targetHue: number,
        _direction: ColorControl.Direction,
        transitionTime: number,
        isEnhancedHue = false,
    ) {
        const hue = isEnhancedHue ? enhancedHueFromMatter(targetHue) : hueFromMatter(targetHue);
        const sat = satFromMatter(this.#s.currentSaturation ?? 254);
        await this.#turnOn({ hs_color: [hue, sat] }, transitionTime);
        if (isEnhancedHue) this.#s.enhancedCurrentHue = targetHue;
        else this.#s.currentHue = targetHue;
    }

    override async moveToSaturationLogic(targetSaturation: number, transitionTime: number) {
        const hue = hueFromMatter(this.#s.currentHue ?? 0);
        await this.#turnOn({ hs_color: [hue, satFromMatter(targetSaturation)] }, transitionTime);
        this.#s.currentSaturation = targetSaturation;
    }

    override async moveToHueAndSaturationLogic(
        targetHue: number,
        targetSaturation: number,
        transitionTime: number,
    ) {
        await this.#turnOn(
            { hs_color: [hueFromMatter(targetHue), satFromMatter(targetSaturation)] },
            transitionTime,
        );
        this.#s.currentHue = targetHue;
        this.#s.currentSaturation = targetSaturation;
    }

    override async moveToEnhancedHueAndSaturationLogic(
        targetEnhancedHue: number,
        targetSaturation: number,
        transitionTime: number,
    ) {
        await this.#turnOn(
            { hs_color: [enhancedHueFromMatter(targetEnhancedHue), satFromMatter(targetSaturation)] },
            transitionTime,
        );
        this.#s.enhancedCurrentHue = targetEnhancedHue;
        this.#s.currentSaturation = targetSaturation;
    }

    override async moveToColorLogic(targetX: number, targetY: number, transitionTime: number) {
        await this.#turnOn({ xy_color: [xyFromMatter(targetX), xyFromMatter(targetY)] }, transitionTime);
        this.#s.currentX = targetX;
        this.#s.currentY = targetY;
    }

    override async moveToColorTemperatureLogic(targetMireds: number, transitionTime: number) {
        const min = this.#s.colorTempPhysicalMinMireds ?? 153;
        const max = this.#s.colorTempPhysicalMaxMireds ?? 500;
        const mireds = clamp(targetMireds, min, max);
        await this.#turnOn({ color_temp_kelvin: miredsToKelvin(mireds) }, transitionTime);
        this.#s.colorTemperatureMireds = mireds;
    }

    override async stepHueLogic(
        stepMode: ColorControl.StepMode,
        stepSize: number,
        transitionTime: number,
        isEnhancedHue = false,
    ) {
        const max = isEnhancedHue ? 65535 : 254;
        const current = (isEnhancedHue ? this.#s.enhancedCurrentHue : this.#s.currentHue) ?? 0;
        let target = stepMode === ColorControl.StepMode.Up ? current + stepSize : current - stepSize;
        target = ((target % (max + 1)) + max + 1) % (max + 1);
        await this.moveToHueLogic(target, ColorControl.Direction.Shortest, transitionTime, isEnhancedHue);
    }

    override async stepSaturationLogic(
        stepMode: ColorControl.StepMode,
        stepSize: number,
        transitionTime: number,
    ) {
        const current = this.#s.currentSaturation ?? 0;
        const target = clamp(stepMode === ColorControl.StepMode.Up ? current + stepSize : current - stepSize, 0, 254);
        await this.moveToSaturationLogic(target, transitionTime);
    }

    override async stepColorLogic(stepX: number, stepY: number, transitionTime: number) {
        const x = clamp((this.#s.currentX ?? 0) + stepX, 0, 65279);
        const y = clamp((this.#s.currentY ?? 0) + stepY, 0, 65279);
        await this.moveToColorLogic(x, y, transitionTime);
    }

    override async stepColorTemperatureLogic(
        stepMode: ColorControl.StepMode,
        stepSize: number,
        transitionTime: number,
        colorTemperatureMinimumMireds: number,
        colorTemperatureMaximumMireds: number,
    ) {
        const current = this.#s.colorTemperatureMireds ?? 250;
        const min = Math.max(colorTemperatureMinimumMireds || 0, this.#s.colorTempPhysicalMinMireds ?? 153);
        const max = Math.min(colorTemperatureMaximumMireds || 0xfeff, this.#s.colorTempPhysicalMaxMireds ?? 500);
        const target = clamp(stepMode === ColorControl.StepMode.Up ? current + stepSize : current - stepSize, min, max);
        await this.moveToColorTemperatureLogic(target, transitionTime);
    }

    override async moveColorTemperatureLogic(
        moveMode: ColorControl.MoveMode,
        rate: number,
        colorTemperatureMinimumMireds: number,
        colorTemperatureMaximumMireds: number,
    ) {
        if (moveMode === ColorControl.MoveMode.Stop) return;
        const min = Math.max(colorTemperatureMinimumMireds || 0, this.#s.colorTempPhysicalMinMireds ?? 153);
        const max = Math.min(colorTemperatureMaximumMireds || 0xfeff, this.#s.colorTempPhysicalMaxMireds ?? 500);
        const target = moveMode === ColorControl.MoveMode.Up ? max : min;
        const distance = Math.abs(target - (this.#s.colorTemperatureMireds ?? 250));
        await this.moveToColorTemperatureLogic(target, rate > 0 ? Math.round((distance / rate) * 10) : 0);
    }

    override async moveHueLogic(moveMode: ColorControl.MoveMode, rate: number, isEnhancedHue = false) {
        if (moveMode === ColorControl.MoveMode.Stop) return;
        // Approximation: jump 1/6 of the color circle in the requested direction
        const step = Math.round((isEnhancedHue ? 65535 : 254) / 6);
        await this.stepHueLogic(
            moveMode === ColorControl.MoveMode.Up ? ColorControl.StepMode.Up : ColorControl.StepMode.Down,
            step,
            Math.round((step / Math.max(rate, 1)) * 10),
            isEnhancedHue,
        );
    }

    override async moveSaturationLogic(moveMode: ColorControl.MoveMode, rate: number) {
        if (moveMode === ColorControl.MoveMode.Stop) return;
        const target = moveMode === ColorControl.MoveMode.Up ? 254 : 0;
        const distance = Math.abs(target - (this.#s.currentSaturation ?? 0));
        await this.moveToSaturationLogic(target, Math.round((distance / Math.max(rate, 1)) * 10));
    }

    override moveColorLogic(_rateX: number, _rateY: number) {
        // Continuous xy movement is not supported by Home Assistant
    }

    override stopHueAndSaturationMovement() {}
    override stopAllColorMovement() {}
    override stopMoveStepLogic() {}

    override async startColorLoopLogic(_startHue: number) {
        const effects: string[] = this.#ctx().attributes.effect_list ?? [];
        const effect = effects.find(e => e.toLowerCase().replace(/[^a-z]/g, "") === "colorloop");
        if (effect) await this.#turnOn({ effect }, 0);
    }

    override async stopColorLoopLogic() {
        const effects: string[] = this.#ctx().attributes.effect_list ?? [];
        const none = effects.find(e => ["none", "off", "stop"].includes(e.toLowerCase()));
        if (none) await this.#turnOn({ effect: none }, 0);
    }

    override syncColorTemperatureWithLevelLogic(_level: number) {}
}

// ---------------------------------------------------------------------------------------------------------------
// Window covering
// ---------------------------------------------------------------------------------------------------------------

// Values of the matter.js MovementType / MovementDirection enums
const MovementTypeTilt = 1;
const MovementDirectionClose = 1;

export class HaWindowCoveringServer extends WindowCoveringServer {
    override async handleMovement(
        type: number,
        _reversed: boolean,
        direction: number,
        targetPercent100ths?: number,
    ) {
        const ctx = contextOf(this.endpoint);
        const tilt = type === MovementTypeTilt;
        const supported = Number(ctx.attributes.supported_features ?? 0);
        const canSetPosition = tilt ? (supported & 128) !== 0 : (supported & 4) !== 0;

        if (targetPercent100ths !== undefined && canSetPosition) {
            // Matter: 0 = fully open, 10000 = fully closed; HA: 100 = open, 0 = closed
            const position = clamp(Math.round(100 - targetPercent100ths / 100), 0, 100);
            if (tilt) await ctx.call("set_cover_tilt_position", { tilt_position: position });
            else await ctx.call("set_cover_position", { position });
            return;
        }

        let open: boolean;
        if (targetPercent100ths !== undefined) open = targetPercent100ths < 5000;
        else open = direction !== MovementDirectionClose;

        if (tilt) await ctx.call(open ? "open_cover_tilt" : "close_cover_tilt");
        else await ctx.call(open ? "open_cover" : "close_cover");
    }

    override async handleStopMovement() {
        const ctx = contextOf(this.endpoint);
        const supported = Number(ctx.attributes.supported_features ?? 0);
        if (supported & 8) await ctx.call("stop_cover");
        if (supported & 64) await ctx.call("stop_cover_tilt");
        await super.handleStopMovement();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Door lock
// ---------------------------------------------------------------------------------------------------------------

function pinOf(request: { pinCode?: unknown }) {
    if (!request.pinCode) return undefined;
    const pin = Buffer.from(request.pinCode as Uint8Array).toString("utf8");
    return pin.length ? pin : undefined;
}

function lockCode(endpoint: Parameters<typeof contextOf>[0], request: { pinCode?: unknown }) {
    return pinOf(request) ?? contextOf(endpoint).alarmCode;
}

export class HaDoorLockServer extends DoorLockServer {
    override async lockDoor(request: DoorLock.LockDoorRequest) {
        const code = lockCode(this.endpoint, request);
        await contextOf(this.endpoint).call("lock", code ? { code } : {});
        this.state.lockState = DoorLock.LockState.Locked;
    }

    override async unlockDoor(request: DoorLock.UnlockDoorRequest) {
        const code = lockCode(this.endpoint, request);
        await contextOf(this.endpoint).call("unlock", code ? { code } : {});
        this.state.lockState = DoorLock.LockState.Unlocked;
    }

    override async unlockWithTimeout(request: DoorLock.UnlockWithTimeoutRequest) {
        const ctx = contextOf(this.endpoint);
        const code = lockCode(this.endpoint, request);
        await ctx.call("unlock", code ? { code } : {});
        this.state.lockState = DoorLock.LockState.Unlocked;
        if (request.timeout > 0) {
            setTimeout(() => detached(ctx.call("lock", code ? { code } : {}), "auto relock"), request.timeout * 1000);
        }
    }

    async unboltDoor(request: DoorLock.UnboltDoorRequest) {
        const code = lockCode(this.endpoint, request);
        await contextOf(this.endpoint).call("open", code ? { code } : {});
        this.state.lockState = DoorLock.LockState.Unlatched;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Thermostat (climate, water_heater)
// ---------------------------------------------------------------------------------------------------------------

export const SystemModeToHvac: Partial<Record<Thermostat.SystemMode, string>> = {
    [Thermostat.SystemMode.Off]: "off",
    [Thermostat.SystemMode.Auto]: "heat_cool",
    [Thermostat.SystemMode.Cool]: "cool",
    [Thermostat.SystemMode.Heat]: "heat",
    [Thermostat.SystemMode.EmergencyHeat]: "heat",
    [Thermostat.SystemMode.Precooling]: "cool",
    [Thermostat.SystemMode.FanOnly]: "fan_only",
    [Thermostat.SystemMode.Dry]: "dry",
    [Thermostat.SystemMode.Sleep]: "auto",
};

export class HaThermostatServer extends ThermostatServer {
    declare protected internal: HaThermostatServer.Internal;

    override async initialize() {
        await super.initialize();
        this.reactTo(this.events.systemMode$Changed, this.#onSystemMode, { offline: true });
        this.maybeReactTo((this.events as any).occupiedHeatingSetpoint$Changed, this.#onSetpoint as any, { offline: true });
        this.maybeReactTo((this.events as any).occupiedCoolingSetpoint$Changed, this.#onSetpoint as any, { offline: true });
    }

    #onSystemMode(mode: Thermostat.SystemMode, _old: Thermostat.SystemMode, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        const ctx = contextOf(this.endpoint);
        if (ctx.domain === "water_heater") {
            const modes: string[] = ctx.attributes.operation_list ?? [];
            if (mode === Thermostat.SystemMode.Off) {
                detached(ctx.call("turn_off"), "water_heater.turn_off");
            } else {
                const op = modes.find(m => m !== "off") ?? "on";
                if (modes.length) detached(ctx.call("set_operation_mode", { operation_mode: op }), "set_operation_mode");
                else detached(ctx.call("turn_on"), "water_heater.turn_on");
            }
            return;
        }
        const hvacModes: string[] = ctx.attributes.hvac_modes ?? [];
        let hvac = SystemModeToHvac[mode] ?? "auto";
        // Matter "Auto" may map to HA "heat_cool" or "auto" depending on what the device supports
        if (mode === Thermostat.SystemMode.Auto && !hvacModes.includes("heat_cool")) hvac = "auto";
        if (mode === Thermostat.SystemMode.Sleep && !hvacModes.includes("auto")) hvac = "heat_cool";
        detached(ctx.call("set_hvac_mode", { hvac_mode: hvac }), "climate.set_hvac_mode");
    }

    #onSetpoint(_value: number, _old: number, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        // Debounce: setpointRaiseLower or auto mode may change heating and cooling setpoint at once
        clearTimeout(this.internal.haSetpointTimer);
        const endpoint = this.endpoint;
        this.internal.haSetpointTimer = setTimeout(() => {
            try {
                this.#sendSetpoints(endpoint);
            } catch (e) {
                log.error(`Could not forward setpoint change: ${e instanceof Error ? e.message : e}`);
            }
        }, 150);
    }

    #sendSetpoints(endpoint: HaThermostatServer["endpoint"]) {
        {
            const ctx = contextOf(endpoint);
            const state = (endpoint.state as any).thermostat;
            const unit = ctx.ha.temperatureUnit;
            const toHa = (v: number | undefined) =>
                v === undefined ? undefined : Math.round(fromCelsius(v / 100, unit) * 10) / 10;
            const heat = toHa(state.occupiedHeatingSetpoint);
            const cool = toHa(state.occupiedCoolingSetpoint);
            const hvac = ctx.entity?.state;
            const data: Record<string, unknown> = {};

            if (ctx.domain === "water_heater") {
                data.temperature = heat;
            } else if (
                (hvac === "heat_cool" || (hvac === "auto" && ctx.attributes.target_temp_low !== undefined)) &&
                heat !== undefined &&
                cool !== undefined
            ) {
                data.target_temp_low = heat;
                data.target_temp_high = cool;
            } else if (hvac === "cool" || (hvac !== "heat" && heat === undefined)) {
                data.temperature = cool;
            } else {
                data.temperature = heat;
            }
            detached(ctx.call("set_temperature", data), "set_temperature");
        }
    }
}

export namespace HaThermostatServer {
    export class Internal extends ThermostatServer.Internal {
        haSetpointTimer?: NodeJS.Timeout;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Fan control (fan, climate fan modes, air purifier)
// ---------------------------------------------------------------------------------------------------------------

export class HaFanControlServer extends FanControlServer {
    override initialize() {
        super.initialize();
        this.reactTo(this.events.fanMode$Changed, this.#onFanMode, { offline: true });
        this.reactTo(this.events.percentSetting$Changed, this.#onPercent, { offline: true });
        this.maybeReactTo((this.events as any).speedSetting$Changed, this.#onSpeed as any, { offline: true });
        this.maybeReactTo((this.events as any).rockSetting$Changed, this.#onRock as any, { offline: true });
        this.maybeReactTo((this.events as any).airflowDirection$Changed, this.#onDirection as any, { offline: true });
        this.maybeReactTo((this.events as any).windSetting$Changed, this.#onWind as any, { offline: true });
    }

    /** Applies a percentage to Home Assistant (0 = off) */
    #applyPercent(percent: number) {
        const ctx = contextOf(this.endpoint);
        if (ctx.domain === "climate") {
            const modes: string[] = ctx.attributes.fan_modes ?? [];
            const mode = climateFanModeForPercent(modes, percent);
            if (mode) detached(ctx.call("set_fan_mode", { fan_mode: mode }), "climate.set_fan_mode");
            return;
        }
        const hasSpeed = (Number(ctx.attributes.supported_features ?? 0) & 1) !== 0;
        if (percent <= 0) detached(ctx.call("turn_off"), `${ctx.domain}.turn_off`);
        else if (ctx.domain === "fan" && hasSpeed) {
            detached(ctx.call("set_percentage", { percentage: percent }), "fan.set_percentage");
        }
        else detached(ctx.call("turn_on"), `${ctx.domain}.turn_on`);
    }

    #onFanMode(mode: FanControl.FanMode, _old: FanControl.FanMode, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        const ctx = contextOf(this.endpoint);
        const presets: string[] = ctx.attributes.preset_modes ?? [];
        const fanModes: string[] = ctx.attributes.fan_modes ?? [];
        switch (mode) {
            case FanControl.FanMode.Off:
                return this.#applyPercent(0);
            case FanControl.FanMode.Low:
                return this.#applyPercent(33);
            case FanControl.FanMode.Medium:
                return this.#applyPercent(66);
            case FanControl.FanMode.High:
            case FanControl.FanMode.On:
                return this.#applyPercent(100);
            case FanControl.FanMode.Auto:
            case FanControl.FanMode.Smart: {
                if (ctx.domain === "climate") {
                    const auto = fanModes.find(m => m.toLowerCase() === "auto");
                    if (auto) detached(ctx.call("set_fan_mode", { fan_mode: auto }), "climate.set_fan_mode");
                    return;
                }
                const preset = presets.find(p => ["auto", "smart", "natural"].includes(p.toLowerCase()));
                if (preset) detached(ctx.call("set_preset_mode", { preset_mode: preset }), "fan.set_preset_mode");
                else detached(ctx.call("turn_on"), "fan.turn_on");
                return;
            }
        }
    }

    #onPercent(percent: number | null, _old: number | null, context?: ActionContextLike) {
        if (!isRemote(context) || percent === null) return;
        this.#applyPercent(percent);
    }

    #onSpeed(speed: number | null, _old: number | null, context?: ActionContextLike) {
        if (!isRemote(context) || speed === null) return;
        const max = (this.state as any).speedMax ?? 100;
        this.#applyPercent(Math.round((speed / max) * 100));
    }

    #onRock(rock: FanControl.Rock, _old: FanControl.Rock, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        const oscillating = !!(rock.rockLeftRight || rock.rockUpDown || rock.rockRound);
        detached(contextOf(this.endpoint).call("oscillate", { oscillating }, "fan"), "fan.oscillate");
    }

    #onDirection(direction: FanControl.AirflowDirection, _old: FanControl.AirflowDirection, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        const value = direction === FanControl.AirflowDirection.Reverse ? "reverse" : "forward";
        detached(contextOf(this.endpoint).call("set_direction", { direction: value }, "fan"), "fan.set_direction");
    }

    #onWind(wind: FanControl.Wind, _old: FanControl.Wind, context?: ActionContextLike) {
        if (!isRemote(context)) return;
        const ctx = contextOf(this.endpoint);
        const presets: string[] = ctx.attributes.preset_modes ?? [];
        const wanted = wind.sleepWind ? "sleep" : wind.naturalWind ? "natural" : undefined;
        const preset = wanted && presets.find(p => p.toLowerCase().includes(wanted));
        if (preset) detached(ctx.call("set_preset_mode", { preset_mode: preset }), "fan.set_preset_mode");
    }

    step(request: FanControl.StepRequest): MaybePromise {
        const state = this.state as any;
        const ctx = contextOf(this.endpoint);
        const stepPercent = Number(ctx.attributes.percentage_step ?? 10) || 10;
        let percent = (state.percentSetting ?? state.percentCurrent ?? 0) as number;
        if (request.direction === FanControl.StepDirection.Increase) {
            percent += stepPercent;
            if (percent > 100) percent = request.wrap ? (request.lowestOff ? 0 : stepPercent) : 100;
        } else {
            percent -= stepPercent;
            const lowest = request.lowestOff ? 0 : stepPercent;
            if (percent < lowest) percent = request.wrap ? 100 : lowest;
        }
        // The percentSetting$Changed reactor forwards the new value to Home Assistant
        state.percentSetting = clamp(Math.round(percent), 0, 100);
    }
}

/** Picks the climate fan mode that best matches a percentage */
export function climateFanModeForPercent(modes: string[], percent: number): string | undefined {
    const ordered = orderedClimateFanModes(modes);
    if (!ordered.length) return undefined;
    if (percent <= 0) return modes.find(m => m.toLowerCase() === "off") ?? ordered[0];
    const index = clamp(Math.ceil((percent / 100) * ordered.length) - 1, 0, ordered.length - 1);
    return ordered[index];
}

const fanModeRank: Record<string, number> = {
    silent: 0,
    quiet: 0,
    diffuse: 0,
    lowest: 1,
    low: 2,
    "1": 2,
    middle: 4,
    mid: 4,
    medium: 4,
    "2": 4,
    "3": 6,
    high: 7,
    "4": 7,
    highest: 8,
    "5": 8,
    strong: 9,
    focus: 9,
    turbo: 10,
    max: 10,
    full: 10,
};

/** Climate fan modes ordered by speed, without auto/off/on */
export function orderedClimateFanModes(modes: string[]): string[] {
    return modes
        .filter(m => !["auto", "off", "on"].includes(m.toLowerCase()))
        .map((m, i) => ({ m, rank: fanModeRank[m.toLowerCase().replace(/[ _-]/g, "")] ?? 5 + i / 100 }))
        .sort((a, b) => a.rank - b.rank)
        .map(e => e.m);
}

// ---------------------------------------------------------------------------------------------------------------
// Mode select (select, input_select, media_player sources, effects...)
// ---------------------------------------------------------------------------------------------------------------

export class HaModeSelectServer extends ModeSelectServer {
    override async changeToMode({ newMode }: ModeSelect.ChangeToModeRequest) {
        const ctx = contextOf(this.endpoint);
        const mode = this.state.supportedModes.find(m => m.mode === newMode);
        if (!mode) throw new Error(`Unknown mode ${newMode}`);
        const option = mode.label;
        switch (ctx.domain) {
            case "select":
            case "input_select":
                await ctx.call("select_option", { option });
                break;
            case "media_player":
                await ctx.call("select_source", { source: option });
                break;
            case "light":
                await ctx.call("turn_on", { effect: option });
                break;
            case "climate":
                await ctx.call("set_preset_mode", { preset_mode: option });
                break;
            case "fan":
                await ctx.call("set_preset_mode", { preset_mode: option });
                break;
            case "humidifier":
                await ctx.call("set_mode", { mode: option });
                break;
            case "water_heater":
                await ctx.call("set_operation_mode", { operation_mode: option });
                break;
            case "vacuum":
                await ctx.call("set_fan_speed", { fan_speed: option });
                break;
            case "alarm_control_panel": {
                const service = option === "disarmed" ? "alarm_disarm" : `alarm_${option.replace(/^armed_/, "arm_")}`;
                const code = ctx.alarmCode;
                await ctx.call(service, code ? { code } : {});
                break;
            }
            default:
                throw new Error(`Mode selection is not supported for ${ctx.domain}`);
        }
        return super.changeToMode({ newMode });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Valve
// ---------------------------------------------------------------------------------------------------------------

export class HaValveServer extends ValveConfigurationAndControlServer {
    async open(request: ValveConfigurationAndControl.OpenRequest) {
        const ctx = contextOf(this.endpoint);
        const level = request.targetLevel;
        if (level !== undefined && level !== null && ctx.domain === "valve" && (Number(ctx.attributes.supported_features) & 4)) {
            await ctx.call("set_valve_position", { position: level });
        } else if (ctx.domain === "valve") {
            await ctx.call("open_valve");
        } else {
            await ctx.call("turn_on", {}, "homeassistant");
        }
        const state = this.state as any;
        state.targetState = ValveConfigurationAndControl.ValveState.Open;
        if (level !== undefined && level !== null && "targetLevel" in state) state.targetLevel = level;
    }

    async close() {
        const ctx = contextOf(this.endpoint);
        if (ctx.domain === "valve") await ctx.call("close_valve");
        else await ctx.call("turn_off", {}, "homeassistant");
        const state = this.state as any;
        state.targetState = ValveConfigurationAndControl.ValveState.Closed;
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Robot vacuum
// ---------------------------------------------------------------------------------------------------------------

export const RvcRunModes = { Idle: 0, Cleaning: 1 } as const;

export class HaRvcRunModeServer extends RvcRunModeServer {
    override async changeToMode({ newMode }: ModeBase.ChangeToModeRequest) {
        const ctx = contextOf(this.endpoint);
        if (newMode === RvcRunModes.Cleaning) await ctx.call("start");
        else if (newMode === RvcRunModes.Idle) await ctx.call(ctx.entity?.state === "cleaning" ? "pause" : "stop");
        return super.changeToMode({ newMode });
    }
}

export class HaRvcCleanModeServer extends RvcCleanModeServer {
    override async changeToMode({ newMode }: ModeBase.ChangeToModeRequest) {
        const ctx = contextOf(this.endpoint);
        const mode = this.state.supportedModes.find(m => m.mode === newMode);
        if (mode) await ctx.call("set_fan_speed", { fan_speed: mode.label });
        return super.changeToMode({ newMode });
    }
}

const noError = { commandResponseState: { errorStateId: OperationalState.ErrorState.NoError } };

export class HaRvcOperationalStateServer extends RvcOperationalStateServer {
    async pause() {
        await contextOf(this.endpoint).call("pause");
        this.state.operationalState = OperationalState.OperationalStateEnum.Paused;
        return noError;
    }

    async resume() {
        await contextOf(this.endpoint).call("start");
        this.state.operationalState = OperationalState.OperationalStateEnum.Running;
        return noError;
    }

    async goHome() {
        await contextOf(this.endpoint).call("return_to_base");
        return noError;
    }
}

