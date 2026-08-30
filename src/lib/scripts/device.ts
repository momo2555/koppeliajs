import { Console } from "./console.js";
import { MicLimitError } from "./errors.js";
import { Message, MessageType, PeerType } from "./message.js";
import { Resident } from "./resident.js";

type Color = {
    r: number;
    g: number;
    b: number;
    lon?: number;
    loff?: number;
};

type Vibration = {
    v: number; // time on (vibrating time)
    toff: number; // time off
    c: number; // number of cycles on/off
};

export type MicEffect = "echo" | "reverb" | null;

export type MicConfig = {
    volume: number;
    effect?: MicEffect;
    intensity?: number;
};

/**
 * Represents a physical or logical device connected to the console.
 * Handles device-specific commands like LEDs, vibrations, and hardware module subscriptions.
 */
export class Device {
    private _address: string;
    private _color: Color;
    private _name: string;
    private _console: Console;
    private _attachedEvents: string[];
    private _resident?: Resident;
    private _callbackIds: string[];
    private _eventsIds: string[];
    private isAttachedToResident: boolean;

    constructor(console: Console, address = "") {
        this._address = address;
        this._color = { r: 0, g: 0, b: 0 };
        this._name = "";
        this._console = console;
        this._attachedEvents = [];
        this._callbackIds = [];
        this._eventsIds = [];
        this.isAttachedToResident = false;
    }

    public get color(): Color {
        return this._color;
    }

    public get name(): string {
        return this._name;
    }

    public get address(): string {
        return this._address
    }

    /**
     * Subscribes to a specific hardware event for this device.
     * @param eventName The name of the event to listen to.
     * @param callback Function to execute when the event is triggered.
     */
    onEvent(eventName: string, callback: () => void): string {
        this._attachEvent(eventName);
        let consoleEvent = (
            device: string,
            from_addr: string,
            event: string,
        ) => {
            if (event == eventName && from_addr == this._address) {
                callback();
            }
        };
        const callbackId = this._console.onDeviceEvent(consoleEvent);
        // Sans cette ligne, l'identifiant se perdait aussitôt créé et
        // `clearEvent`/`clearAllEvents` ne pouvaient RIEN retirer : un jeu qui
        // recâblait ses manettes empilait un écouteur de plus à chaque fois, et
        // un seul appui finissait par compter deux, trois, quatre fois.
        this._eventsIds.push(callbackId);
        return callbackId;
    }

    /**
     * Enables the cursor module and listens for coordinate updates.
     * @param callback Function to execute with the incoming (x, y, a) coordinates.
     */
    onCursor(
        callback: (x: number, y: number, a: number) => void,
        fovx?: number,
        fovy?: number,
    ): string {
        this._enableModule("cursor");
        this._attachEvent("cursor");
        if (fovx !== undefined || fovy !== undefined) {
            this.setCursorFov(fovx, fovy);
        }
        let callbackId = this._console.onRequest(
            (request, params, form, address) => {
                if (request == "cursor" && address == this._address) {
                    callback(params.x, params.y, params.a);
                }
            },
        );
        this._callbackIds.push(callbackId);
        return callbackId;
    }

    /**
     * Overrides the cursor field of view (the angle-to-screen mapping) for this
     * device. The value is the angular span, in degrees, mapped to the full screen
     * axis: a smaller FOV is more sensitive (a small head rotation reaches the
     * edge). Takes effect live while the cursor module is enabled. The console
     * clamps each value to [2, 170]°; the firmware defaults are 80° / 60° and are
     * restored when the cursor module is disabled. Pass only the axis to change.
     * @param fovx Horizontal field of view in degrees.
     * @param fovy Vertical field of view in degrees.
     */
    setCursorFov(fovx?: number, fovy?: number): void {
        if (fovx === undefined && fovy === undefined) return;
        let request = new Message();
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("setCursorFov");
        if (fovx !== undefined) request.addParam("fovx", fovx);
        if (fovy !== undefined) request.addParam("fovy", fovy);
        this._console.sendMessage(request);
    }

    /**
     * Enables the biking module and listens for speed updates.
     * @param callback Function to execute with the incoming speed data.
     */
    onBiking(callback: (speed: number) => void): string {
        this._enableModule("biking");
        this._attachEvent("biking");
        let callbackId = this._console.onRequest(
            (request, params, form, address) => {
                if (request == "biking" && address == this._address) {
                    callback(params.speed);
                }
            },
        );
        this._callbackIds.push(callbackId);
        return callbackId;
    }

    /**
     * Enables the biking module and listens for speed updates.
     * @param callback Function to execute with the incoming speed data.
     */
    onRotation(callback: (omega: number) => void): string {
        this._enableModule("rot");
        this._attachEvent("rotation");
        let callbackId = this._console.onRequest(
            (request, params, form, address) => {
                if (request == "rotation" && address == this._address) {
                    callback(params.omega);
                }
            },
        );
        this._callbackIds.push(callbackId);
        return callbackId;
    }

    /**
     * Enables the vertical detector module and listens for orientation updates.
     * @param callback Function to execute with the boolean vertical state.
     */
    onVerticalDetector(callback: (vertical: boolean) => void): string {
        this._enableModule("vDetct");
        this._attachEvent("verticalDetector");
        let callbackId = this._console.onRequest(
            (request, params, form, address) => {
                if (request == "verticalDetector" && address == this._address) {
                    callback(params.value);
                }
            },
        );
        this._callbackIds.push(callbackId);
        return callbackId;
    }

