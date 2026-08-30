import { describe, it, expect, vi } from 'vitest';
import { Device } from './device.js';
import { MessageType, PeerType } from './message.js';
import { Message } from './message.js';
import { MicLimitError } from './errors.js';
import { makeMockConsole, asConsole } from '../../test/mockConsole.js';

describe('Device defaults and serialization', () => {
	it('exposes address and default color/name', () => {
		const d = new Device(asConsole(makeMockConsole()), 'aa:bb');
		expect(d.address).toBe('aa:bb');
		expect(d.name).toBe('');
		expect(d.color).toEqual({ r: 0, g: 0, b: 0 });
	});

	it('toObject exposes address, color and name', () => {
		const d = new Device(asConsole(makeMockConsole()), 'aa:bb');
		expect(d.toObject()).toEqual({ address: 'aa:bb', color: { r: 0, g: 0, b: 0 }, name: '' });
	});

	it('fromObject hydrates fields and attaches a resident when present', () => {
		const d = new Device(asConsole(makeMockConsole()));
		d.fromObject({
			address: 'cc:dd',
			color: { r: 1, g: 2, b: 3 },
			name: 'Pad 1',
			resident: { name: 'Alice', id: 'r1', image: 'a.png', residence_id: 'res1' }
		});
		expect(d.address).toBe('cc:dd');
		expect(d.name).toBe('Pad 1');
		expect(d.isAssociatedToResident).toBe(true);
		expect(d.resident?.name).toBe('Alice');
	});

	it('fromObject leaves resident unset when absent', () => {
		const d = new Device(asConsole(makeMockConsole()));
		d.fromObject({ address: 'cc:dd' });
		expect(d.isAssociatedToResident).toBe(false);
		expect(d.resident).toBeUndefined();
	});
});

describe('Device commands', () => {
	it('setColor updates local color and sends setColor to the device', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setColor({ r: 10, g: 20, b: 30 });

		expect(d.color).toEqual({ r: 10, g: 20, b: 30 });
		const msg = mock.sentWithExec('setColor').at(-1)!;
		expect(msg.header.to).toBe(PeerType.DEVICE);
		expect(msg.header.to_addr).toBe('aa');
		expect(msg.getParam('color')).toEqual({ r: 10, g: 20, b: 30 });
	});

	it('vibrate without blink sends a single cycle', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.vibrate(500);
		expect(mock.sentWithExec('vibrate').at(-1)!.getParam('vibration')).toEqual({
			v: 500,
			toff: 0,
			c: 1
		});
	});

	it('vibrate with blink carries off-time and cycle count', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.vibrate(500, true, 100, 3);
		expect(mock.sentWithExec('vibrate').at(-1)!.getParam('vibration')).toEqual({
			v: 500,
			toff: 100,
			c: 3
		});
	});

	it('setColorSequence forwards the sequence and reset flag', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setColorSequence(['red', 'blue'], true);
		const msg = mock.sentWithExec('setColorSequence').at(-1)!;
		expect(msg.getParam('sequence')).toEqual(['red', 'blue']);
		expect(msg.getParam('reset')).toBe(true);
	});

	it('setMicConfig only includes optional fields when provided', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setMicConfig({ volume: 80 });
		const bare = mock.sentWithExec('setMicConfig').at(-1)!;
		expect(bare.getParam('volume')).toBe(80);
		expect(bare.getParam('effect')).toBeNull();

		d.setMicConfig({ volume: 50, effect: 'echo', intensity: 3 });
		const full = mock.sentWithExec('setMicConfig').at(-1)!;
		expect(full.getParam('effect')).toBe('echo');
		expect(full.getParam('intensity')).toBe(3);
	});

	it('disableMic sends disableModule for the mic', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.disableMic();
		expect(mock.sentWithExec('disableModule').at(-1)!.getParam('module')).toBe('mic');
	});
});

describe('Device.enableMic', () => {
	it('resolves when the master accepts', async () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const p = d.enableMic();
		mock.respondLast(new Message()); // non-error response
		await expect(p).resolves.toBeUndefined();
	});

	it('rejects with MicLimitError when the master returns an error', async () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const p = d.enableMic();

		const err = new Message();
		err.setType(MessageType.ERROR);
		err.addParam('error', 'too many mics');
		mock.respondLast(err);

		await expect(p).rejects.toBeInstanceOf(MicLimitError);
		await expect(p).rejects.toThrow('too many mics');
	});
});

