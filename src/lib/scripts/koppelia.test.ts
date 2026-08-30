import { describe, it, expect, vi, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { Koppelia } from './koppelia.js';
import { PeerType } from './message.js';
import { routeType } from '../stores/routeStore.js';
import { MockWebSocket } from '../../test/setup.js';

const socketOf = () => MockWebSocket.instances.at(-1)!;
const lastSent = () => socketOf().lastSentObject;
const sentExecs = () => socketOf().sent.map((s) => JSON.parse(s).request.exec);

/** Answer the most recent outbound request by echoing its id back with params. */
function respond(params: Record<string, unknown>) {
	const id = lastSent().header.id;
	socketOf().emitMessage({ header: { id, from: 'master', type: 'response' }, request: { params } });
}

/** Answer a specific outbound request by name — `respond` only reaches the last
 *  one, and opening the socket fires several at once (identify, getDevices,
 *  getState, getGameOptions). */
function respondTo(exec: string, params: Record<string, unknown>) {
	const sent = socketOf().sent.map((s) => JSON.parse(s));
	const target = sent.filter((m) => m.request?.exec === exec).at(-1);
	if (target === undefined) throw new Error(`no outbound ${exec} to answer`);
	socketOf().emitMessage({
		header: { id: target.header.id, from: 'master', type: 'response' },
		request: { params }
	});
}

/** Simulate an inbound server-initiated request (drives onRequest handlers). */
function emitRequest(exec: string, params: Record<string, unknown>, from = 'master', from_addr = '') {
	socketOf().emitMessage({ header: { type: 'request', from, from_addr }, request: { exec, params } });
}

beforeEach(() => {
	MockWebSocket.reset();
	routeType.set('');
	(Koppelia as unknown as { _instance: Koppelia | undefined })._instance = undefined;
});

describe('Koppelia singleton', () => {
	it('returns the same instance every time', () => {
		expect(Koppelia.instance).toBe(Koppelia.instance);
	});

	it('is not ready until the socket opens', () => {
		const k = Koppelia.instance;
		expect(k.ready).toBe(false);
		socketOf().emitOpen();
		expect(k.ready).toBe(true);
	});
});

describe('Koppelia media + state', () => {
	it('getMediaLink resolves through the console', () => {
		expect(Koppelia.instance.getMediaLink('/media/x')).toBe('http://localhost:8000/media/x');
	});

	it('updateState merges into the shared store', () => {
		const k = Koppelia.instance;
		k.updateState({ a: 1 });
		expect(get(k.state)).toMatchObject({ a: 1 });
	});

	it('setState can force a full broadcast instead of a diff', () => {
		// Le diff est calculé contre la dernière valeur VUE, écho compris : un
		// A→B→A plus rapide que l'aller-retour se diffait à « rien » et ne
		// partait jamais, laissant les autres pairs sur B pour de bon.
		const k = Koppelia.instance;
		k.updateState({ a: 1 });
		k.setState({ a: 1, b: 2 }, true);
		expect(get(k.state)).toMatchObject({ a: 1, b: 2 });
	});

	it('setState overwrites the shared store', () => {
		const k = Koppelia.instance;
		k.updateState({ a: 1 });
		k.setState({ b: 2 });
		expect(get(k.state)).toEqual({ b: 2 });
	});
});

describe('Koppelia stage control', () => {
	it('goto sends a changeStage request', () => {
		Koppelia.instance.goto('game');
		expect(lastSent().request.exec).toBe('changeStage');
		expect(lastSent().request.params.stage).toBe('game');
	});

	it('getCurrentStage defaults to home', () => {
		expect(Koppelia.instance.getCurrentStage()).toBe('home');
	});

	it('init registers stages on the monitor when the socket opens', () => {
		routeType.set('monitor');
		const k = Koppelia.instance;
		k.init({ score: 0 }, ['home', 'game', 'end']);
		socketOf().emitOpen();
		expect(sentExecs()).toContain('initStages');
	});

	it('init does not register stages on the controller', () => {
		routeType.set('controller');
		const k = Koppelia.instance;
		k.init({ score: 0 }, ['home', 'game']);
		socketOf().emitOpen();
		expect(sentExecs()).not.toContain('initStages');
	});
});

describe('Koppelia async fetchers', () => {
	it('getDevices resolves hydrated Device instances', async () => {
		const k = Koppelia.instance;
		const p = k.getDevices();
		expect(lastSent().request.exec).toBe('getDevices');
		respond({ devices: [{ address: 'aa', color: { r: 0, g: 0, b: 0 }, name: 'Pad' }] });
		const devices = await p;
		expect(devices).toHaveLength(1);
		expect(devices[0].address).toBe('aa');
		expect(devices[0].name).toBe('Pad');
	});

	it('tells the participant registry about controllers already connected', async () => {
		// The registry only ever hears about controllers that connect or are
		// re-bound AFTER it exists, and in a residence every controller is paired
		// long before a game is launched. Untracked, an address gets binding 1 and
		// no resident — and the next hand-over files the new resident into the
		// SAME row, which is the collision the participant key exists to prevent.
		const k = Koppelia.instance;
		routeType.set('monitor');
		socketOf().emitOpen();

		expect(sentExecs()).toContain('getDevices');
		respondTo('getDevices', {
			devices: [
				{
					address: 'aa',
					color: { r: 0, g: 0, b: 0 },
					name: 'Pad',
					resident: { id: 'res-1' },
					isAssociatedToResident: true
				}
			]
		});
		// A macrotask, not two microtask turns: the reply crosses the request
		// correlation, the promise, and the `.then` that tracks.
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(k.participants.residentFor('aa')).toBe('res-1');

		// And now the hand-over the seeding makes visible: a second resident on
		// the same controller opens her own row instead of overwriting the first.
		emitRequest('deviceResidentNotification', {
			device: { address: 'aa', resident: { id: 'res-2' }, isAssociatedToResident: true }
		});
		expect(k.participants.keyFor('aa')).toBe('aa#b2');
	});

	it('does not let a stale snapshot count a binding towards the resident who left', async () => {
		// `getDevices` answers with what was true when it was asked. A rebind
		// landing between the request and its reply is NEWER; replaying the
		// snapshot over it would move the binding back to the previous resident.
		const k = Koppelia.instance;
		routeType.set('monitor');
		socketOf().emitOpen();

		// The rebind arrives first — the registry now knows res-2 on binding 1.
		emitRequest('deviceResidentNotification', {
			device: { address: 'aa', resident: { id: 'res-2' }, isAssociatedToResident: true }
		});

		// ...and only then the (stale) snapshot, still showing res-1.
		respondTo('getDevices', {
			devices: [
				{
					address: 'aa',
					color: { r: 0, g: 0, b: 0 },
					name: 'Pad',
					resident: { id: 'res-1' },
					isAssociatedToResident: true
				}
			]
		});
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(k.participants.residentFor('aa')).toBe('res-2');
		expect(k.participants.keyFor('aa')).toBe('aa#b1');
	});

	it('getResidents without args sends no pagination params', async () => {
		const k = Koppelia.instance;
		const p = k.getResidents();
		expect(lastSent().request.params.getRaw).toBeUndefined();
		respond({ residents: { r1: { name: 'Al', id: 'r1', image: 'a.png', residence_id: 're' } } });
		const residents = await p;
		expect(residents).toHaveLength(1);
		expect(residents[0].name).toBe('Al');
	});

	it('getResidents with pagination sends count/index/findWord', async () => {
		const k = Koppelia.instance;
		const p = k.getResidents(10, 20, 'bob');
		expect(lastSent().request.params).toMatchObject({
			getRaw: false,
			count: 10,
			index: 20,
			findWord: 'bob'
		});
		respond({ residents: {} });
		await p;
	});

	it('getSongById resolves a Song', async () => {
		const k = Koppelia.instance;
		const p = k.getSongById('s1');
		expect(lastSent().request.params.songId).toBe('s1');
		respond({ song: { id: 's1', name: 'La Mer' } });
		const song = await p;
		expect(song.id).toBe('s1');
		expect(song.name).toBe('La Mer');
	});

	it('getCurrentPlay resolves a Play with its id', async () => {
		const k = Koppelia.instance;
		const p = k.getCurrentPlay();
		respond({ play: { name: 'P', game_id: 'g' }, playId: 'p9' });
		const play = await p;
		expect(play.id).toBe('p9');
		expect(play.name).toBe('P');
	});

	it('getCurrentPlays resolves a list of Plays', async () => {
		const k = Koppelia.instance;
		const p = k.getCurrentPlays();
		respond({ plays: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }] });
		const plays = await p;
		expect(plays.map((x) => x.id)).toEqual(['p1', 'p2']);
	});

	it('getCurrentPlaySongs resolves a map keyed by song id', async () => {
		const k = Koppelia.instance;
		const p = k.getCurrentPlaySongs();
		respond({ songs: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }] });
		const songs = await p;
		expect(Object.keys(songs).sort()).toEqual(['s1', 's2']);
	});

	it('runApiFunction forwards name + args and resolves the result', async () => {
		const k = Koppelia.instance;
		const p = k.runApiFunction('sum', { a: '1' });
		expect(lastSent().request.params).toMatchObject({ functionName: 'sum', args: { a: '1' } });
		respond({ result: 42 });
		expect(await p).toBe(42);
	});

	it('getGameConfig resolves the stored content', async () => {
		const k = Koppelia.instance;
		const p = k.getGameConfig('cfg', true);
		expect(lastSent().request.params).toMatchObject({ playId: 'current', dataId: 'cfg' });
		respond({ gameData: { content: { level: 3 } } });
		expect(await p).toEqual({ level: 3 });
	});
});

