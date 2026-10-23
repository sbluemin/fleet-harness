import { useEffect } from "react";
import type { ConsoleLocale } from "@fleet-console/sdk/i18n";
import { getT } from "./i18n/index.js";
import { dismissFileNavigationError, useFileExplorerViewState } from "./view-store.js";

export function FileExplorerNavigationFeedback({ language }: { readonly language?: ConsoleLocale }) {
  const { navigationError } = useFileExplorerViewState(null);
  const t = getT(language);
  useEffect(() => {
    if (!navigationError) return;
    const timer = setTimeout(() => dismissFileNavigationError(navigationError.id), 5000);
    return () => clearTimeout(timer);
  }, [navigationError]);
  if (!navigationError) return null;
  return <div className="fexp-navigation-toast" role="alert">{t(`fileExplorer.navigation.${navigationError.reason}`)}</div>;
}
