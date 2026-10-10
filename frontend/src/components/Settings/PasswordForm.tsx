import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, KeyRound, Loader2 } from 'lucide-react';
import { api } from '../../api/client';

const MIN_LENGTH = 8;

/** Change the admin login password; the server logs out every other session. */
export function PasswordForm() {
  const { t } = useTranslation();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  const tooShort = next.length > 0 && next.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && next !== repeat;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (next.length < MIN_LENGTH) { setError(t('settings.password.too_short', { count: MIN_LENGTH })); return; }
    if (next !== repeat) { setError(t('settings.password.mismatch')); return; }
    setBusy(true);
    try {
      const res = await api.changePassword(current, next);
      setDone(res.other_sessions_ended);
      setCurrent('');
      setNext('');
      setRepeat('');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The server answers in English; show the known cases in the UI language
      if (/current password is wrong/i.test(message)) setError(t('settings.password.wrong_current'));
      else if (/differs from the current/i.test(message)) setError(t('settings.password.same_as_current'));
      else setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-password" onSubmit={submit} autoComplete="on">
      {/* Lets password managers attach the new password to the right account */}
      <input type="text" name="username" autoComplete="username" value="admin" readOnly hidden />
      <div className="settings-grid">
        <div className="settings-field">
          <label className="form-label" htmlFor="set-pw-current">{t('settings.password.current')}</label>
          <input id="set-pw-current" className="input" type="password" autoComplete="current-password"
            value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </div>
        <div className="settings-field">
          <label className="form-label" htmlFor="set-pw-new">{t('settings.password.new')}</label>
          <input id="set-pw-new" className="input" type="password" autoComplete="new-password" minLength={MIN_LENGTH}
            value={next} onChange={(e) => setNext(e.target.value)} required aria-invalid={tooShort || undefined}
            aria-describedby="set-pw-new-hint" />
          <p className="field-hint" id="set-pw-new-hint">{t('settings.password.hint', { count: MIN_LENGTH })}</p>
        </div>
        <div className="settings-field">
          <label className="form-label" htmlFor="set-pw-repeat">{t('settings.password.repeat')}</label>
          <input id="set-pw-repeat" className="input" type="password" autoComplete="new-password"
            value={repeat} onChange={(e) => setRepeat(e.target.value)} required aria-invalid={mismatch || undefined} />
          {mismatch && <p className="field-error">{t('settings.password.mismatch')}</p>}
        </div>
      </div>

      {error && <p className="field-error" role="alert">{error}</p>}
      {done !== null && (
        <div className="callout callout--success" role="status">
          <Check size={16} className="callout__icon" aria-hidden="true" />
          <div className="callout__body">
            <p>{t('settings.password.changed')}</p>
            {done > 0 && <p className="field-hint">{t('settings.password.others_logged_out', { count: done })}</p>}
          </div>
        </div>
      )}

      <div>
        <button type="submit" className="btn btn-secondary" disabled={busy || !current || !next || !repeat}>
          {busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <KeyRound size={16} aria-hidden="true" />}
          {t('settings.password.submit')}
        </button>
      </div>
    </form>
  );
}