describe('Koppelia fire-and-forget requests', () => {
	it('writeGameConfig sends setGameData bound to the current play', () => {
		Koppelia.instance.writeGameConfig('cfg', { a: 1 });
		expect(lastSent().request.exec).toBe('setGameData');
		expect(lastSent().request.params).toMatchObject({ playId: 'current', dataId: 'cfg', content: { a: 1 } });
	});

	it('writeGameConfig can decouple from the current play', () => {
		Koppelia.instance.writeGameConfig('cfg', { a: 1 }, false);
		expect(lastSent().request.params.playId).toBeNull();
	});

	it('say targets the maestro peer', () => {
		Koppelia.instance.say('bonjour');
		expect(lastSent().request.exec).toBe('sayRequest');
		expect(lastSent().header.to).toBe(PeerType.MAESTRO);
		expect(lastSent().request.params.sentence).toBe('bonjour');
	});

	it('runTtsCache forwards the sentence list to the master', () => {
		Koppelia.instance.runTtsCache(['a', 'b']);
		expect(lastSent().request.exec).toBe('runTtsCache');
		expect(lastSent().request.params.texts).toEqual(['a', 'b']);
	});

	it('openCreateResident forwards context params to the master', () => {
		Koppelia.instance.openCreateResident({ gameId: 'g7' });
		expect(lastSent().request.exec).toBe('openCreateResident');
		expect(lastSent().header.to).toBe(PeerType.MASTER);
		expect(lastSent().request.params.gameId).toBe('g7');
	});
});

