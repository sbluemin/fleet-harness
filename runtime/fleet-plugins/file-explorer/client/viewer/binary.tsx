interface BinaryViewerProps {
  readonly name: string;
  readonly sizeHint?: string;
}

export function BinaryViewer({ name, sizeHint }: BinaryViewerProps) {
  return (
    <div className="fexp-bin-wrap v-bin">
      <span className="fexp-bin-glyph" aria-hidden="true">⊘</span>
      <p className="fexp-bin-name">{name}</p>
      {sizeHint && <p className="fexp-bin-meta">{sizeHint}</p>}
      <p className="fexp-bin-hint">Binary files can't be previewed</p>
    </div>
  );
}
