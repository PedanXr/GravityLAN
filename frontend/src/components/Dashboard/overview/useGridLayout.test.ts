import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { GridStack } from 'gridstack';
import type { Device, DeviceGroup } from '../../../types';
import { api } from '../../../api/client';
import { useGridLayout } from './hooks';

vi.mock('gridstack', () => ({ GridStack: { init: vi.fn() } }));
vi.mock('../../../api/client', () => ({ api: { updateDevice: vi.fn() }, createScanSocket: vi.fn() }));

type Handler = (...args: unknown[]) => unknown;
type FakeGrid = ReturnType<typeof makeGrid>;

function makeGrid() {
  const handlers: Record<string, Handler> = {};
  return {
    handlers,
    on: vi.fn((event: string, fn: Handler) => { handlers[event] = fn; }),
    destroy: vi.fn(), batchUpdate: vi.fn(), compact: vi.fn(), float: vi.fn(),
    removeWidget: vi.fn(), makeWidget: vi.fn(),
  };
}

const gridInit = vi.mocked(GridStack.init);
const updateDevice = vi.mocked(api.updateDevice);
let grids: FakeGrid[];

const groups = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] as DeviceGroup[];

function device(id: number, over: Partial<Device> = {}): Device {
  return { id, group_id: 1, x: 0, y: 0, w: 3, h: 3, ...over } as unknown as Device;
}

function tile(id: number, node?: object) {
  const el = document.createElement('div');
  el.setAttribute('gs-id', String(id));
  return Object.assign(el, { gridstackNode: node });
}

