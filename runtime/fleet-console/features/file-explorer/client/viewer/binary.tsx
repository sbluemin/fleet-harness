import type { Translate } from "@fleet-console/sdk/i18n";

import type { FileExplorerMessageKey } from "../i18n/index.js";

interface BinaryViewerProps {
  readonly name: string;
  readonly sizeHint?: string;
  readonly t: Translate<FileExplorerMessageKey>;
}

export function BinaryViewer({ name, sizeHint, t }: BinaryViewerProps) {
  return (
    <div className="fexp-bin-wrap v-bin">
      <span className="fexp-bin-glyph" aria-hidden="true">⊘</span>
      <p className="fexp-bin-name">{name}</p>
      {sizeHint && <p className="fexp-bin-meta">{sizeHint}</p>}
      <p className="fexp-bin-hint">{t("fileExplorer.viewer.binaryHint")}</p>
    </div>
  );
}
