import { useEffect, useState } from "react";
import { useDesktopShellHome } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { SettingsGroup, SettingsItem, SettingsToggle } from "../../settings/client/preferences-context.js";
import { getT } from "./i18n.js";
import {
  PasswordVaultError,
  copySavedPassword,
  deleteSavedPassword,
  filterSavedPasswords,
  loadPasswordVault,
  passwordOriginDraft,
  removeNeverSaveOrigin,
  revealSavedPassword,
  savePasswordOffer,
  saveSavedPassword,
  updateSavedPassword,
  type PasswordVaultView,
  type SavedPassword,
} from "./password-vault.js";

const MASK = "••••••••";

/**
 * 설정 > 브라우저의 비밀번호 관리.
 * 원문은 보기 성공 뒤에 그 행의 상태에만 있고, 섹션을 떠나거나 모달이 닫히면 컴포넌트와 함께 사라진다.
 */
export function PasswordManagerCard() {
  const t = getT(useConsoleLocale());
  const home = useDesktopShellHome();
  const [vault, setVault] = useState<PasswordVaultView | null>(null);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void loadPasswordVault().then((next) => {
        if (!current) return;
        setVault(next);
        setLoadError(null);
      }).catch((error: unknown) => {
        if (!current || home.pending) return;
        setLoadError(messageFor(t, error));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
      setRevealed(new Map());
    };
  }, [home.origin, home.pending, t]);

  const forget = (id: string) => {
    setRevealed((current) => {
      if (!current.has(id)) return current;
      const next = new Map(current);
      next.delete(id);
      return next;
    });
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(null);
    try { await action(); }
    catch (error) { setActionError(messageFor(t, error)); }
    finally { setBusy(false); }
  };

  const reload = async () => { setVault(await loadPasswordVault()); };
  const visible = vault ? filterSavedPasswords(vault.entries, query) : [];
  const alert = actionError ?? (home.pending ? null : loadError);

  return (
    <>
      <SettingsGroup title={t("terminal.browser.passwords.offer")} ariaLabel={t("terminal.browser.passwords.offer")}>
        <SettingsItem label={t("terminal.browser.passwords.offer")} hint={t("terminal.browser.passwords.offerHint")}>
          <SettingsToggle
            checked={vault?.offerToSave === true}
            disabled={vault === null || busy}
            ariaLabel={t("terminal.browser.passwords.offer")}
            onChange={(enabled) => { void run(async () => { const offerToSave = await savePasswordOffer(enabled); setVault((current) => current ? { ...current, offerToSave } : current); }); }}
          />
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title={t("terminal.browser.passwords.title")} ariaLabel={t("terminal.browser.passwords.title")}>
        {alert ? <p role="alert">{alert}</p> : null}
        {vault && !vault.available ? <p role="status">{messageFor(t, new PasswordVaultError(vault.reason ?? "encryption_unavailable"))}</p> : null}
        <label className="settings-password-search">
          <span className="settings-password-hidden">{t("terminal.browser.passwords.search")}</span>
          <input type="search" value={query} autoComplete="off" placeholder={t("terminal.browser.passwords.search")} aria-label={t("terminal.browser.passwords.search")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        {vault && visible.length === 0 ? <p>{query.trim() ? t("terminal.browser.passwords.noMatches") : t("terminal.browser.passwords.empty")}</p> : null}
        <ul className="settings-password-list">
          {visible.map((entry) => (
            <PasswordRow
              key={entry.id}
              entry={entry}
              secret={revealed.get(entry.id) ?? null}
              copied={copiedId === entry.id}
              editing={editing === entry.id}
              busy={busy}
              onShow={() => { void run(async () => { const password = await revealSavedPassword(entry.id); setRevealed((current) => new Map(current).set(entry.id, password)); }); }}
              onHide={() => forget(entry.id)}
              onCopy={() => { void run(async () => { await copySavedPassword(entry.id); setCopiedId(entry.id); }); }}
              onEdit={() => { forget(entry.id); setEditing(entry.id); setAdding(false); }}
              onCancel={() => setEditing(null)}
              onDelete={() => { void run(async () => { forget(entry.id); await deleteSavedPassword(entry.id); setEditing(null); await reload(); }); }}
              onUpdate={(username, password) => { void run(async () => { await updateSavedPassword({ id: entry.id, username, ...(password ? { password } : {}) }); setEditing(null); await reload(); }); }}
            />
          ))}
        </ul>
        {adding ? (
          <PasswordDraft
            title={t("terminal.browser.passwords.add")}
            username=""
            requirePassword
            busy={busy}
            onCancel={() => setAdding(false)}
            onSubmit={(origin, username, password) => { void run(async () => { await saveSavedPassword({ origin, username, password }); setAdding(false); await reload(); }); }}
          />
        ) : (
          <div className="settings-password-actions">
            <button type="button" className="settings-device-fonts-button" disabled={busy || vault?.available === false} onClick={() => { setAdding(true); setEditing(null); }}>{t("terminal.browser.passwords.add")}</button>
          </div>
        )}
      </SettingsGroup>
      {vault && vault.neverSaveOrigins.length > 0 ? (
        <SettingsGroup title={t("terminal.browser.passwords.neverTitle")} ariaLabel={t("terminal.browser.passwords.neverTitle")}>
          <ul className="settings-password-list">
            {vault.neverSaveOrigins.map((origin) => (
              <li key={origin} className="settings-password-row">
                <span className="settings-password-origin">{origin}</span>
                <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.remove")} ${origin}`} onClick={() => { void run(async () => { const neverSaveOrigins = await removeNeverSaveOrigin(origin); setVault((current) => current ? { ...current, neverSaveOrigins } : current); }); }}>{t("terminal.browser.passwords.remove")}</button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
    </>
  );
}

function PasswordRow({ entry, secret, copied, editing, busy, onShow, onHide, onCopy, onEdit, onCancel, onDelete, onUpdate }: {
  readonly entry: SavedPassword;
  readonly secret: string | null;
  readonly copied: boolean;
  readonly editing: boolean;
  readonly busy: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onCopy: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
  readonly onUpdate: (username: string, password: string) => void;
}) {
  const t = getT(useConsoleLocale());
  return (
    <li className="settings-password-row">
      <div className="settings-password-meta">
        <div className="settings-password-origin">{entry.origin}</div>
        <div className="settings-password-user">{entry.username}</div>
        <div className="settings-password-secret">{secret ?? MASK}</div>
        {secret === null ? <span className="settings-password-hidden">{t("terminal.browser.passwords.masked")}</span> : null}
      </div>
      <div className="settings-password-actions">
        {secret === null
          ? <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.show")} ${entry.origin}`} onClick={onShow}>{t("terminal.browser.passwords.show")}</button>
          : <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.hide")} ${entry.origin}`} onClick={onHide}>{t("terminal.browser.passwords.hide")}</button>}
        <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.copy")} ${entry.origin}`} onClick={onCopy}>{copied ? t("terminal.browser.passwords.copied") : t("terminal.browser.passwords.copy")}</button>
        <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.edit")} ${entry.origin}`} onClick={onEdit}>{t("terminal.browser.passwords.edit")}</button>
        <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.delete")} ${entry.origin}`} onClick={onDelete}>{t("terminal.browser.passwords.delete")}</button>
      </div>
      {editing ? <PasswordDraft title={t("terminal.browser.passwords.edit")} username={entry.username} fixedOrigin={entry.origin} requirePassword={false} busy={busy} onCancel={onCancel} onSubmit={(_origin, username, password) => onUpdate(username, password)} /> : null}
    </li>
  );
}

function PasswordDraft({ title, username, fixedOrigin, requirePassword, busy, onCancel, onSubmit }: {
  readonly title: string;
  readonly username: string;
  readonly fixedOrigin?: string;
  readonly requirePassword: boolean;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (origin: string, username: string, password: string) => void;
}) {
  const t = getT(useConsoleLocale());
  const [origin, setOrigin] = useState(fixedOrigin ?? "");
  const [name, setName] = useState(username);
  const [password, setPassword] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form className="settings-password-form" onSubmit={(event) => {
      event.preventDefault();
      const nextOrigin = passwordOriginDraft(origin);
      if (!nextOrigin || (requirePassword && password.length === 0)) { setInvalid(true); setPassword(""); return; }
      const secret = password;
      setPassword("");
      onSubmit(nextOrigin, name, secret);
    }}>
      <p>{title}</p>
      {invalid ? <p role="alert">{t("terminal.browser.passwords.invalid")}</p> : null}
      {fixedOrigin ? null : <label>{t("terminal.browser.passwords.site")}<input value={origin} autoComplete="off" onChange={(event) => setOrigin(event.target.value)} /></label>}
      <label>{t("terminal.browser.passwords.username")}<input value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
      <label>{requirePassword ? t("terminal.browser.passwords.password") : t("terminal.browser.passwords.newPassword")}<input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="settings-password-actions">
        <button type="submit" className="settings-device-fonts-button" disabled={busy}>{t("terminal.browser.passwords.save")}</button>
        <button type="button" className="settings-device-fonts-button" disabled={busy} onClick={() => { setPassword(""); onCancel(); }}>{t("terminal.browser.passwords.cancel")}</button>
      </div>
    </form>
  );
}

function messageFor(t: ReturnType<typeof getT>, error: unknown): string {
  const code = error instanceof PasswordVaultError ? error.code : "browser_request_failed";
  switch (code) {
    case "os_auth_cancelled": return t("terminal.browser.passwords.authCancelled");
    case "os_auth_failed": return t("terminal.browser.passwords.authFailed");
    case "os_auth_unavailable": return t("terminal.browser.passwords.authUnavailable");
    case "encryption_unavailable": return t("terminal.browser.passwords.encryptionUnavailable");
    case "desktop_required": return t("terminal.browser.passwords.desktopRequired");
    case "vault_corrupted": return t("terminal.browser.passwords.corrupted");
    case "password_not_found": return t("terminal.browser.passwords.missing");
    case "invalid_password_entry": return t("terminal.browser.passwords.invalid");
    case "vault_limit_reached": return t("terminal.browser.passwords.full");
    default: return t("terminal.browser.passwords.failed");
  }
}
