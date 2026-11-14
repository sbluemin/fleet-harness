import { useEffect, useId, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDesktopShellHome } from "../../../core/client/src/integration/desktop-shell.js";
import { useConsoleLocale } from "../../../core/client/src/i18n/index.js";
import { SettingsGroup, SettingsItem, SettingsToggle } from "../../settings/client/preferences-context.js";
import { getT } from "./i18n.js";
import {
  PasswordVaultError,
  copySavedPassword,
  deleteSavedPassword,
  loadPasswordVault,
  passwordOriginDraft,
  passwordSiteLabel,
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
 * 목록은 사이트 한 줄이고, 아이디와 원문은 상세 창에서만 보인다.
 * 원문은 상세 창이 닫히거나 섹션이 언마운트되면 상태에서 지운다.
 */
export function PasswordManagerCard() {
  const t = getT(useConsoleLocale());
  const home = useDesktopShellHome();
  const [vault, setVault] = useState<PasswordVaultView | null>(null);
  const [query, setQuery] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [detailOrigin, setDetailOrigin] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const forget = () => { setRevealed(new Map()); setCopiedId(null); };
  const closeDetail = () => { setDetailOrigin(null); forget(); setActionError(null); };
  const run = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setActionError(null);
    try { await action(); return true; }
    catch (error) { setActionError(messageFor(t, error)); return false; }
    finally { setBusy(false); }
  };
  const reload = async () => setVault(await loadPasswordVault());
  const sites = vault ? sitesForQuery(vault.entries, query) : [];
  const accounts = detailOrigin ? (vault?.entries.filter((entry) => entry.origin === detailOrigin) ?? []) : [];
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
        <div className="settings-password-toolbar">
          <label className="settings-password-search">
            <span className="settings-password-hidden">{t("terminal.browser.passwords.search")}</span>
            <input type="search" value={query} autoComplete="off" placeholder={t("terminal.browser.passwords.search")} aria-label={t("terminal.browser.passwords.search")} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <button type="button" className="settings-password-add" disabled={busy || vault?.available === false} onClick={() => { closeDetail(); setAdding(true); }}>{t("terminal.browser.passwords.add")}</button>
        </div>
        {vault && sites.length === 0 ? <p className="settings-password-empty">{query.trim() ? t("terminal.browser.passwords.noMatches") : t("terminal.browser.passwords.empty")}</p> : null}
        <ul className="settings-password-list">
          {sites.map((site) => {
            const label = passwordSiteLabel(site.origin);
            const count = site.accounts.length;
            return (
              <li key={site.origin}>
                <button type="button" className="settings-password-site" aria-label={count > 1 ? `${label}, ${t("terminal.browser.passwords.accounts", { count })}` : label} onClick={() => { forget(); setActionError(null); setDetailOrigin(site.origin); }}>
                  <SiteIcon origin={site.origin} size={20} />
                  <span className="settings-password-host">{label}</span>
                  {count > 1 ? <span className="settings-password-count">{t("terminal.browser.passwords.accounts", { count })}</span> : null}
                  <span className="settings-password-chevron" aria-hidden="true">▸</span>
                </button>
              </li>
            );
          })}
        </ul>
      </SettingsGroup>
      {vault && vault.neverSaveOrigins.length > 0 ? (
        <SettingsGroup title={t("terminal.browser.passwords.neverTitle")} ariaLabel={t("terminal.browser.passwords.neverTitle")}>
          <ul className="settings-password-list">
            {vault.neverSaveOrigins.map((origin) => (
              <li key={origin} className="settings-password-never">
                <span>{passwordSiteLabel(origin)}</span>
                <button type="button" className="settings-device-fonts-button" disabled={busy} aria-label={`${t("terminal.browser.passwords.remove")} ${origin}`} onClick={() => { void run(async () => { const neverSaveOrigins = await removeNeverSaveOrigin(origin); setVault((current) => current ? { ...current, neverSaveOrigins } : current); }); }}>{t("terminal.browser.passwords.remove")}</button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      ) : null}
      {detailOrigin && accounts.length > 0 ? (
        <PasswordDialog title={passwordSiteLabel(detailOrigin)} onClose={closeDetail}>
          <header className="settings-password-dialog-head">
            <SiteIcon origin={detailOrigin} size={36} />
            <div>
              <h2>{passwordSiteLabel(detailOrigin)}</h2>
              <p>{detailOrigin}</p>
            </div>
          </header>
          <div className="settings-password-dialog-body">
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                secret={revealed.get(account.id) ?? null}
                copied={copiedId === account.id}
                busy={busy}
                solo={accounts.length === 1}
                onShow={() => { void run(async () => { const password = await revealSavedPassword(account.id); setRevealed((current) => new Map(current).set(account.id, password)); }); }}
                onHide={() => setRevealed((current) => { const next = new Map(current); next.delete(account.id); return next; })}
                onCopy={() => { void run(async () => { await copySavedPassword(account.id); setCopiedId(account.id); }); }}
                onSave={(username, password) => run(async () => { await updateSavedPassword({ id: account.id, username, ...(password ? { password } : {}) }); setRevealed((current) => { const next = new Map(current); next.delete(account.id); return next; }); await reload(); })}
                onDelete={() => { void run(async () => {
                  await deleteSavedPassword(account.id);
                  const next = await loadPasswordVault();
                  setVault(next);
                  setRevealed((current) => { const cleared = new Map(current); cleared.delete(account.id); return cleared; });
                  if (!next.entries.some((entry) => entry.origin === detailOrigin)) closeDetail();
                }); }}
              />
            ))}
          </div>
          <footer className="settings-password-dialog-foot">
            <span />
            <button type="button" className="settings-password-add" onClick={closeDetail}>{t("terminal.browser.passwords.done")}</button>
          </footer>
        </PasswordDialog>
      ) : null}
      {adding ? (
        <PasswordDialog title={t("terminal.browser.passwords.addTitle")} onClose={() => setAdding(false)}>
          <h2>{t("terminal.browser.passwords.addTitle")}</h2>
          {actionError ? <p role="alert">{actionError}</p> : null}
          <AddForm busy={busy} onCancel={() => setAdding(false)} onSubmit={(origin, username, password) => { void run(async () => { await saveSavedPassword({ origin, username, password }); setAdding(false); await reload(); }); }} />
        </PasswordDialog>
      ) : null}
    </>
  );
}