describe('Device hardware event subscriptions', () => {
	it('onEvent fires only for the matching event and address', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onEvent('press', cb);

		mock.trigger.deviceEvent('dev', 'aa', 'press'); // match
		mock.trigger.deviceEvent('dev', 'bb', 'press'); // wrong address
		mock.trigger.deviceEvent('dev', 'aa', 'release'); // wrong event
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('clearAllEvents actually unsubscribes what onEvent registered', () => {
		// Régression : `onEvent` renvoyait l'identifiant du handler sans le
		// ranger, si bien que `clearAllEvents()` n'avait rien à retirer. Tout jeu
		// qui recâblait ses manettes empilait un écouteur de plus par étape, et un
		// seul appui comptait autant de fois qu'il y avait d'écouteurs.
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onEvent('press', cb);
		d.clearAllEvents();

		mock.trigger.deviceEvent('dev', 'aa', 'press');
		expect(cb).not.toHaveBeenCalled();
	});

	it('re-subscribing after clearAllEvents does not stack listeners', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onEvent('press', cb);
		d.clearAllEvents();
		d.onEvent('press', cb);

		mock.trigger.deviceEvent('dev', 'aa', 'press');
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('attachEvent is sent once per event name, not on every subscription', () => {
		// Régression : `event in tableau` teste un INDEX, jamais une valeur — la
		// requête repartait à chaque abonnement et la console empile une paire
		// événement/pair par réception, sans dédoublonner.
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.onEvent('press', vi.fn());
		d.onEvent('press', vi.fn());
		d.onEvent('release', vi.fn());

		const attached = mock
			.sentWithExec('attachEvent')
			.map((message) => message.request.params.event);
		expect(attached).toEqual(['press', 'release']);
	});

	it('onCursor enables the module and forwards coordinates for its address', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onCursor(cb);

		expect(mock.sentWithExec('enableModule').at(-1)!.getParam('module')).toBe('cursor');

		mock.trigger.request('cursor', { x: 0.1, y: 0.2, a: 0.3 }, 'device', 'aa');
		expect(cb).toHaveBeenCalledWith(0.1, 0.2, 0.3);

		mock.trigger.request('cursor', { x: 9, y: 9, a: 9 }, 'device', 'zz'); // other device
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it('onBiking forwards speed for its address', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onBiking(cb);
		mock.trigger.request('biking', { speed: 12 }, 'device', 'aa');
		expect(cb).toHaveBeenCalledWith(12);
	});

	it('onRotation forwards omega for its address', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onRotation(cb);
		expect(mock.sentWithExec('enableModule').at(-1)!.getParam('module')).toBe('rot');
		mock.trigger.request('rotation', { omega: 1.5 }, 'device', 'aa');
		expect(cb).toHaveBeenCalledWith(1.5);
	});

	it('onVerticalDetector forwards the vertical flag for its address', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const cb = vi.fn();
		d.onVerticalDetector(cb);
		mock.trigger.request('verticalDetector', { value: true }, 'device', 'aa');
		expect(cb).toHaveBeenCalledWith(true);
	});

	it('clearCallback unsubscribes a cursor callback that was registered', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		const id = d.onCursor(vi.fn());
		d.clearCallback(id);
		expect(mock.unsubscribeCallback).toHaveBeenCalledWith(id);
	});

	it('clearAllCallbacks unsubscribes every registered module callback', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.onCursor(vi.fn());
		d.onBiking(vi.fn());
		d.clearAllCallbacks();
		expect(mock.unsubscribeCallback).toHaveBeenCalledTimes(2);
	});
});

describe('Device.setCursorFov', () => {
	it('sends setCursorFov to the device with both axes', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setCursorFov(90, 50);
		const msg = mock.sentWithExec('setCursorFov').at(-1)!;
		expect(msg.header.to).toBe(PeerType.DEVICE);
		expect(msg.header.to_addr).toBe('aa');
		expect(msg.getParam('fovx')).toBe(90);
		expect(msg.getParam('fovy')).toBe(50);
	});

	it('sends only the axis that is provided', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setCursorFov(90);
		const msg = mock.sentWithExec('setCursorFov').at(-1)!;
		expect(msg.getParam('fovx')).toBe(90);
		expect(msg.getParam('fovy')).toBeNull();
	});

	it('sends nothing when no axis is provided', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.setCursorFov();
		expect(mock.sentWithExec('setCursorFov')).toHaveLength(0);
	});
});

describe('Device.onCursor field of view', () => {
	it('forwards an initial FOV through setCursorFov when provided', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.onCursor(vi.fn(), 100, 70);
		const msg = mock.sentWithExec('setCursorFov').at(-1)!;
		expect(msg.getParam('fovx')).toBe(100);
		expect(msg.getParam('fovy')).toBe(70);
	});

	it('does not send a FOV when none is given', () => {
		const mock = makeMockConsole();
		const d = new Device(asConsole(mock), 'aa');
		d.onCursor(vi.fn());
		expect(mock.sentWithExec('setCursorFov')).toHaveLength(0);
	});
});
