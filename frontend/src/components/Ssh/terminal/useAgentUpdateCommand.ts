import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../../../context/ToastContext';
import { buildInstallCommand, requestInstallCode } from '../../Agents/ManualInstallCommand';
import type { XtermHandles } from './useXterm';

/** An agent update for the device a terminal is connected to. */
export interface AgentUpdate {
  deviceId: number;
  installed: string;
  latest: string;
}

/**
 * The agent update command for this shell: the one-line installer from the Agent tab,
 * with a fresh single-use install code per click. It is only typed into the input line,
 * never sent with Enter: the user reviews it and runs it (sudo may ask for a password).
 * The leading space keeps it out of the shell history where HISTCONTROL ignores such
 * lines (default user ~/.bashrc on Debian/Ubuntu); the code is used up by the first run anyway.
 */
export function useAgentUpdateCommand({ termRef }: XtermHandles, update: AgentUpdate | null) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const insert = async () => {
    if (!update || busy) return;
    setBusy(true);
    try {
      const { code, expiresAt } = await requestInstallCode(update.deviceId);
      const command = ` ${buildInstallCommand(update.deviceId, code)}`;
      // A line break would run the command right away
      if (/[\r\n]/.test(command)) throw new Error('Line break in the update command');
      const term = termRef.current;
      if (!term) return;
      term.paste(command);
      term.focus();
      showToast('success', t('ssh.terminal.agent_update_inserted'), t('ssh.terminal.agent_update_inserted_text', {
        time: expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }));
    } catch (err) {
      console.error('Failed to prepare the agent update command:', err);
      showToast('error', t('ssh.terminal.agent_update'), t('agent.install_code_failed'));
    } finally {
      setBusy(false);
    }
  };

  return { busy, insert };
}
