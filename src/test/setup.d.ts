export declare class MockWebSocket {
    static instances: MockWebSocket[];
    /**
     * Whether a new socket starts already OPEN.
     *
     * A real one never does — it starts CONNECTING, which is the window games were
     * crashing in. But most tests here are about routing, not about the handshake, and
     * making all of them drive a handshake would be ceremony that tests nothing. The
     * suite that DOES care about the window turns this off.
     */
    static autoOpen: boolean;
    static reset(): void;
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 3;
    url: string;
    readyState: number;
    sent: string[];
    onclose: ((ev: {
        reason?: string;
        code?: number;
    }) => void) | null;
    private _listeners;
    constructor(url: string);
    addEventListener(type: string, cb: (ev: unknown) => void): void;
    send(data: string): void;
    /** Complete the handshake: flip to OPEN and fire 'open', like a real socket. */
    open(): void;
    close(): void;
    emitOpen(): void;
    emitMessage(data: unknown): void;
    get lastSentObject(): any;
}
export declare class MockAudio {
    src: string;
    loop: boolean;
    volume: number;
    paused: boolean;
    currentTime: number;
    duration: number;
    constructor(src: string);
    play(): Promise<void>;
    pause(): void;
}