function options(over: Partial<Parameters<typeof useGridLayout>[0]> = {}) {
  return {
    devices: [device(1), device(2, { group_id: 2 }), device(3, { group_id: null })],
    setDevices: vi.fn(),
    groups,
    isLoading: false,
    isEditMode: false,
    isMobile: false,
    viewMode: 'grid' as const,
    collapsedGroups: new Set<string | number>(),
    loadData: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

const gridFor = (id: string) => grids[gridInit.mock.calls.findIndex(([, el]) => (el as HTMLElement).classList.contains(`grid-stack-${id}`))];

beforeEach(() => {
  vi.clearAllMocks();
  grids = [];
  gridInit.mockImplementation(() => { const g = makeGrid(); grids.push(g); return g as never; });
  updateDevice.mockResolvedValue({} as never);
  for (const id of ['1', '2', 'null']) {
    const el = document.createElement('div');
    el.className = `grid-stack grid-stack-${id}`;
    document.body.appendChild(el);
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useGridLayout', () => {
  it('starts no grids in the list view, while loading or without devices', () => {
    renderHook(() => useGridLayout(options({ viewMode: 'list' })));
    renderHook(() => useGridLayout(options({ isLoading: true })));
    renderHook(() => useGridLayout(options({ devices: [] })));
    expect(gridInit).not.toHaveBeenCalled();
  });

  it('starts a static grid for every expanded group with a container', () => {
    document.querySelector('.grid-stack-2')!.remove();
    renderHook(() => useGridLayout(options({ collapsedGroups: new Set(['null']) })));

    expect(gridInit).toHaveBeenCalledTimes(1);
    const [opts, el] = gridInit.mock.calls[0];
    expect((el as HTMLElement).classList.contains('grid-stack-1')).toBe(true);
    expect(opts).toMatchObject({ column: 12, cellHeight: 50, staticGrid: true, alwaysShowResizeHandle: false, float: true, acceptWidgets: true });
  });

  it('uses one column on phones and editable grids in edit mode', () => {
    renderHook(() => useGridLayout(options({ isMobile: true, isEditMode: true })));
    expect(gridInit.mock.calls[0][0]).toMatchObject({ column: 1, cellHeight: 'auto', staticGrid: false, alwaysShowResizeHandle: true });
  });

  it('compacts a group once when it has tiles without a position', () => {
    renderHook(() => useGridLayout(options({ devices: [device(1, { x: null }), device(2, { group_id: 2 })] })));
    expect(gridFor('1').compact).toHaveBeenCalledTimes(1);
    expect(gridFor('1').batchUpdate).toHaveBeenCalledWith(false);
    expect(gridFor('2').compact).not.toHaveBeenCalled();
  });

  it('does not compact new tiles in edit mode', () => {
    renderHook(() => useGridLayout(options({ isEditMode: true, devices: [device(1, { x: null })] })));
    expect(gridFor('1').compact).not.toHaveBeenCalled();
  });

  it('saves moved and resized tiles in edit mode', () => {
    const opts = options({ isEditMode: true });
    renderHook(() => useGridLayout(opts));
    const grid = gridFor('1');

    grid.handlers.dragstop(new Event('dragstop'), tile(1, { x: 4, y: 2, w: 3, h: 3 }));
    expect(updateDevice).toHaveBeenCalledWith(1, { x: 4, y: 2, w: 3, h: 3 });
    const update = vi.mocked(opts.setDevices).mock.calls[0][0] as (prev: Device[]) => Device[];
    expect(update([device(1), device(9)])).toEqual([device(1, { x: 4, y: 2 }), device(9)]);

    grid.handlers.resizestop(new Event('resizestop'), tile(1, { x: 4, y: 2, w: 6, h: undefined }));
    expect(updateDevice).toHaveBeenLastCalledWith(1, { x: 4, y: 2, w: 6, h: undefined });
    const resize = vi.mocked(opts.setDevices).mock.calls[1][0] as (prev: Device[]) => Device[];
    expect(resize([device(1)])[0]).toMatchObject({ w: 6, h: null });

    grid.handlers.dragstop(new Event('dragstop'), tile(0, { x: 1 }));
    grid.handlers.dragstop(new Event('dragstop'), tile(1));
    expect(updateDevice).toHaveBeenCalledTimes(2);
  });

  /** GridStack moves a tile dropped from another group into the target grid's DOM. */
  function dropInto(target: string, source: string, el: HTMLElement, pos: object) {
    document.querySelector(`.grid-stack-${target}`)!.appendChild(el);
    const home = document.querySelector(`.grid-stack-${source}`) as HTMLElement;
    return gridFor(target).handlers.dropped(new Event('dropped'), { grid: { el: home, makeWidget: grids[0].makeWidget } }, { el, ...pos });
  }

  it('moves a tile dropped into another group there and hands its element back to React', async () => {
    const opts = options({ isEditMode: true });
    renderHook(() => useGridLayout(opts));

    const dropped = tile(5);
    await dropInto('null', '1', dropped, { x: 0, y: 1, w: 3, h: 2 });
    // React rendered the tile in group 1; it must find it there again to move the card itself
    expect(gridFor('null').removeWidget).toHaveBeenCalledWith(dropped, false);
    expect(dropped.parentElement).toBe(document.querySelector('.grid-stack-1'));
    expect(dropped.style.display).toBe('none');
    expect(updateDevice).toHaveBeenCalledWith(5, { group_id: null, x: 0, y: 1, w: 3, h: 2 });
    await waitFor(() => expect(opts.loadData).toHaveBeenCalledWith(true));

    await dropInto('2', 'null', tile(6), { x: 2, y: 0, w: 4, h: 5 });
    expect(updateDevice).toHaveBeenLastCalledWith(6, { group_id: 2, x: 2, y: 0, w: 4, h: 5 });
  });

  it('puts a dropped tile back into its group when the move cannot be saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    updateDevice.mockRejectedValueOnce(new Error('offline'));
    const opts = options({ isEditMode: true });
    renderHook(() => useGridLayout(opts));

    const dropped = tile(5);
    await dropInto('2', '1', dropped, { x: 0, y: 0, w: 3, h: 3 });
    expect(dropped.parentElement).toBe(document.querySelector('.grid-stack-1'));
    expect(dropped.style.display).toBe('');
    expect(grids[0].makeWidget).toHaveBeenCalledWith(dropped);
    expect(opts.loadData).not.toHaveBeenCalled();
  });

  it('changes nothing outside edit mode', async () => {
    const opts = options();
    renderHook(() => useGridLayout(opts));
    const grid = gridFor('1');
    grid.handlers.dragstop?.(new Event('dragstop'), tile(1, { x: 4, y: 2, w: 3, h: 3 }));
    grid.handlers.resizestop?.(new Event('resizestop'), tile(1, { x: 4, y: 2, w: 3, h: 3 }));
    await grid.handlers.added?.(new Event('added'), [{ el: tile(1), x: 0, y: 0, w: 1, h: 1 }]);
    await grid.handlers.dropped?.(new Event('dropped'), { grid: { el: document.body } }, { el: tile(1), x: 0, y: 0, w: 1, h: 1 });
    expect(updateDevice).not.toHaveBeenCalled();
    expect(opts.setDevices).not.toHaveBeenCalled();
  });

  it('rebuilds the grids when edit mode changes and destroys them on unmount', () => {
    const { rerender, unmount } = renderHook((p) => useGridLayout(p), { initialProps: options() });
    const first = [...grids];
    rerender(options({ isEditMode: true }));
    expect(first.every((g) => g.destroy.mock.calls[0]?.[0] === false)).toBe(true);
    expect(grids).toHaveLength(6);

    unmount();
    expect(grids.slice(3).every((g) => g.destroy.mock.calls.length === 1)).toBe(true);
  });

  it('ignores a grid that fails to destroy', () => {
    const { unmount } = renderHook(() => useGridLayout(options()));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    grids[0].destroy.mockImplementation(() => { throw new Error('gone'); });
    expect(() => unmount()).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(grids[1].destroy).toHaveBeenCalled();
  });

  it('compacts every grid on demand', () => {
    const { result } = renderHook(() => useGridLayout(options()));
    result.current.compactAll();
    for (const g of grids) {
      expect(g.float.mock.calls).toEqual([[false], [true]]);
      expect(g.compact).toHaveBeenCalled();
    }
  });
});
