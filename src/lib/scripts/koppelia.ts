import { get, type Writable } from "svelte/store";
import { routeType } from "../stores/routeStore.js";
import { type AnyRequestCallback, Console } from "./console.js";
import { ACTIVITY_STATE_KEY, type AnyState, State } from "./state.js";
import { Message, PeerType } from "./message.js";
import { Stage } from "./stage.js";
import { Device } from "./device.js";
import { Play } from "./play.js";
import { Resident } from "./resident.js";
import { Option, type OptionChangedCallback } from "./option.js";
import { logger, setDebugMode } from "./logger.js";
import { CustomCallbacks } from "./customCallback.js";
import { Song } from "./song.js";
import { ParticipantRegistry } from "./participants.js";
import {
    type ParticipantResult,
    serializeParticipant,
} from "./telemetry.js";

/**
 * The main Koppelia framework entry point.
 * Implements a Singleton pattern to provide global access to the console, state, stages,
 * devices, and game synchronization features across the Svelte application.
 */
export class Koppelia {
    private _console: Console;
    private _state: State;
    private _stage: Stage;
    private static _instance: Koppelia;
    private _option: Option;
    private _callbacks: CustomCallbacks;
    private _participants: ParticipantRegistry;
    /** Counts inbound state updates, so a pending boundary can wait for one. */
    private __stateRevision = 0;
    private __activityPending = false;
    private __activityStateSeen = 0;

    private constructor() {
        this._console = new Console();
        this._callbacks = new CustomCallbacks(this._console);
        this._participants = new ParticipantRegistry(this._console);
        this._console.onReady(() => {
            this._identify();
            this._seedParticipants();
        });
        // Every state frame that arrives bumps the revision. A pending boundary
        // waits for one.
        //
        // Note what this does NOT prove: the broker's `send_to_all` broadcasts a
        // `changeState` to every monitor and controller WITHOUT excluding the
        // sender, so a peer's own write comes back to it as an inbound frame. The
        // revision therefore means "a state frame crossed the wire", not "the
        // monitor restarted".
        //
        // That is enough for a game whose boundary request does not write state
        // (bowlstar-revolution). A game that DOES write while waiting cannot be
        // saved by any rule here — it has to stop writing, which is what donjon
        // now does. Documented rather than papered over, because the distinction
        // is exactly what two attempts at this got wrong.
        this._console.onStateChange(() => {
            this.__stateRevision += 1;
        });

        this._state = new State(this._console, {});
        this._stage = new Stage(this._console);
        this._option = new Option(this._console);
    }

    /**
     * Tell the participant registry about the controllers that were ALREADY
     * connected when this game started.
     *
     * Without this the registry only ever hears about controllers that connect
     * or are re-bound after it exists — and every controller in a residence is
     * paired long before an animator launches a game, so in practice it hears
     * about none of them. The consequence is not a missing row, it is a WRONG
     * one: an untracked address answers `keyFor` with binding 1, and when the
     * animator later hands that controller to somebody else, `track` sees an
     * address it has never met, files it at binding 1 again, and fires no
     * rebind. Same key, second resident — the console upserts, and the two
     * women collapse into a single line whose `resident_id` is whoever was
     * written last. That is exactly the collision the participant key was
     * introduced to prevent (settled 2026-08-10).
     *
     * Two games shipped this bug independently before it was fixed here, which
     * is the argument for the seeding living in the SDK rather than in each
     * game's telemetry file.
     *
     * Best effort: a console that cannot answer leaves the registry as it was,
     * and `build` warns rather than inventing a key.
     */
    private _seedParticipants(): void {
        this.getDevices()
            .then((devices) => {
                for (const device of devices) {
                    // Only addresses the registry has NEVER heard of. The snapshot
                    // is already stale by the time it arrives: a
                    // `deviceResidentNotification` landing between the request and
                    // its reply is newer than what `getDevices` returned, and
                    // replaying the snapshot over it would count a binding towards
                    // the resident who just left the controller.
                    if (this._participants.residentFor(device.address) === undefined
                        && !this._participants.knows(device.address)) {
                        this._participants.track(device);
                    }
                }
            })
            .catch((e) => logger.error(`[participants] could not seed: ${e}`));
    }

