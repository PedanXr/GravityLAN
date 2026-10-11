import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sidebar } from '../Sidebar';
import { MobileHeader } from '../MobileHeader';
import { LanguageToggle } from '../LanguageToggle';
import { PasswordForm } from './PasswordForm';
import { SettingsSection } from './sections/SettingsParts';
import { useSettingsForm } from './sections/useSettingsForm';
import { SaveBar, ScanSection, SystemSection } from './sections/FormSections';
import { GroupsSection } from './sections/GroupsSection';
import { TokensSection } from './sections/TokensSection';
import { BackupSection, DangerSection } from './sections/DataSections';

export function SettingsView() {
  const { t } = useTranslation();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const settings = useSettingsForm();

  return (
    <div className="app-layout">
      <Sidebar active="settings" isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      <main className="app-main">
        <MobileHeader title={t('sidebar.settings')} onMenuClick={() => setIsSidebarOpen(true)} />
        <div className="settings-page">
          <header className="page-header visually-hidden-mobile">
            <h1 className="page-header__title">{t('sidebar.settings')}</h1>
            <p className="page-header__subtitle">{t('settings.page_subtitle')}</p>
          </header>

          <ScanSection form={settings.form} setField={settings.setField} />
          <SystemSection form={settings.form} setField={settings.setField} />
          <GroupsSection />

          <SettingsSection id="language" title={t('settings.language')} description={t('settings.section_language_desc')}>
            <LanguageToggle />
          </SettingsSection>

          <SettingsSection id="access" title={t('settings.password.section')} description={t('settings.password.section_desc')}>
            <PasswordForm />
          </SettingsSection>

          <TokensSection />
          <BackupSection />
          <DangerSection />

          <SaveBar
            isDirty={settings.isDirty}
            status={settings.saveStatus}
            onSave={settings.save}
            onDiscard={settings.discard}
          />
        </div>
      </main>
    </div>
  );
}