function AccountCard({ account, secret, copied, busy, solo, onShow, onHide, onCopy, onSave, onDelete }: {
  readonly account: SavedPassword;
  readonly secret: string | null;
  readonly copied: boolean;
  readonly busy: boolean;
  readonly solo: boolean;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onCopy: () => void;
  readonly onSave: (username: string, password: string) => Promise<boolean>;
  readonly onDelete: () => void;
}) {
  const t = getT(useConsoleLocale());
  const [editing, setEditing] = useState(false);
  return (
    <section className="settings-password-account" aria-label={account.username || account.origin}>
      {editing ? (
        <EditForm username={account.username} busy={busy} onCancel={() => setEditing(false)} onSubmit={(username, password) => { void onSave(username, password).then((saved) => { if (saved) setEditing(false); }); }} />
      ) : (
        <>
          <Field label={t("terminal.browser.passwords.username")} value={account.username} />
          <Field label={t("terminal.browser.passwords.password")} value={secret ?? MASK} secret={secret !== null}>
            <button type="button" className="settings-password-icon-button" aria-label={`${secret === null ? t("terminal.browser.passwords.show") : t("terminal.browser.passwords.hide")} ${account.username} ${account.origin}`} onClick={secret === null ? onShow : onHide} disabled={busy}>{secret === null ? <EyeIcon /> : <EyeOffIcon />}</button>
            <button type="button" className="settings-password-icon-button" aria-label={`${t("terminal.browser.passwords.copy")} ${account.username} ${account.origin}`} onClick={onCopy} disabled={busy}>{copied ? t("terminal.browser.passwords.copied") : <CopyIcon />}</button>
          </Field>
        </>
      )}
      <div className="settings-password-dialog-foot">
        <div className="settings-password-actions">
          {editing ? null : <button type="button" className="settings-device-fonts-button" disabled={busy} onClick={() => setEditing(true)}>{t("terminal.browser.passwords.edit")}</button>}
          <button type="button" className="settings-password-delete" disabled={busy} aria-label={`${t("terminal.browser.passwords.delete")} ${account.username} ${account.origin}`} onClick={onDelete}>{t("terminal.browser.passwords.delete")}</button>
        </div>
        {solo ? null : <span />}
      </div>
    </section>
  );
}

function Field({ label, value, secret = false, children }: { readonly label: string; readonly value: string; readonly secret?: boolean; readonly children?: ReactNode }) {
  return (
    <label className="settings-password-field-label">
      {label}
      <span className={`settings-password-field${secret ? " is-secret" : ""}`}>
        <span className="settings-password-value">{value}</span>
        {children}
      </span>
    </label>
  );
}