describe('Koppelia options', () => {
	it('setOption sends a plain setGameOption', () => {
		Koppelia.instance.setOption('speed', 3);
		expect(lastSent().request.exec).toBe('setGameOption');
		expect(lastSent().request.params).toMatchObject({ name: 'speed', value: 3, type: null });
	});

	it('createSliderOtption carries slider config', () => {
		Koppelia.instance.createSliderOtption('vol', 'Volume', 5, 0, 10, 1);
		expect(lastSent().request.params).toMatchObject({
			name: 'vol',
			value: 5,
			type: 'slider',
			config: { min: 0, max: 10, step: 1, label: 'Volume' }
		});
	});

	it('createSwitchOption carries switch config', () => {
		Koppelia.instance.createSwitchOption('mute', 'Mute', true);
		expect(lastSent().request.params).toMatchObject({ type: 'switch', config: { label: 'Mute' } });
	});

	it('createChoicesOption carries the choices list', () => {
		Koppelia.instance.createChoicesOption('mode', 'Mode', 'easy', ['easy', 'hard']);
		expect(lastSent().request.params.config).toMatchObject({ choices: ['easy', 'hard'], label: 'Mode' });
	});

	it('onOptionChanged fires on a matching notification', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onOptionChanged('vol', cb);
		emitRequest('gameOptionNotification', { name: 'vol', value: { value: 8 } });
		expect(cb).toHaveBeenCalledWith({ value: 8 });
	});
});