    /**
     * Sends a request to the device to attach a specific event listener on the hardware side.
     * @param event The event name to attach.
     */
    private _attachEvent(event: string) {
        // `in` sur un tableau teste un INDEX, pas une valeur : la condition
        // était vraie pour 0, 1, 2… et fausse pour "buzz". La requête repartait
        // donc à chaque abonnement, et la console empile une paire par réception.
        if (!this._attachedEvents.includes(event)) {
            let request = new Message();
            request.addParam("event", event);
            request.setDestination(PeerType.DEVICE, this._address);
            request.setRequest("attachEvent");
            this._console.sendMessage(request);
            this._attachedEvents.push(event);
        }
    }

    /**
     * Sends a request to the device to enable a specific hardware module.
     * @param moduleName The name of the module to enable (Note: retains original code spelling).
     */
    private _enableModule(moduleName: string) {
        let request = new Message();
        request.addParam("module", moduleName);
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("enableModule");
        this._console.sendMessage(request);
    }

    /**
     * Enables the microphone module on this device.
     * Filarmonic enforces a maximum of 5 simultaneous mic modules.
     * @throws {MicLimitError} if the 5-mic limit has been reached.
     */
    enableMic(): Promise<void> {
        return new Promise((resolve, reject) => {
            let request = new Message();
            request.addParam("module", "mic");
            request.setDestination(PeerType.DEVICE, this._address);
            request.setRequest("enableModule");
            this._console.sendMessage(request, (response) => {
                if (response.getType() === MessageType.ERROR) {
                    const errMsg = response.getParam("error") ?? "Failed to enable mic module";
                    reject(new MicLimitError(errMsg));
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * Disables the microphone module on this device and removes its audio sink in Maestro.
     */
    disableMic(): void {
        let request = new Message();
        request.addParam("module", "mic");
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("disableModule");
        this._console.sendMessage(request);
    }

    /**
     * Configures the audio sink for this device's microphone.
     * Must be called after enableMic() succeeds.
     * @param config The microphone sink configuration.
     */
    setMicConfig(config: MicConfig): void {
        let request = new Message();
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("setMicConfig");
        request.addParam("volume", config.volume);
        if (config.effect !== undefined) request.addParam("effect", config.effect);
        if (config.intensity !== undefined) request.addParam("intensity", config.intensity);
        this._console.sendMessage(request);
    }

    /**
     * Changes the current LED color of the device.
     * @param color The RGB color configuration to apply.
     */
    setColor(color: Color) {
        this._color = color;
        let request = new Message();
        request.addParam("color", color);
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("setColor");
        this._console.sendMessage(request);
    }

    /**
     * Sends a predefined sequence of colors to the device.
     * @param sequence Array of color sequence identifiers or configurations.
     * @param reset Whether to interrupt the current sequence before starting the new one.
     */
    setColorSequence(sequence: string[], reset: boolean = false) {
        let request = new Message();
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("setColorSequence");
        request.addParam("sequence", sequence);
        request.addParam("reset", reset);
        this._console.sendMessage(request);
    }

    /**
     * Triggers the device's vibration motor.
     * @param time Total vibration time in milliseconds.
     * @param blink Enables pulsating/intermittent vibration.
     * @param blinkOff The duration of the pause between pulses in milliseconds.
     * @param blinkCount The number of pulsing cycles to execute.
     */
    vibrate(
        time: number,
        blink: boolean = false,
        blinkOff: number = 0,
        blinkCount: number = 0,
    ) {
        let vibration: Vibration = {
            v: time,
            toff: 0,
            c: 1,
        };
        if (blink) {
            vibration.toff = blinkOff;
            vibration.c = blinkCount;
        }

        let request = new Message();
        request.addParam("vibration", vibration);
        request.setDestination(PeerType.DEVICE, this._address);
        request.setRequest("vibrate");
        this._console.sendMessage(request);
    }

    public clearCallback(callbackId: string) {
        if (this._callbackIds.includes(callbackId)) {
            this._console.unsubscribeCallback(callbackId);
        }
    }

    public clearAllCallbacks() {
        for (let callbackId of this._callbackIds) {
            this.clearCallback(callbackId);
        }
        this._callbackIds = [];
    }

    public clearEvent(eventId: string) {
        if (this._eventsIds.includes(eventId)) {
            this._console.unsubscribeCallback(eventId);
        }
    }

    public clearAllEvents() {
        for (let eventId of this._eventsIds) {
            this.clearEvent(eventId);
        }
        this._eventsIds = [];
    }

    /**
     * Serializes the Device object into a generic dictionary.
     * @returns A plain object representing the device's current state.
     */
    toObject(): { [key: string]: any } {
        return {
            "address": this._address,
            "color": this._color,
            "name": this._name,
        };
    }

    /**
     * Hydrates the Device instance using properties from a provided object.
     * @param object The plain object containing device properties.
     */
    fromObject(object: { [key: string]: any }) {
        if (object.address !== undefined) {
            this._address = object.address;
        }
        if (object.color !== undefined) {
            this._color = object.color;
        }
        if (object.name !== undefined) {
            this._name = object.name;
        }
        if (object.resident !== undefined) {
            this.isAttachedToResident = true;
            this._resident = new Resident();
            this._resident.fromObject(object.resident);
        }
    }

    public get resident(): Resident | undefined {
        return this._resident;
    }

    public get isAssociatedToResident(): boolean {
        return this.isAttachedToResident;
    }
}