function EditForm({ username, busy, onCancel, onSubmit }: {
  readonly username: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (username: string, password: string) => void;
}) {
  const t = getT(useConsoleLocale());
  const [name, setName] = useState(username);
  const [password, setPassword] = useState("");
  const [visible, setVisible] = useState(false);
  return (
    <form className="settings-password-form" onSubmit={(event) => {
      event.preventDefault();
      const secret = password;
      setPassword("");
      void onSubmit(name, secret);
    }}>
      <label>{t("terminal.browser.passwords.username")}<input value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("terminal.browser.passwords.newPassword")}
        <span className="settings-password-field">
          <input type={visible ? "text" : "password"} value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
          <button type="button" className="settings-password-icon-button" aria-label={visible ? t("terminal.browser.passwords.hide") : t("terminal.browser.passwords.show")} onClick={() => setVisible((current) => !current)}>{visible ? <EyeOffIcon /> : <EyeIcon />}</button>
        </span>
      </label>
      <div className="settings-password-actions">
        <button type="submit" className="settings-password-add" disabled={busy}>{t("terminal.browser.passwords.save")}</button>
        <button type="button" className="settings-device-fonts-button" disabled={busy} onClick={() => { setPassword(""); onCancel(); }}>{t("terminal.browser.passwords.cancel")}</button>
      </div>
    </form>
  );
}

function AddForm({ busy, onCancel, onSubmit }: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (origin: string, username: string, password: string) => void;
}) {
  const t = getT(useConsoleLocale());
  const [origin, setOrigin] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [invalid, setInvalid] = useState(false);
  return (
    <form className="settings-password-form" onSubmit={(event) => {
      event.preventDefault();
      const nextOrigin = passwordOriginDraft(origin);
      if (!nextOrigin || password.length === 0) { setInvalid(true); setPassword(""); return; }
      const secret = password;
      setPassword("");
      onSubmit(nextOrigin, name, secret);
    }}>
      {invalid ? <p role="alert">{t("terminal.browser.passwords.invalid")}</p> : null}
      <label>{t("terminal.browser.passwords.site")}<input value={origin} autoComplete="off" onChange={(event) => setOrigin(event.target.value)} /></label>
      <label>{t("terminal.browser.passwords.username")}<input value={name} autoComplete="off" onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("terminal.browser.passwords.password")}<input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} /></label>
      <div className="settings-password-dialog-foot">
        <button type="button" className="settings-device-fonts-button" disabled={busy} onClick={() => { setPassword(""); onCancel(); }}>{t("terminal.browser.passwords.cancel")}</button>
        <button type="submit" className="settings-password-add" disabled={busy}>{t("terminal.browser.passwords.save")}</button>
      </div>
    </form>
  );
}

function PasswordDialog({ title, onClose, children }: { readonly title: string; readonly onClose: () => void; readonly children: ReactNode }) {
  const titleId = useId();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return createPortal(
    <div className="settings-password-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="settings-password-dialog">
        <h2 id={titleId} className="settings-password-hidden">{title}</h2>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function SiteIcon({ origin, size }: { readonly origin: string; readonly size: number }) {
  const [phase, setPhase] = useState<"pending" | "ok" | "bad">("pending");
  const label = passwordSiteLabel(origin).replace(/^www\./, "");
  const initial = label.charAt(0).toUpperCase() || "•";
  return (
    <span className="settings-password-icon" style={{ width: size, height: size }}>
      {phase === "ok" ? null : <span className="settings-password-badge" aria-hidden="true">{initial}</span>}
      {phase === "bad" ? null : (
        <img
          src={`/api/v1/browser/passwords/favicon?origin=${encodeURIComponent(origin)}`}
          alt=""
          width={size}
          height={size}
          hidden={phase !== "ok"}
          onLoad={() => setPhase("ok")}
          onError={() => setPhase("bad")}
        />
      )}
    </span>
  );
}

function sitesForQuery(entries: readonly SavedPassword[], query: string): { origin: string; accounts: SavedPassword[] }[] {
  const groups = new Map<string, SavedPassword[]>();
  for (const entry of entries) {
    const accounts = groups.get(entry.origin) ?? [];
    accounts.push(entry);
    groups.set(entry.origin, accounts);
  }
  const needle = query.trim().toLowerCase();
  return [...groups.entries()].flatMap(([origin, accounts]) => {
    if (!needle) return [{ origin, accounts }];
    const host = passwordSiteLabel(origin).toLowerCase();
    if (origin.toLowerCase().includes(needle) || host.includes(needle) || accounts.some((account) => account.username.toLowerCase().includes(needle))) return [{ origin, accounts }];
    return [];
  });
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

function EyeIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M1.5 8S4 4.2 8 4.2 14.5 8 14.5 8 12 11.8 8 11.8 1.5 8 1.5 8Z" fill="none" stroke="currentColor" strokeWidth="1.3" /><circle cx="8" cy="8" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}
function EyeOffIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2 2.5 14 13.5M3.2 5.6C2 6.6 1.5 8 1.5 8S4 11.8 8 11.8c.8 0 1.5-.2 2.1-.4M6.2 4.5A8 8 0 0 1 8 4.2C12 4.2 14.5 8 14.5 8a12 12 0 0 1-1.6 2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>;
}
function CopyIcon() {
  return <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M10.5 5V3.6A1.6 1.6 0 0 0 8.9 2H3.6A1.6 1.6 0 0 0 2 3.6v5.3A1.6 1.6 0 0 0 3.6 10.5H5" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
}