describe('Koppelia custom callbacks', () => {
	it('run broadcasts a DATA_EXCHANGE, on receives it', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.on('act', cb);
		// Simulate the broadcast coming back over the wire.
		socketOf().emitMessage({
			header: { type: 'data_exchange', from: 'controller' },
			data: { customCallbackName: 'act', customCallbackArgs: { n: 5 } }
		});
		expect(cb).toHaveBeenCalledWith({ n: 5 });
	});

	it('run sends the callback name and args on the wire', () => {
		Koppelia.instance.run('act', { n: 1 });
		expect(lastSent().data.customCallbackName).toBe('act');
		expect(lastSent().data.customCallbackArgs).toEqual({ n: 1 });
	});

	it('unsub stops a listener from firing', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.on('act', cb);
		k.unsub('act');
		socketOf().emitMessage({
			header: { type: 'data_exchange', from: 'x' },
			data: { customCallbackName: 'act', customCallbackArgs: {} }
		});
		expect(cb).not.toHaveBeenCalled();
	});
});

describe('Koppelia resident + device notifications', () => {
	it('onResidentCreated hydrates and forwards the new resident', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onResidentCreated(cb);
		emitRequest('residentCreated', {
			resident: { name: 'Al', id: 'r1', image: 'a.png', residence_id: 're' }
		});
		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0].name).toBe('Al');
	});

	it('onCreateResidentClosed fires on the close request', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onCreateResidentClosed(cb);
		emitRequest('closeCreateResident', {});
		expect(cb).toHaveBeenCalledOnce();
	});

	it('onDeviceConnectedNotification hydrates the connected device', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onDeviceConnectedNotification(cb);
		emitRequest('deviceConnectionNotification', {
			device: { address: 'aa', color: { r: 0, g: 0, b: 0 }, name: 'Pad' }
		});
		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0].address).toBe('aa');
	});
});

describe('Koppelia growable elements', () => {
	it('registerNewGrowableElement registers on the controller and fires on notification', async () => {
		routeType.set('controller');
		const k = Koppelia.instance;
		const cb = vi.fn();
		await k.registerNewGrowableElement('g1', cb);
		expect(sentExecs()).toContain('addGrowableElement');
		emitRequest('gowableElementNotification', { id: 'g1', grown: true });
		expect(cb).toHaveBeenCalledWith(true);
	});

	it('updateGrowableElement sends the grown state and resolves', async () => {
		const k = Koppelia.instance;
		const p = k.updateGrowableElement('g1', true);
		expect(lastSent().request.exec).toBe('updateGrowableElement');
		expect(lastSent().request.params).toMatchObject({ id: 'g1', grown: true });
		respond({});
		await expect(p).resolves.toBeUndefined();
	});
});

describe('Koppelia misc API', () => {
	it('fixMediaUrl rebases onto the console host', () => {
		expect(Koppelia.instance.fixMediaUrl('http://o:1/media/a?x=1')).toBe(
			'http://localhost:8000/media/a?x=1'
		);
	});

	it('onReady fires once the socket opens', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onReady(cb);
		socketOf().emitOpen();
		expect(cb).toHaveBeenCalledOnce();
	});

	it('getResizableTexts resolves the registered list', async () => {
		const k = Koppelia.instance;
		const p = k.getResizableTexts();
		respond({ resizableTexts: [{ id: 't1' }] });
		expect(await p).toEqual([{ id: 't1' }]);
	});

	it('unsubById stops a custom callback from firing', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		const id = k.on('act', cb);
		k.unsubById(id);
		socketOf().emitMessage({
			header: { type: 'data_exchange', from: 'x' },
			data: { customCallbackName: 'act', customCallbackArgs: {} }
		});
		expect(cb).not.toHaveBeenCalled();
	});

	it('onDeviceDisconnectedNotification hydrates the device', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onDeviceDisconnectedNotification(cb);
		emitRequest('deviceDisconnectionNotification', {
			device: { address: 'zz', color: { r: 0, g: 0, b: 0 }, name: 'Gone' }
		});
		expect(cb).toHaveBeenCalledOnce();
		expect(cb.mock.calls[0][0].address).toBe('zz');
	});
});

describe('Koppelia resizable text (monitor-gated)', () => {
	it('registers resizable text only on the monitor', async () => {
		routeType.set('monitor');
		await Koppelia.instance.registerNewResizableText('title', 40);
		expect(sentExecs()).toContain('addResizableText');
	});

	it('does not register resizable text on the controller', async () => {
		routeType.set('controller');
		await Koppelia.instance.registerNewResizableText('title', 40);
		expect(sentExecs()).not.toContain('addResizableText');
	});

	it('onResizableTextChanged fires for the matching id', () => {
		const k = Koppelia.instance;
		const cb = vi.fn();
		k.onResizableTextChanged('title', cb);
		emitRequest('resizableTextNotification', { id: 'title', fontSize: 24 });
		expect(cb).toHaveBeenCalledWith(24);
	});
});