    /**
     * Identify to the master as soon as the route is known. The socket often
     * opens before the root layout has called updateRoute() — identifying with
     * an empty type (or not at all) leaves this peer invisible to the master's
     * push routing: it can send requests fine but never receives a state
     * broadcast again. So an unknown route is waited for, never dropped.
     */
    private _identify(): void {
        const type = get(routeType);
        if (type == "controller") {
            logger.log("identify controller");
            this._console.identify(PeerType.CONTROLLER);
        } else if (type == "monitor") {
            logger.log("identify monitor");
            this._console.identify(PeerType.MONITOR);
        } else {
            logger.log("Route not resolved yet, deferring identification");
            const unsubscribe = routeType.subscribe((resolved) => {
                if (resolved !== "") {
                    // Svelte calls subscribers synchronously on subscribe; the
                    // empty-value guard makes that first call a no-op and the
                    // unsubscribe below only runs once resolution happened.
                    queueMicrotask(unsubscribe);
                    this._identify();
                }
            });
        }
    }

    /**
     * Retrieves the singleton instance of the Koppelia class.
     * Instantiates it if it does not yet exist.
     */
    public static get instance(): Koppelia {
        if (!Koppelia._instance) {
            Koppelia._instance = new Koppelia();
        }
        return Koppelia._instance;
    }

    /**
     * Retrieves the global Svelte writable store representing the synchronized game state.
     */
    public get state(): Writable<AnyState> {
        return this._state.state;
    }

    /**
     * Merges a partial update into the current global state and broadcasts the change.
     * @param stateUpdate A dictionary containing the keys/values to update.
     */
    public updateState(stateUpdate: AnyState) {
        this._state.updateState(stateUpdate);
    }

    /**
     * Completely overwrites the global state with a new state object.
     *
     * @param newState The new state object to apply.
     * @param force Broadcast the WHOLE state instead of the computed diff.
     *
     * The diff is computed against the last value this peer saw — including the
     * echo of its own publications, which the console sends back to everyone.
     * A game publishing faster than the round-trip can therefore write A, then
     * B, then A again, and see that last change diff to nothing and never
     * leave: the other peers stay on B for good. A monitor that owns the state
     * and publishes at a high rate should force. Costs the size of the state,
     * saves a divergence that never repairs itself.
     */
    public setState(newState: AnyState, force: boolean = false) {
        this._state.setState(newState, force);
    }

    /**
     * Checks if the underlying WebSocket console connection is fully established.
     */
    public get ready(): boolean {
        return this._console.ready;
    }

    /**
     * Enables or disables debug mode for extended console logging.
     * @param enable True to enable debug logs, false to disable.
     */
    public setDebugMode(enable: boolean) {
        setDebugMode(enable);
    }

    /**
     * Registers a callback to execute when the console connection is fully ready.
     * @param callback The function to execute.
     */
    public onReady(callback: () => void) {
        this._console.onReady(callback);
    }

    /**
     * Initializes the default state and the routing stages of the game.
     * Specifically executes for "monitor" peers to ensure the primary game view sets the rules.
     * @param defaultState The initial state structure.
     * @param stages An array of valid stage names for application routing.
     */
    public init(defaultState: AnyState, stages: string[]) {
        this._console.onReady(() => {
            let type = get(routeType);
            if (type == "monitor") {
                this._state.setState(defaultState, true);
                this._stage.initStages(stages);
            }
        });
    }

    /**
     * Requests a transition to a specific stage (view) across the network.
     * Note: All active console event listeners will be destroyed before transition.
     * @param stageName The target stage to navigate to.
     */
    public goto(stageName: string) {
        this._stage.goto(stageName);
    }

    public getCurrentStage(): string {
        return this._stage.currentStage;
    }

    /**
     * Normalizes a media URL to ensure cross-client compatibility.
     * @param mediaUrl The raw media URL.
     * @returns The corrected URL.
     */
    public fixMediaUrl(mediaUrl: string): string {
        return this._console.fixMediaUrl(mediaUrl);
    }

    /**
     * Constructs the full URL for a given relative media path.
     * @param path The relative media path.
     * @returns The full URL string.
     */
    public getMediaLink(path: string): string {
        return this._console.getMediaUrl(path);
    }

