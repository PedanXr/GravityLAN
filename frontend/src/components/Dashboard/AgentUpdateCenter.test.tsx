import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Device } from '../../types';
import { api } from '../../api/client';
import { AgentUpdateCenter } from './AgentUpdateCenter';

vi.mock('../../api/client', () => ({
  api: { deployAgent: vi.fn() },
}));
vi.mock('../Agents/ManualInstallCommand', () => ({
  ManualInstallCommand: ({ deviceId }: { deviceId: number }) => <div data-testid="manual">manual {deviceId}</div>,
}));

const m = vi.mocked(api);

function makeDevice(id: number, over: Partial<Device> = {}): Device {
  return {
    id, ip: `10.0.0.${id}`, display_name: `Box ${id}`, has_agent: true,
    agent_info: { agent_version: '0.3.0', latest_version: '0.3.5' },
    ...over,
  } as unknown as Device;
}

const devices = [
  makeDevice(1),
  makeDevice(2, { display_name: '' } as Partial<Device>),
  makeDevice(3, { agent_info: { agent_version: '0.3.5', latest_version: '0.3.5' } } as Partial<Device>),
  makeDevice(4, { has_agent: false } as Partial<Device>),
];

function renderCenter(list: Device[] = devices) {
  const handlers = { onComplete: vi.fn(), onClose: vi.fn() };
  render(<AgentUpdateCenter devices={list} {...handlers} />);
  return { ...handlers, user: userEvent.setup() };
}

function row(name: string) {
  return screen.getByText(name).closest('li') as HTMLElement;
}

async function typePassword(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('SSH Password / Key'), 'secret');
}

beforeEach(() => {
  vi.clearAllMocks();
  m.deployAgent.mockResolvedValue({ status: 'success', message: 'ok' } as never);
});

describe('AgentUpdateCenter', () => {
  it('lists only devices with an outdated agent', () => {
    renderCenter();
    expect(screen.getByRole('dialog', { name: 'Agent Update Center' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Box 1')).toBeInTheDocument();
    expect(within(row('10.0.0.2')).getByText('v0.3.0')).toBeInTheDocument();
    expect(within(row('Box 1')).getByText('v0.3.5')).toBeInTheDocument();
    expect(screen.queryByText('Box 3')).not.toBeInTheDocument();
    expect(screen.getByText('2 updates available')).toBeInTheDocument();
    expect(screen.getByLabelText('SSH User')).toHaveValue('root');
    expect(within(row('Box 1')).getByRole('status')).toHaveTextContent('Ready');
  });

  it('says so when all agents are up to date', () => {
    renderCenter([devices[2]]);
    expect(screen.getByText('All agents are up to date!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Update all remaining' })).toBeDisabled();
  });

  it('refuses to update without credentials', async () => {
    const { user } = renderCenter();
    expect(screen.getByRole('button', { name: 'Update all remaining' })).toBeDisabled();

    await user.click(within(row('Box 1')).getByRole('button', { name: 'Update' }));
    expect(within(row('Box 1')).getByRole('status')).toHaveTextContent('Error');
    expect(screen.getByText('Credentials missing')).toBeInTheDocument();
    expect(m.deployAgent).not.toHaveBeenCalled();
  });

  it('updates one device and locks its button afterwards', async () => {
    let resolve!: (v: unknown) => void;
    m.deployAgent.mockReturnValueOnce(new Promise((r) => { resolve = r; }) as never);
    const { user } = renderCenter();
    await user.clear(screen.getByLabelText('SSH User'));
    await user.type(screen.getByLabelText('SSH User'), 'admin');
    await typePassword(user);

    const button = within(row('Box 1')).getByRole('button', { name: 'Update' });
    await user.click(button);
    expect(m.deployAgent).toHaveBeenCalledWith(1, { ssh_user: 'admin', ssh_password: 'secret', ssh_port: 22 });
    expect(within(row('Box 1')).getByRole('status')).toHaveTextContent('Installing...');
    expect(button).toBeDisabled();

    resolve({ status: 'success', message: 'ok' });
    await waitFor(() => expect(within(row('Box 1')).getByRole('status')).toHaveTextContent('Done'));
    expect(button).toBeDisabled();
  });

  it('shows the failure and offers a retry', async () => {
    m.deployAgent.mockResolvedValueOnce({ status: 'failed', message: 'Permission denied' } as never);
    m.deployAgent.mockRejectedValueOnce(new Error(''));
    const { user } = renderCenter();
    await typePassword(user);

    await user.click(within(row('Box 1')).getByRole('button', { name: 'Update' }));
    expect(await screen.findByText('Permission denied')).toBeInTheDocument();

    await user.click(within(row('Box 1')).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Connection error')).toBeInTheDocument();
    expect(m.deployAgent).toHaveBeenCalledTimes(2);
  });

  it('updates the remaining devices one after another', async () => {
    const { onComplete, user } = renderCenter();
    await typePassword(user);

    await user.click(within(row('Box 1')).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(within(row('Box 1')).getByRole('status')).toHaveTextContent('Done'));
    m.deployAgent.mockClear();

    await user.click(screen.getByRole('button', { name: 'Update all remaining' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(m.deployAgent).toHaveBeenCalledTimes(1);
    expect(m.deployAgent).toHaveBeenCalledWith(2, expect.anything());
    expect(within(row('10.0.0.2')).getByRole('status')).toHaveTextContent('Done');
  });

  it('runs the batch sequentially', async () => {
    const order: string[] = [];
    m.deployAgent.mockImplementation(async (id) => {
      order.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${id}`);
      return { status: 'success', message: '' } as never;
    });
    const { onComplete, user } = renderCenter();
    await typePassword(user);
    await user.click(screen.getByRole('button', { name: 'Update all remaining' }));
    await waitFor(() => expect(onComplete).toHaveBeenCalled());
    expect(order).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('shows the manual update command on demand', async () => {
    const { user } = renderCenter();
    const toggle = within(row('Box 1')).getByRole('button', { name: /Manually/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('manual')).not.toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('manual')).toHaveTextContent('manual 1');

    await user.click(toggle);
    expect(screen.queryByTestId('manual')).not.toBeInTheDocument();
  });

  it('closes from the header and the footer', async () => {
    const { onClose, user } = renderCenter();
    for (const button of screen.getAllByRole('button', { name: 'Close' })) await user.click(button);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