describe('activity boundaries — "Rejouer" must not overwrite the game before it', () => {
	it('names the LAUNCH partie-1, before any replay', () => {
		// The console's contract: the first name it ever hears LABELS the session
		// the launch already opened. A game whose first game is anonymous wastes
		// its first name — the first `startNewActivity()` would be treated as a
		// label and rotate nothing, so the first "Rejouer" would still overwrite.
		const k = Koppelia.instance;
		k.reportSession({ score: 1 });
		expect(lastSent().request.params.activity).toBe('partie-1');
	});

	it('starts rotating at partie-2, which is the first real boundary', () => {
		const k = Koppelia.instance;
		expect(k.currentActivity).toBe('partie-1');
		expect(k.startNewActivity()).toBe('partie-2');
		expect(k.startNewActivity()).toBe('partie-3');
	});

	it('sends the activity with results too, not only with the session', () => {
		// The two defaults used to differ. It only held because every game sends
		// the session first; a game reporting results ALONE lost the boundary.
		const k = Koppelia.instance;
		k.startNewActivity();
		k.reportResults([{ participantKey: 'aa#b1', score: 3 }] as never);
		expect(lastSent().request.params.activity).toBe('partie-2');
	});

	it('keeps the counter when a peer force-broadcasts a whole state', () => {
		// `init` on another peer sends the full state with update=false. Without
		// preservation the counter is erased on every peer at once — and the loss
		// does not repair itself, because the console never rotates a name twice.
		const k = Koppelia.instance;
		k.startNewActivity();
		emitRequest('changeState', { state: { players: [] }, update: false }, 'monitor');
		expect(k.currentActivity).toBe('partie-2');
	});

	it('sends the current activity with every report, without being asked', () => {
		// A telemetry session is one LAUNCH of a container and closes at
		// `closeGame`. "Rejouer" does not restart the container, so a second game
		// reported into the same session — and because reports are cumulative and
		// upserted, its smaller numbers REPLACED the first game's. A resident who
		// scored 18, replayed and scored 4 finished the afternoon at 4.
		const k = Koppelia.instance;
		k.reportSession({ score: 18 });
		expect(lastSent().request.params.activity).toBe('partie-1');

		k.startNewActivity();
		k.reportSession({ score: 4 });
		expect(lastSent().request.params.activity).toBe('partie-2');
	});

	it('survives the state reset the replay itself performs', () => {
		// Half the catalogue calls `init` or `setState` with a fresh default on
		// its home screen. If the counter went with it, the boundary just drawn
		// would be erased and the next game would report into the old session.
		const k = Koppelia.instance;
		k.startNewActivity();
		k.startNewActivity();

		k.setState({ players: [], round: 0 });

		expect(k.currentActivity).toBe('partie-3');
	});

	it('holds a requested boundary until the state actually moves', () => {
		// The trap for a game that reports from a SUBSCRIBER to the shared state:
		// writing the counter wakes the subscriber in the same tick, and what it
		// reads is still the game being closed. The first report under the new
		// name would carry the OLD game. Two games hit this independently.
		const k = Koppelia.instance;
		routeType.set('monitor');
		socketOf().emitOpen();

		k.requestNewActivity();

		// A report arriving before the monitor has restarted still belongs to the
		// game that just closed.
		k.reportSession({ score: 18 });
		expect(lastSent().request.params.activity).toBe('partie-1');

		// The monitor sends a fresh state — the restart really happened.
		emitRequest('changeState', { state: { level: 1 }, update: true }, 'monitor');

		k.reportSession({ score: 4 });
		expect(lastSent().request.params.activity).toBe('partie-2');
	});

	it('lands a held boundary on results too, not only on a session report', () => {
		const k = Koppelia.instance;
		routeType.set('monitor');
		socketOf().emitOpen();
		k.requestNewActivity();
		emitRequest('changeState', { state: { level: 1 }, update: true }, 'monitor');

		k.reportResults([{ participantKey: 'aa#b1', score: 3 }] as never);
		expect(lastSent().request.params.activity).toBe('partie-2');
	});

	it('lets a game name its own activity when it means something', () => {
		// video-bike names a route; that is more useful than "partie-3".
		const k = Koppelia.instance;
		k.reportSession({ km: 4 }, { activity: 'parcours-lac' });
		expect(lastSent().request.params.activity).toBe('parcours-lac');
	});
});