    /**
     * Asynchronously fetches the list of available connected devices from the master peer.
     * @returns A promise resolving to an array of instantiated Device objects.
     */
    public async getDevices(): Promise<Device[]> {
        return new Promise((resolve, reject) => {
            let getDevicesRequest = new Message();
            getDevicesRequest.setRequest("getDevices");
            getDevicesRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getDevicesRequest,
                (response: Message) => {
                    let devicesRaw: any = response.getParam("devices", []);
                    let devices: Device[] = [];
                    for (let device_raw of devicesRaw) {
                        let device = new Device(this._console);
                        device.fromObject(device_raw);
                        devices.push(device);
                    }
                    resolve(devices);
                },
            );
        });
    }

    private _onDeviceConnNotification(
        callback: (device: Device) => void,
        notifName: string,
    ): string {
        return this._console.onRequest((request, params, from, address) => {
            if (request == notifName) {
                if (params.device !== undefined) {
                    let device = new Device(this._console);
                    device.fromObject(params.device);
                    callback(device);
                }
            }
        });
    }

    public onDeviceConnectedNotification(
        callback: (device: Device) => void,
    ): string {
        return this._onDeviceConnNotification(
            callback,
            "deviceConnectionNotification",
        );
    }

    public onDeviceDisconnectedNotification(
        callback: (device: Device) => void,
    ): string {
        return this._onDeviceConnNotification(
            callback,
            "deviceDisconnectionNotification",
        );
    }

    public unsubDeviceConnectionNotification(callbackId: string) {
        this._console.unsubscribeCallback(callbackId);
    }

    /**
     * Asynchronously fetches the list of registered residents/players.
     *
     * Filarmonic paginates the resident list. Pass `count`/`index` to fetch a
     * specific page (e.g. count=10, index=10 for the second page) and `findWord`
     * to filter by name. Called with no arguments, no pagination params are sent
     * (legacy behaviour).
     * @returns A promise resolving to an array of Resident instances.
     */
    public async getResidents(
        count?: number,
        index?: number,
        findWord?: string,
    ): Promise<Resident[]> {
        return new Promise((resolve, reject) => {
            let getResidentsRequest = new Message();
            getResidentsRequest.setRequest("getResidentsList");
            if (count !== undefined || index !== undefined || findWord !== undefined) {
                getResidentsRequest.addParam("getRaw", false);
                getResidentsRequest.addParam("count", count ?? 10);
                getResidentsRequest.addParam("index", index ?? 0);
                getResidentsRequest.addParam("findWord", findWord ?? "");
            }
            getResidentsRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getResidentsRequest,
                (response: Message) => {
                    let ResidentRawList: { [key: string]: any } = response
                        .getParam("residents", {});
                    let residents: Resident[] = [];
                    for (let residentId in ResidentRawList) {
                        let resident = new Resident();
                        resident.fromObject(ResidentRawList[residentId]);
                        residents.push(resident);
                    }
                    resolve(residents);
                },
            );
        });
    }

    /**
     * Asks the console to open the shared resident-creation UI. The TV
     * (spectakle) and the animator app both open it; when the animator creates
     * a resident, `onResidentCreated` fires so the game can integrate it without
     * reloading its list. Fire-and-forget.
     * @param context Optional extra params forwarded to the UI (e.g. gameId).
     */
    public openCreateResident(context: { [key: string]: any } = {}): void {
        let request = new Message();
        request.setRequest("openCreateResident");
        for (let key in context) {
            request.addParam(key, context[key]);
        }
        request.setDestination(PeerType.MASTER, "");
        this._console.sendMessage(request);
    }

    /**
     * Fires when a resident is created via the externalized creation UI (see
     * {@link openCreateResident}). The callback receives the freshly created
     * Resident so the game can insert it (e.g. at the top of its list) without
     * a full reload.
     * @returns A subscription id to pass to `unsubscribeCallback`.
     */
    public onResidentCreated(callback: (resident: Resident) => void): string {
        return this._console.onRequest((request, params) => {
            if (request == "residentCreated" && params.resident !== undefined) {
                let resident = new Resident();
                resident.fromObject(params.resident);
                callback(resident);
            }
        });
    }

    /**
     * Fires when the resident-creation UI is closed without creating (cancel),
     * so the game can re-enable its own UI.
     * @returns A subscription id to pass to `unsubscribeCallback`.
     */
    public onCreateResidentClosed(callback: () => void): string {
        return this._console.onRequest((request) => {
            if (request == "closeCreateResident") {
                callback();
            }
        });
    }

    /**
     * Asynchronously fetches a specific song by its unique ID.
     * @param songId The ID of the song to retrieve.
     * @returns A promise resolving to the corresponding Song instance.
     */
    public async getSongById(songId: string): Promise<Song> {
        return new Promise((resolve, reject) => {
            let getSongRequest = new Message();
            getSongRequest.setRequest("getSong");
            getSongRequest.addParam("songId", songId);
            getSongRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getSongRequest,
                (response: Message) => {
                    let rawSong: { [key: string]: any } = response
                        .getParam("song", {});
                    let song: Song = new Song();
                    song.fromObject(rawSong);
                    resolve(song);
                },
            );
        });
    }

    /**
     * Asynchronously fetches a dictionary of all songs associated with the currently active play.
     * @returns A promise resolving to a map of song IDs to Song instances.
     */
    public getCurrentPlaySongs(): Promise<{ [key: string]: Song }> {
        return new Promise((resolve, reject) => {
            let getSongRequest = new Message();
            getSongRequest.setRequest("getCurrentPlaySongs");
            getSongRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getSongRequest,
                (response: Message) => {
                    let rawSongs: { [key: string]: any }[] = response
                        .getParam("songs", []);
                    let songs: { [key: string]: Song } = {};
                    for (let songObj of rawSongs) {
                        let song = new Song();
                        song.fromObject(songObj);
                        songs[song.id] = song;
                    }
                    resolve(songs);
                },
            );
        });
    }

    /**
     * Asynchronously retrieves the currently active Play instance set on the server.
     * @returns A promise resolving to the active Play.
     */
    public async getCurrentPlay(): Promise<Play> {
        return new Promise((resolve, reject) => {
            let getCuurentPlayRequest = new Message();
            getCuurentPlayRequest.setRequest("getCurrentPlay");
            getCuurentPlayRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getCuurentPlayRequest,
                (response: Message) => {
                    let playData = response.getParam("play", {});
                    let playId = response.getParam("playId", "");
                    let play = new Play(this._console, playId, playData);
                    resolve(play);
                },
            );
        });
    }

    /**
     * Asynchronously retrieves all currently selected Play instances set on the server.
     * @returns A promise resolving to an array of active Play instances.
     */
    public async getCurrentPlays(): Promise<Play[]> {
        return new Promise((resolve, reject) => {
            let getCurrentPlaysRequest = new Message();
            getCurrentPlaysRequest.setRequest("getCurrentPlays");
            getCurrentPlaysRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getCurrentPlaysRequest,
                (response: Message) => {
                    let playsRawList: { [key: string]: any }[] = response.getParam("plays", []);
                    let plays: Play[] = playsRawList.map((playData) =>
                        new Play(this._console, playData.id, playData)
                    );
                    resolve(plays);
                },
            );
        });
    }

    /**
     * Asynchronously executes a named API function on the master peer with the given arguments.
     * @param functionName The name of the API function to invoke.
     * @param args A dictionary of string arguments to pass to the function.
     * @returns A promise resolving to the result returned by the API function.
     */
    public async runApiFunction(
        functionName: string,
        args: Record<string, string>,
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            let request = new Message();
            request.setRequest("runApiFunction");
            request.addParam("functionName", functionName);
            request.addParam("args", args);
            request.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(request, (response: Message) => {
                let result = response.getParam("result", null);
                resolve(result);
            });
        });
    }

    /**
     * Enables a live difficulty cursor, allowing difficulty changes during gameplay.
     * @param callback Function to execute when the difficulty changes.
     */
    public async enableDifficultyCursor(
        callback: (difficulty: number) => void,
    ) {
    }

    /**
     * Registers a new growable element on the network and listens for state changes.
     * @param id The unique identifier for the growable element.
     * @param onGrowChange Callback triggered when the 'grown' state of the element changes.
     */
    public async registerNewGrowableElement(
        id: string,
        onGrowChange: (grown: boolean) => void,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (get(routeType) == "controller") {
                let addGrowableElRequest = new Message();
                addGrowableElRequest.setRequest("addGrowableElement");
                addGrowableElRequest.addParam("id", id);
                addGrowableElRequest.setDestination(PeerType.MASTER, "");

                this._console.sendMessage(
                    addGrowableElRequest,
                    (response: Message) => {
                    },
                );
            }

            this._console.onRequest(
                (req: string, params: { [key: string]: any }) => {
                    if (req == "gowableElementNotification") {
                        if (params.id !== undefined && params.id == id) {
                            let grown = false;
                            if (params.grown != undefined) grown = params.grown;
                            onGrowChange(grown);
                        }
                    }
                },
            );
            resolve();
        });
    }

    /**
     * Updates the 'grown' state of a registered growable element across the network.
     * @param id The unique identifier of the element.
     * @param grown True if the element is in a grown state, false otherwise.
     */
    public async updateGrowableElement(
        id: string,
        grown: boolean,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            let addGrowableElRequest = new Message();
            addGrowableElRequest.setRequest("updateGrowableElement");
            addGrowableElRequest.addParam("id", id);
            addGrowableElRequest.addParam("grown", grown);
            addGrowableElRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                addGrowableElRequest,
                (response: Message) => {
                    resolve();
                },
            );
        });
    }

    /**
     * Registers a new resizable text element with a default font size (Monitor only).
     * @param id The unique identifier for the text element.
     * @param defaultSize The default font size.
     * @param minSize Optional minimum font size (default 0).
     * @param maxSize Optional maximum font size (default 100).
     */
    public async registerNewResizableText(
        id: string,
        defaultSize: number,
        minSize?: number,
        maxSize?: number,
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            if (get(routeType) == "monitor") {
                let addGrowableElRequest = new Message();
                addGrowableElRequest.setRequest("addResizableText");
                addGrowableElRequest.addParam("id", id);
                addGrowableElRequest.addParam("defaultSize", defaultSize);
                if (minSize !== undefined) addGrowableElRequest.addParam("minSize", minSize);
                if (maxSize !== undefined) addGrowableElRequest.addParam("maxSize", maxSize);
                addGrowableElRequest.setDestination(PeerType.MASTER, "");

                this._console.sendMessage(
                    addGrowableElRequest,
                    (response: Message) => {
                    },
                );
            }

            resolve();
        });
    }

    /**
     * Subscribes to size change notifications for a specific resizable text element.
     * @param id The unique identifier of the text element.
     * @param onTextResized Callback executed with the new font size.
     * @returns The unique subscription ID used for unsubscribing.
     */
    public onResizableTextChanged(
        id: string,
        onTextResized: (newSize: number) => void,
    ): string {
        return this._console.onRequest(
            (req: string, params: { [key: string]: any }) => {
                if (req == "resizableTextNotification") {
                    if (
                        params.id !== undefined && params.id == id &&
                        params.fontSize != undefined
                    ) {
                        let fontSize = params.fontSize;
                        onTextResized(fontSize);
                    }
                }
            },
        );
    }

    /**
     * Unsubscribes a previously registered resizable text listener.
     * @param callbackId The subscription ID returned by onResizableTextChanged.
     */
    public unsubResizableText(callbackId: string) {
        this._console.unsubscribeCallback(callbackId);
    }

    /**
     * Retrieves the list of all registered resizable text elements from the master.
     * @returns A promise resolving to an array of resizable element data objects.
     */
    public async getResizableTexts(): Promise<{ [key: string]: any }[]> {
        return new Promise((resolve, reject) => {
            let addGrowableElRequest = new Message();
            addGrowableElRequest.setRequest("getResizableTexts");
            addGrowableElRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                addGrowableElRequest,
                (response: Message) => {
                    let resizables = response.getParam("resizableTexts", []);
                    resolve(resizables);
                },
            );
        });
    }

    /**
     * Writes configuration data to the master peer, optionally binding it to the current play.
     * @param config_id The unique identifier for this configuration data.
     * @param config_value The dictionary containing the configuration payload.
     * @param current_play Whether to bind this configuration to the active play session (default: true).
     */
    public async writeGameConfig(
        config_id: string,
        config_value: { [key: string]: any },
        current_play: boolean = true,
    ) {
        let setGameConfigRequest = new Message();

        setGameConfigRequest.setRequest("setGameData");
        setGameConfigRequest.addParam(
            "playId",
            current_play ? "current" : null,
        );
        setGameConfigRequest.addParam("content", config_value);
        setGameConfigRequest.addParam("dataId", config_id);
        setGameConfigRequest.setDestination(PeerType.MASTER, "");

        this._console.sendMessage(
            setGameConfigRequest,
        );
    }

    /**
     * Retrieves persistent configuration data from the master peer.
     * @param config_id The unique identifier of the configuration data to fetch.
     * @param current_play True to fetch data bound specifically to the active play, false otherwise.
     * @returns A promise resolving to the configuration dictionary.
     */
    public async getGameConfig(
        config_id: string,
        current_play: boolean,
    ): Promise<{ [key: string]: any }> {
        return new Promise((resolve, reject) => {
            let getGameConfigRequest = new Message();
            getGameConfigRequest.setRequest("getGameData");
            getGameConfigRequest.addParam(
                "playId",
                current_play ? "current" : null,
            );
            getGameConfigRequest.addParam("dataId", config_id);
            getGameConfigRequest.setDestination(PeerType.MASTER, "");

            this._console.sendMessage(
                getGameConfigRequest,
                (response: Message) => {
                    let gameConfigContent = response.getParam("gameData", {});
                    resolve(gameConfigContent.content || {});
                },
            );
        });
    }

    /**
     * Broadcasts a Text-to-Speech synthesis request to the Maestro peer.
     * @param sentence The text string to be spoken out loud.
     */
    public say(sentence: string) {
        let sayRequest = new Message();
        sayRequest.setRequest("sayRequest");
        sayRequest.addParam("sentence", sentence);
        sayRequest.setDestination(PeerType.MAESTRO, "");

        this._console.sendMessage(sayRequest);
    }

    /**
     * Pre-generates and caches premium TTS audio for a list of sentences.
     *
     * Call this at game startup with every line the game may speak: the console
     * synthesizes and caches each one ahead of time (nothing is played). Later
     * `say(...)` calls for those sentences then play the cached premium audio
     * instantly and offline. Sentences not pre-cached still work — they fall back
     * to on-device synthesis on first use.
     * @param texts The sentences to synthesize and cache ahead of time.
     */
    public runTtsCache(texts: string[]) {
        let cacheRequest = new Message();
        cacheRequest.setRequest("runTtsCache");
        cacheRequest.addParam("texts", texts);
        cacheRequest.setDestination(PeerType.MASTER, "");

        this._console.sendMessage(cacheRequest);
    }

    /**
     * Assigns a basic value to a registered game option via the option manager.
     * @param name The unique name of the option.
     * @param value The value to set.
     */
    public setOption(name: string, value: any) {
        this._option.setOption(name, value, null, {});
    }

    /**
     * Creates or updates an interactive slider option.
     * @param name The unique identifier for the slider.
     * @param label The display label for the UI.
     * @param value The current numeric value.
     * @param min The minimum allowed value.
     * @param max The maximum allowed value.
     * @param step The increment step size.
     */
    public createSliderOtption(
        name: string,
        label: string,
        value: number,
        min: number,
        max: number,
        step: number,
    ) {
        this._option.setOption(name, value, "slider", {
            "min": min,
            "max": max,
            "step": step,
            "label": label,
        });
    }

    /**
     * Creates or updates an interactive toggle switch option.
     * @param name The unique identifier for the switch.
     * @param label The display label for the UI.
     * @param value The current boolean state.
     */
    public createSwitchOption(name: string, label: string, value: boolean) {
        this._option.setOption(name, value, "switch", {
            "label": label,
        });
    }

    /**
     * Creates or updates a multiple-choice selection option.
     * @param name The unique identifier for the option.
     * @param label The display label for the UI.
     * @param value The currently selected choice.
     * @param choices An array of available string choices.
     */
    public createChoicesOption(
        name: string,
        label: string,
        value: string,
        choices: string[],
    ) {
        this._option.setOption(name, value, "choices", {
            "choices": choices,
            "label": label,
        });
    }

    /**
     * Registers a callback listener to trigger whenever a specific option's value changes.
     * @param name The name of the option to observe.
     * @param callback The function to execute on change.
     */
    public onOptionChanged(name: string, callback: OptionChangedCallback) {
        this._option.onOptionChanged(name, callback);
    }

    /**
     * Executes a broadcasted network request to trigger a registered custom callback.
     * @param callbackName The unique registered name of the custom callback.
     * @param args Dictionary of arguments to pass to the callback.
     */
    public run(callbackName: string, args: { [key: string]: any }) {
        this._callbacks.runCustomCallback(callbackName, args);
    }

    /**
     * Registers a local function to listen for network execution of a custom callback.
     * @param callbackName The identifier for this callback.
     * @param callback The local function to execute.
     */
    public on(
        callbackName: string,
        callback: (args: { [key: string]: any }) => void,
    ): string {
        return this._callbacks.registerCustomCallback(callbackName, callback);
    }

    /**
     * Who is playing on which controller.
     *
     * Tracks the resident bound to each address, keeps a binding number that
     * counts up when a controller changes hands, and builds the telemetry rows
     * from a game's own numbers. Games used to do this themselves and got it
     * wrong the same two ways: keying on the name (which an animator can retype
     * mid-game, losing a resident her score) and dropping `resident.id`.
     */
    public get participants(): ParticipantRegistry {
        return this._participants;
    }

    /**
     * Fires when a controller changes hands — a resident leaves, another sits
     * down, and the animator re-associates the controller.
     *
     * A game cannot see this any other way: re-associating is a rename on the
     * console side, and nothing went out when it happened before
     * `KOPPELIA_0.19.2`. Without it a game keeps crediting whoever was bound when
     * the controller last connected.
     *
     * @returns A subscription id to pass to `unsubscribeCallback`.
     */
    public onDeviceResidentChanged(
        callback: (device: Device) => void,
    ): string {
        return this._onDeviceConnNotification(
            callback,
            "deviceResidentNotification",
        );
    }

    /**
     * Reports per-participant results for the current session.
     *
     * **Emit as you go, not only at the end.** `closeGame` does not warn the
     * game — filarmonic notifies Spectakle and then kills the container, and the
     * SDK has no close hook — so a game that saves everything for the last
     * moment loses everything to a power cut. Reporting after each round costs
     * at most the last round.
     *
     * **Always send cumulative state, never a delta.** "8 correct so far", not
     * "+1 this round". Each call REPLACES the participant's row (the console
     * upserts on the participant key), so a delta would overwrite the history
     * instead of extending it.
     *
     * The console attaches the session, resolves the resident from the peer
     * table when the game did not supply one, and closes the session itself.
     *
     * `options.activity` names WHICH activity these results belong to. Where an
     * activity ends is a property of the game: a fresh route on a bike is a new
     * one with its own effort and duration, a round of a quiz is not. Naming a
     * different activity than the last report closes the current session and
     * opens the next; naming the same one changes nothing, and a game that names
     * none keeps one session per launch.
     *
     * It is a NAME, not a command, and that is deliberate: like everything else
     * here it survives being replayed, duplicated by a second peer, or lost —
     * the next report still carries it. Cumulative state restarts with each
     * activity, and so does the session payload, which is not carried over.
     *
     * @param participants One entry per participant. Sending an unchanged entry
     * again is harmless — same key, same row.
     */
    public reportResults(
        participants: ParticipantResult[],
        options: { activity?: string } = {},
    ): void {
        if (participants.length === 0) return;
        let request = new Message();
        request.setRequest("reportResults");
        request.addParam("participants", participants.map(serializeParticipant));
        // Same default as `reportSession`. The two used to differ, and it only
        // held because every game happens to send the session first: a game that
        // reported results ALONE would have lost the boundary, silently.
        request.addParam("activity", options.activity ?? this.__resolveActivity());
        request.setDestination(PeerType.MASTER, "");
        this._console.sendMessage(request);
    }

    /**
     * Reports collective context for the current session — what belongs to the
     * game as a whole rather than to any one player: difficulty, theme, number
     * of rounds.
     *
     * Cumulative like {@link reportResults}: each call replaces the session
     * payload. Do NOT put per-player data here; it would not reach any resident's
     * history.
     *
     * `participant_count` is deliberately NOT part of this call. The console
     * derives it from the results it actually received, so it cannot disagree
     * with them.
     */
    public reportSession(
        payload: { [key: string]: any },
        options: { activity?: string } = {},
    ): void {
        let request = new Message();
        request.setRequest("reportSession");
        request.addParam("payload", payload);
        // The CURRENT activity travels by default. Without it, a game offering
        // "Rejouer" inside the same container launch reported a second game into
        // the first game's session — and because reports are cumulative and
        // upserted, the second game's smaller numbers REPLACED the first's. A
        // resident who scored 18, replayed, and scored 4 finished the afternoon
        // at 4 on her sheet. See `startNewActivity`.
        // Sans garde, comme `reportResults` : `currentActivity` ne peut plus être
        // undefined depuis que le lancement compte comme `partie-1`.
        request.addParam("activity", options.activity ?? this.__resolveActivity());
        request.setDestination(PeerType.MASTER, "");
        this._console.sendMessage(request);
    }

    /**
     * Declare that a new game has started inside the same container launch.
     *
     * A telemetry session is one LAUNCH of a game container, and it closes at
     * `closeGame`. "Rejouer" does not restart the container: the game resets its
     * own counters and keeps reporting into the session that is already open. As
     * reports are cumulative and upserted on `(session, participant_key)`, the
     * fresh, smaller numbers overwrite what the previous game earned.
     *
     * Naming a new activity closes the current session and opens the next one,
     * so each game keeps its own rows. Call it wherever a game returns to its
     * home screen or otherwise zeroes what it has been counting — the same place
     * the counters are reset.
     *
     * The counter lives in the SHARED state, so a tablet reload does not restart
     * the numbering and merge two games into one. It is kept under a reserved key
     * that `setState` and `init` preserve, because half the catalogue resets its
     * whole state on "Rejouer" and would otherwise erase the boundary it just
     * drew.
     */
    public startNewActivity(): string {
        const next = this.__activityCount() + 1;
        this._state.updateState({ [ACTIVITY_STATE_KEY]: next });
        return `partie-${next}`;
    }

    /**
     * Ask for a boundary that lands only once the game's own state has moved on.
     *
     * For a game that reports from an explicit event — a round closing, a point
     * scored — `startNewActivity()` is enough. For a game that reports from a
     * SUBSCRIBER to the shared state, it is a trap: writing the counter wakes the
     * subscriber in the same tick, and what it reads is still the game being
     * closed. The first report under the new name then carries the OLD game.
     *
     * Two games hit this independently and each wrote its own fingerprint dance
     * to work around it — one of which did not actually work, because it reset
     * its counters before waking the subscriber, so the "unchanged payload" it
     * was watching for had already changed. That is the argument for the
     * mechanism living here.
     *
     * The rule is simple and does not depend on what a payload looks like: the
     * boundary lands on the first report that arrives AFTER a state update the
     * game did not make itself — i.e. after the monitor has actually restarted.
     * Until then `currentActivity` keeps returning the old name, so a stray
     * report files the closed game where it belongs.
     */
    public requestNewActivity(): void {
        this.__activityPending = true;
        this.__activityStateSeen = this.__stateRevision;
    }

    /**
     * Called by the reporting path. Returns the activity to use, and lands a
     * pending boundary once the state has genuinely moved.
     */
    private __resolveActivity(): string {
        if (this.__activityPending && this.__stateRevision !== this.__activityStateSeen) {
            this.__activityPending = false;
            this.startNewActivity();
        }
        return this.currentActivity;
    }

    /**
     * The activity name currently in force. NEVER undefined — and that is the
     * whole point.
     *
     * The console's contract (`State.rotate_activity`) is that the FIRST name it
     * ever hears LABELS the session the launch already opened; it does not ask
     * for a new one. That is right for video-bike, which names every route
     * including the first.
     *
     * So a game whose first game is anonymous wastes its first name: the first
     * `startNewActivity()` after "Rejouer" would emit the first name filarmonic
     * ever sees, get treated as a label, and rotate nothing. The replay would
     * still overwrite the game before it — the exact bug the boundary exists to
     * fix, still present and now harder to see.
     *
     * The launch therefore counts as `partie-1` from its very first report, and
     * the first `startNewActivity()` returns `partie-2`, which is the first
     * ROTATION. The counter starts at one because the first game is a game.
     */
    public get currentActivity(): string {
        return `partie-${this.__activityCount()}`;
    }

    private __activityCount(): number {
        const raw = (get(this._state.state) as AnyState)?.[ACTIVITY_STATE_KEY];
        const count = Number(raw);
        return Number.isFinite(count) && count >= 1 ? count : 1;
    }

    /**
     * Unregisters a locally listening custom callback.
     * @param callbackName The name of the callbacks to remove.
     */
    public unsub(callbackName: string) {
        this._callbacks.unregisterCustomCallback(callbackName);
    }

    /**
     * Unregisters a locally listening custom callback using its unique ID
     * @param callbackId The identifier of the callback to remove.
     */
    public unsubById(callbackId: string) {
        this._callbacks.unregisterById(callbackId);
    }
}
